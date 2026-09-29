/**
 * A per-user autosave draft (PT-5d, D173, D177): the editor-state blob
 * `BriefEditor` PUTs, debounced, never a brief — `parseBrief` never runs
 * against it. `baseRevision` is the campaign's published revision
 * (`StoredBrief.revision`) the draft was taken against, `null` for a
 * versionless campaign (D177: "no published version" is itself the value,
 * not the absence of one). `updatedAt` is an ISO-8601 UTC instant, the store's
 * own clock — never client-supplied.
 */
export interface StoredDraft {
  readonly state: unknown;
  readonly baseRevision: string | null;
  readonly updatedAt: string;
}

/**
 * W3's resume (item 5): which campaign the caller's latest draft belongs to,
 * with no other campaign named — `DraftStorePort.latestDraft` answers this
 * without the caller knowing which campaign to ask about first.
 */
export interface LatestDraft {
  readonly campaignId: string;
  readonly updatedAt: string;
}

/**
 * Port for a per-user, per-campaign autosave draft (PT-5d). `campaignId` is
 * the same shape `BriefStorePort` already returns from `campaignMeta`/
 * `resolveCampaign`: the Postgres surrogate uuid (`0014_draft.sql`'s FK) or
 * the slug on the filesystem backend (D179 — the fs id IS the slug). Every
 * method is scoped to the caller's org by construction (the registry key,
 * `lib/ports/index.ts`, mirrors `PgDecisionStore`/`PgReportStore`) and to the
 * caller's own `userId`, passed explicitly — the user comes from the session
 * only, never from a request body (route-side rule, not this port's).
 *
 * No `node:fs`, path joining, or `process.cwd()` may leak through this
 * interface, per `.agents/architecture.md`.
 */
export interface DraftStorePort {
  /** `undefined` when this caller has no draft for this campaign. */
  readDraft(campaignId: string, userId: string): Promise<StoredDraft | undefined>;

  /**
   * Store or replace this caller's draft for this campaign — an upsert
   * keyed on (campaignId, userId), never an audit trail. Callers are
   * responsible for refusing a stale `baseRevision` before calling this
   * (the route compares it against the campaign's current revision and
   * answers 409 without writing, per the row's item 3) — this method
   * always writes what it is given.
   */
  writeDraft(
    campaignId: string,
    userId: string,
    state: unknown,
    baseRevision: string | null,
  ): Promise<StoredDraft>;

  /** A no-op when this caller has no draft for this campaign — never an error. */
  deleteDraft(campaignId: string, userId: string): Promise<void>;

  /** `undefined` when this caller has no draft anywhere in their org. */
  latestDraft(userId: string): Promise<LatestDraft | undefined>;
}
