/**
 * Where a campaign's run report is kept (PT-0a, C2 of the platform plan).
 *
 * Reports used to be read and written straight off the output tree by
 * `lib/report.ts`, beside the ports rather than behind one, so a storage swap
 * would have left them on local disk. The port is deliberately small: the
 * merge, the derived `brandCompliant` field and the revision guard stay in
 * `report.ts`, and the store only keeps bytes, keyed by campaign.
 *
 * There is no "latest run" entry. The global `report.json` pointer served
 * whichever campaign ran last to any caller, which has no meaning once runs
 * belong to a tenant; every read names its campaign.
 */
export interface ReportStorePort {
  /**
   * The parsed report, or `undefined` when the id is not a safe campaign id or
   * nothing readable is stored. A stored JSON `null` returns `null`.
   */
  readReport(campaignId: string): Promise<unknown>;
  /**
   * The SHA-256 digest of the stored bytes (D80), or `undefined` when the id is
   * unsafe or nothing is stored. The value a caller passes back as
   * `writeReport`'s `expectedRevision`.
   */
  getRevision(campaignId: string): Promise<string | undefined>;
  /**
   * Store `payload` as the campaign's report, atomically: a concurrent reader
   * sees the previous report or this one, never a torn file. Unconditional —
   * the revision guard is the caller's, so a refused run does no work at all.
   * Rejects when the id is not a safe campaign id. Returns a human-readable
   * locator of what was written (the CLI prints it).
   */
  writeReport(campaignId: string, payload: string): Promise<string>;
}
