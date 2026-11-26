import { assertObjectKey } from "../ports/out/ObjectStorePort.js";
import {
  PUBLIC_AD_MEDIA_ORG_ID_PATTERN,
  type PublicAdMediaPort,
} from "../ports/out/PublicAdMediaPort.js";
import type { PublishedClipRecordPort } from "../ports/out/PublishedClipRecordPort.js";
import { PublicMediaNotConfiguredError } from "./PublishAdClipUseCase.use-case.js";

/** The campaign id is a UUID; unexported so the barrel emits no duplicate. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No record of the key under this org and campaign — or the key is malformed. */
export class PublishedClipNotFoundError extends Error {
  constructor() {
    super("No published clip is recorded at the requested key for this org and campaign.");
    this.name = "PublishedClipNotFoundError";
  }
}

/** Ports injected at the composition root — contracts, never adapters. */
export interface UnpublishAdClipDeps {
  /** The PUBLIC bucket. `undefined` → unpublishing is refused, not silently dropped. */
  readonly publicAdMedia: PublicAdMediaPort | undefined;
  /** The durable record of which clips the campaign has published. */
  readonly publishedClipRecord: PublishedClipRecordPort;
}

/**
 * Unpublish one recorded ad clip: remove the public object, then the record.
 *
 * Missing, malformed and cross-tenant keys are deliberately indistinguishable
 * — every one of them is `PublishedClipNotFoundError`, so a caller learns
 * nothing about keys it does not own. The public object is removed FIRST: if
 * the removal fails the record stays and the call is retryable, whereas
 * removing the record first could leave a public object with no ledger row.
 */
export class UnpublishAdClipUseCase {
  constructor(private readonly deps: UnpublishAdClipDeps) {}

  async execute(input: {
    readonly orgId: string;
    readonly campaignId: string;
    readonly key: string;
  }): Promise<void> {
    const { orgId, campaignId, key } = input;
    const publicAdMedia = this.deps.publicAdMedia;
    if (publicAdMedia === undefined) throw new PublicMediaNotConfiguredError();

    // A malformed key is refused with the same error a merely-unrecorded key
    // gets, before any port is consulted.
    if (
      !PUBLIC_AD_MEDIA_ORG_ID_PATTERN.test(orgId) ||
      !UUID_PATTERN.test(campaignId) ||
      (() => {
        try {
          assertObjectKey(key);
          return false;
        } catch {
          return true;
        }
      })()
    ) {
      throw new PublishedClipNotFoundError();
    }

    const clips = await this.deps.publishedClipRecord.listForCampaign(orgId, campaignId);
    if (!clips.some((c) => c.key === key)) throw new PublishedClipNotFoundError();

    // Public bytes first, ledger row second: a failed removal leaves the
    // record intact so the same call can be retried.
    await publicAdMedia.remove(key);
    await this.deps.publishedClipRecord.remove(orgId, key);
  }
}
