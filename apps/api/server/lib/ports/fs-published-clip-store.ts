import type {
  ObjectKey,
  PublishedClipRecord,
  PublishedClipRecordPort,
} from "@campaignfoundry/CampaignOrchestration";

const MESSAGE =
  "Published clip records need STORE_BACKEND=postgres: the public-media ledger is Postgres-only.";

/**
 * Thrown when published-clip records cannot be served at all — the fs
 * backend, which has no table for them. Carries `statusCode`/`status`
 * (h3 reads either) so a route that lets it propagate answers 503, matching
 * `ProviderKeyUnavailableError`.
 */
export class PublishedClipStoreUnavailableError extends Error {
  readonly statusCode = 503;
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "PublishedClipStoreUnavailableError";
  }
}

/**
 * The fs backend refuses (PT-4k): it has no table to hold the published-clip
 * ledger, and a public-media record silently dropped would let a later
 * publish believe the bytes are recorded when nothing is. Every method
 * answers the same 503-shaped error naming what's missing — it never stores
 * in memory or on disk.
 */
export class FsPublishedClipStore implements PublishedClipRecordPort {
  async record(
    _orgId: string,
    _campaignId: string,
    _key: ObjectKey,
    _url: string,
    _contentHash: string,
  ): Promise<"recorded" | "exists"> {
    throw new PublishedClipStoreUnavailableError(MESSAGE);
  }

  async find(
    _orgId: string,
    _campaignId: string,
    _contentHash: string,
  ): Promise<PublishedClipRecord | undefined> {
    throw new PublishedClipStoreUnavailableError(MESSAGE);
  }

  async listForCampaign(
    _orgId: string,
    _campaignId: string,
  ): Promise<readonly PublishedClipRecord[]> {
    throw new PublishedClipStoreUnavailableError(MESSAGE);
  }

  async remove(_orgId: string, _key: ObjectKey): Promise<void> {
    throw new PublishedClipStoreUnavailableError(MESSAGE);
  }
}
