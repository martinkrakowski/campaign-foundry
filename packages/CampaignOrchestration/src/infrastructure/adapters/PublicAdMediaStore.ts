import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  assertObjectKey,
  type ObjectKey,
  type ObjectStorePort,
  PUBLIC_AD_MEDIA_HASH_PATTERN,
  PUBLIC_AD_MEDIA_ORG_ID_PATTERN,
  PUBLIC_AD_MEDIA_RANDOM_PATTERN,
  InvalidPublicAdMediaInputError,
  type PublicAdMediaPort,
  type PublishedAdMedia,
} from "../../application/ports/out/index.js";

/** The shape of every key this store mints or accepts: `{org}/{random}/{hash}.mp4`. */
const KEY_PATTERN = /^[^/]+\/[0-9a-f]{32}\/[0-9a-f]{64}\.mp4$/;

export interface PublicAdMediaStoreOptions {
  /** The store the published bytes live in — the public-read bucket's client. */
  readonly store: ObjectStorePort;
  /** The origin published URLs are joined onto, e.g. `https://media.example`. */
  readonly baseUrl: string;
  /** The 16-byte random source; injected so a key collision is testable. */
  readonly randomBytes?: (size: number) => Uint8Array;
}

/**
 * The one `PublicAdMediaPort` implementation: published ad media on an
 * `ObjectStorePort` backed by the dedicated public-read bucket (PT-4k).
 *
 * Keys are `{orgId}/{128-bit-random}/{content-hash}.mp4` — org-prefixed,
 * unguessable, immutable. `put` runs with `ifNoneMatch: "*"`, so a collision
 * (the same 128 bits minted twice for the same hash) throws
 * `ObjectExistsError` and the original bytes stay exactly as they were.
 *
 * Every input is refused by name, never echoed: org ids, hashes and keys reach
 * this class from callers nothing here has vetted, and a message that quoted
 * one would land it in whatever logged the throw — the same reason
 * `assertObjectKey` names the rule and not the key.
 */
export class PublicAdMediaStore implements PublicAdMediaPort {
  private readonly store: ObjectStorePort;
  private readonly baseUrl: string;
  private readonly randomBytes: (size: number) => Uint8Array;

  constructor(options: PublicAdMediaStoreOptions) {
    this.store = options.store;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    const parsed = parsePlainBaseUrl(options.baseUrl);
    if (parsed === undefined) {
      throw new InvalidPublicAdMediaInputError(
        "Refusing a base URL: it must be a plain http(s) origin with no query, fragment or credentials.",
      );
    }
    this.baseUrl = parsed;
  }

  async publish(orgId: string, bytes: Uint8Array, contentHash: string): Promise<PublishedAdMedia> {
    this.assertOrgId(orgId);
    if (!PUBLIC_AD_MEDIA_HASH_PATTERN.test(contentHash)) {
      throw new InvalidPublicAdMediaInputError(
        "Refusing a content hash: it must be 64 lowercase hex characters.",
      );
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new InvalidPublicAdMediaInputError(
        "Refusing ad-media bytes: they must be a non-empty Uint8Array.",
      );
    }
    const randomHex = toHex(this.randomBytes(16));
    if (!PUBLIC_AD_MEDIA_RANDOM_PATTERN.test(randomHex)) {
      throw new InvalidPublicAdMediaInputError(
        "Refusing the random source: 16 bytes did not yield 32 lowercase hex characters.",
      );
    }
    const key = `${orgId}/${randomHex}/${contentHash}.mp4`;
    assertObjectKey(key);
    await this.store.put(key, bytes, { contentType: "video/mp4", ifNoneMatch: "*" });
    return { key, url: this.urlFor(key) };
  }

  async remove(key: ObjectKey): Promise<void> {
    this.assertPublishedKey(key);
    await this.store.delete(key);
  }

  async removeOrg(orgId: string): Promise<void> {
    this.assertOrgId(orgId);
    await this.store.deletePrefix(`${orgId}/`);
  }

  urlFor(key: ObjectKey): string {
    this.assertPublishedKey(key);
    return `${this.baseUrl}/${key}`;
  }

  /** The org id's own shape; the message names the parameter, never the value. */
  private assertOrgId(orgId: string): void {
    if (!PUBLIC_AD_MEDIA_ORG_ID_PATTERN.test(orgId)) {
      throw new InvalidPublicAdMediaInputError(
        "Refusing an org id: it must be 1-128 characters, starting with an alphanumeric, with only alphanumerics, underscores and hyphens after.",
      );
    }
  }

  /** A published key: confined by `assertObjectKey`, then its own three segments. */
  private assertPublishedKey(key: ObjectKey): void {
    assertObjectKey(key);
    if (!KEY_PATTERN.test(key)) {
      throw new InvalidPublicAdMediaInputError(
        "Refusing a published key: it must be {org}/{32-hex}/{64-hex}.mp4.",
      );
    }
  }
}

/** A plain http(s) origin, trailing slashes stripped, or undefined when it is not one. */
function parsePlainBaseUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.search !== "" || parsed.hash !== "") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/** 16 bytes as lowercase hex, so the minted segment is checkable at all. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
