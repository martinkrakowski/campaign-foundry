import type { ObjectKey } from "./ObjectStorePort.js";

/**
 * A clip recorded as published for a campaign: the PUBLIC bucket key it lives
 * under and the URL a browser fetches. The record is the durable fact; the
 * object behind `key` is the mutable one and may be removed by unpublish.
 */
export interface PublishedClipRecord {
  readonly key: ObjectKey;
  readonly url: string;
}

/**
 * PublishedClipRecordPort — outbound port for the durable record of which
 * clips a campaign has published (PT-4k bookkeeping).
 *
 * `record` is an idempotent insert keyed on `(orgId, campaignId, contentHash)`:
 * content-addressed so the SAME bytes never publish twice, returning
 * `"exists"` rather than throwing when another caller won the race. The
 * winning record's key is discoverable through `find`.
 *
 * It is a separate port from `PublicAdMediaPort` because the public bucket and
 * its ledger have different lifetimes: the store holds bytes, the record holds
 * facts, and a use case that removes bytes must not silently rewrite facts.
 */
/**
 * Thrown by `record` when its `objectStillPublished` precondition answers
 * false: the object the caller published is gone (a reconcile pass removed it
 * while the caller paused), so no ledger row may name it.
 */
export class PublishedClipObjectMissingError extends Error {
  constructor() {
    super("The published clip object no longer exists; refusing to record it.");
    this.name = "PublishedClipObjectMissingError";
  }
}

export interface PublishedClipRecordPort {
  /**
   * Record `(orgId, campaignId) -> key/url` for `contentHash`. Returns
   * `"recorded"` when this call inserted the row, `"exists"` when a record
   * for the same content hash was already present.
   *
   * When `objectStillPublished` is given, the adapter evaluates it while
   * holding the same per-key lock a public-media reconcile takes around its
   * ledger check and removal, and throws `PublishedClipObjectMissingError`
   * (writing nothing) if it answers false. Record and reconcile are thereby
   * mutually exclusive on the key: either the row commits first and the
   * reconcile skips the key, or the removal came first and the record refuses.
   */
  record(
    orgId: string,
    campaignId: string,
    key: ObjectKey,
    url: string,
    contentHash: string,
    objectStillPublished?: () => Promise<boolean>,
  ): Promise<"recorded" | "exists">;

  /** The recorded clip for `contentHash` under `(orgId, campaignId)`, if any. */
  find(
    orgId: string,
    campaignId: string,
    contentHash: string,
  ): Promise<PublishedClipRecord | undefined>;

  /** Every clip recorded for the campaign, in no particular order. */
  listForCampaign(orgId: string, campaignId: string): Promise<readonly PublishedClipRecord[]>;

  /** Forget the record at `key`; idempotent. */
  remove(orgId: string, key: ObjectKey): Promise<void>;
}
