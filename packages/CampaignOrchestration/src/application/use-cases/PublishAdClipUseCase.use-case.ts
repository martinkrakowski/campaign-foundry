import {
  assertObjectKey,
  type ObjectKey,
  type ObjectStorePort,
} from "../ports/out/ObjectStorePort.js";
import {
  PUBLIC_AD_MEDIA_ORG_ID_PATTERN,
  type PublicAdMediaPort,
} from "../ports/out/PublicAdMediaPort.js";
import type { PublishedClipRecordPort } from "../ports/out/PublishedClipRecordPort.js";
import { validateAdClip } from "../../domain/value-objects/mp4-clip.js";

/**
 * The campaign id is a UUID, the same shape `apps/api` object keys assume.
 * Kept unexported so `use-cases/index.ts` cannot emit a duplicate of the
 * port barrel's symbols.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No public ad-media bucket is configured for this deployment. */
export class PublicMediaNotConfiguredError extends Error {
  constructor() {
    super("Public ad media is not configured for this deployment.");
    this.name = "PublicMediaNotConfiguredError";
  }
}

/** The render key is malformed, or outside the campaign's `renders/` prefix. */
export class InvalidRenderKeyError extends Error {
  constructor() {
    super("Refusing a render key outside the org and campaign render prefix.");
    this.name = "InvalidRenderKeyError";
  }
}

/** The private store holds no object at the requested render key. */
export class RenderClipNotFoundError extends Error {
  constructor() {
    super("No render clip exists at the requested key.");
    this.name = "RenderClipNotFoundError";
  }
}

/**
 * The published-record ledger disagreed with the public store after a race:
 * a record said `"exists"` but no winner could be resolved for the content
 * hash, so the newly created object was removed and the publish refused.
 */
export class PublishedClipRecordConflictError extends Error {
  constructor() {
    super("The published clip record is in an inconsistent state for this content hash.");
    this.name = "PublishedClipRecordConflictError";
  }
}

/**
 * Hash seam — node:crypto at the composition root, the same split as
 * `PreviewCreativeFrameUseCase`'s injected `hash` (application stays off node
 * builtins).
 */
export type ClipContentHash = (bytes: Uint8Array) => string;

/** Ports injected at the composition root — contracts, never adapters. */
export interface PublishAdClipDeps {
  /** The PRIVATE store renders live in; read-only here — publishing never writes it. */
  readonly objectStore: Pick<ObjectStorePort, "get">;
  /** The PUBLIC bucket. `undefined` → publishing is refused, not silently dropped. */
  readonly publicAdMedia: PublicAdMediaPort | undefined;
  /** The durable record of which clips the campaign has published. */
  readonly publishedClipRecord: PublishedClipRecordPort;
  /** Content hash of the clip bytes; injected so the use case stays deterministic. */
  readonly sha256: ClipContentHash;
}

/**
 * Publish one rendered ad clip to the public bucket and record the fact.
 *
 * The private store is NEVER written: the clip's bytes are read once,
 * validated as an H.264 MP4, and re-published under a content-addressed
 * public key. Publication is idempotent per `(orgId, campaignId, contentHash)`
 * — re-publishing the same bytes returns the existing record without a second
 * `publish`, and a race loser removes the object it just created so no orphan
 * is left behind.
 */
export class PublishAdClipUseCase {
  constructor(private readonly deps: PublishAdClipDeps) {}

  async execute(input: {
    readonly orgId: string;
    readonly campaignId: string;
    readonly renderKey: string;
  }): Promise<{ readonly key: ObjectKey; readonly url: string }> {
    const { orgId, campaignId, renderKey } = input;
    const publicAdMedia = this.deps.publicAdMedia;
    if (publicAdMedia === undefined) throw new PublicMediaNotConfiguredError();

    // Validate everything BEFORE touching the private store: a refusal leaves
    // no read, no write and no public object behind.
    const prefix = `org/${orgId}/campaign/${campaignId}/renders/`;
    if (
      !PUBLIC_AD_MEDIA_ORG_ID_PATTERN.test(orgId) ||
      !UUID_PATTERN.test(campaignId) ||
      !renderKey.startsWith(prefix) ||
      renderKey.length <= prefix.length
    ) {
      throw new InvalidRenderKeyError();
    }
    // The one conformance-suite rule for keys — traversal, empty segments,
    // absolute paths — is the port's own, not a copy; any refusal is the same
    // `InvalidRenderKeyError` a bad prefix gets.
    try {
      assertObjectKey(renderKey);
    } catch {
      throw new InvalidRenderKeyError();
    }

    const stored = await this.deps.objectStore.get(renderKey);
    if (stored === undefined) throw new RenderClipNotFoundError();

    // Let the validator's named error (`InvalidAdClipError`) propagate.
    validateAdClip(stored.bytes);

    const contentHash = this.deps.sha256(stored.bytes);

    // Idempotency: the same bytes already published → return the record as-is.
    const existing = await this.deps.publishedClipRecord.find(orgId, campaignId, contentHash);
    if (existing !== undefined) return existing;

    const published = await publicAdMedia.publish(orgId, stored.bytes, contentHash);
    // Only a `record` failure cleans up: remove the object this call created
    // so no orphan is left, suppressing any cleanup failure, then rethrow.
    let outcome: Awaited<ReturnType<typeof this.deps.publishedClipRecord.record>>;
    try {
      outcome = await this.deps.publishedClipRecord.record(
        orgId,
        campaignId,
        published.key,
        published.url,
        contentHash,
        // Evaluated under the ledger's per-key lock: a pause longer than the
        // reconcile grace may have cost this object its life.
        () => publicAdMedia.exists(published.key),
      );
    } catch (error) {
      try {
        await publicAdMedia.remove(published.key);
      } catch {
        // Suppressed — the original `record` error is what matters.
      }
      throw error;
    }
    if (outcome === "recorded") return { key: published.key, url: published.url };

    // A concurrent caller recorded the same content hash first. The winner
    // is whatever the ledger holds; this call's object is kept only when it
    // IS the winner. A failed winner lookup must not remove an object the
    // winner may share.
    const winner = await this.deps.publishedClipRecord.find(orgId, campaignId, contentHash);
    if (winner !== undefined && winner.key === published.key) return winner;
    await publicAdMedia.remove(published.key);
    if (winner !== undefined) return winner;
    throw new PublishedClipRecordConflictError();
  }
}
