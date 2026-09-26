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
   * nothing is stored. A stored JSON `null` returns `null`. A report that is
   * stored but cannot be read or parsed rejects: it is not the same as absence.
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
   * sees the previous report or this one, never a torn file. Rejects when the
   * id is not a safe campaign id. Returns a human-readable locator of what
   * was written (the CLI prints it).
   *
   * `expectedRevision` (PT-3c, mirroring `DecisionStorePort.writeDecisions`):
   * `undefined` (the default) is unconditional — the revision guard is
   * `report.ts`'s own, so a refused run does no work at all. `null` writes
   * only while nothing is stored yet. A string writes only while it is still
   * the stored revision. The compare and the write are one atomic step in the
   * store, closing the cross-process race `report.ts`'s guard only narrows
   * (D79 on files). A mismatch throws `ReportConflictError`.
   *
   * `fence` (PT-6a2, D171, D78): optional run id that fences the write. When
   * provided, the write is refused (throws `JobLeaseLostError`) if the run no
   * longer holds its lease (not running or lease lapsed). Without a fence,
   * today's behaviour is preserved (the CLI and direct writes pass none).
   */
  writeReport(
    campaignId: string,
    payload: string,
    expectedRevision?: string | null,
    fence?: { runId: string },
  ): Promise<string>;
}


/** A write whose expected revision is no longer the stored one (D173's shape, D79). */
export class ReportConflictError extends Error {
  readonly code = "ECONFLICT";
  constructor(
    campaignId: string,
    /** The revision stored now (undefined: none). */
    readonly revision: string | undefined,
  ) {
    super(`Report for campaign "${campaignId}" was modified by another run.`);
  }
}
