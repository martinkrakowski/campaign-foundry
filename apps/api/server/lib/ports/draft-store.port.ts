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
 * W3's resume (item 5): which campaign one of the caller's drafts belongs
 * to. `DraftStorePort.listDraftsByRecency` answers a list of these, newest
 * first, without the caller knowing which campaign to ask about first — the
 * route walks it looking for the newest one whose campaign is still visible
 * to this caller (fix round item 1: a draft on a campaign since hidden by
 * team, or otherwise gone, must never surface here).
 */
export interface LatestDraft {
  readonly campaignId: string;
  readonly updatedAt: string;
}

/**
 * item 3's compare-and-swap outcome (fix round, grok-4.7): `writeDraftIfCurrent`
 * either wrote (`ok: true`) or refused because the campaign's current
 * revision had moved past `baseRevision` (`ok: false`) — nothing is written
 * in the second case. `currentRevision` on the refusal is what the route's
 * 409 body already carries.
 */
export type WriteDraftOutcome =
  | { readonly ok: true; readonly draft: StoredDraft }
  | { readonly ok: false; readonly currentRevision: string | null };

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
   * keyed on (campaignId, userId), never an audit trail, and never
   * revision-checked: this method always writes what it is given.
   * `writeDraftIfCurrent`, below, is what the PUT route calls — this raw
   * form exists for callers that already know the write is safe (tests
   * seeding fixtures, the compare-and-swap's own successful branch).
   */
  writeDraft(
    campaignId: string,
    userId: string,
    state: unknown,
    baseRevision: string | null,
  ): Promise<StoredDraft>;

  /**
   * The PUT route's own compare-and-swap (fix round item 2, grok-4.7): a
   * `getRevision` pre-check followed by an unconditional `writeDraft` left a
   * window where a brief save committing in between overwrote the stored
   * draft with content computed against a baseline that was already stale.
   * This method closes that window itself, not its caller — the predicate
   * is IN the write:
   *
   * - Postgres locks the campaign row the same way a brief save's own
   *   compare-and-swap does (`select … for update`, `pg-brief-store.ts`
   *   `rewriteBriefInternal`) and reads `brief_version` fresh inside that
   *   same transaction, so a save racing this write either commits first
   *   (and this write sees the new revision) or blocks until this write's
   *   transaction ends (and so cannot land inside it) — never a same-instant
   *   sliver where neither has happened yet and either was possible.
   * - The filesystem backend has no such row to lock, so its caller
   *   (`PUT /campaigns/:id/draft`) wraps the whole read-compare-write in
   *   `BriefStorePort.withBriefLock` — the same in-process chain a brief
   *   save's own `rewriteBrief` call already runs under — and passes the
   *   revision it read under that lock as `currentRevision`; the Postgres
   *   adapter ignores that parameter and re-derives its own, since a
   *   caller-supplied value is exactly the staleness this method exists to
   *   refuse.
   *
   * `null` on either side means "no published version yet" (D177) and
   * compares equal to itself, never to a real revision string.
   */
  writeDraftIfCurrent(
    campaignId: string,
    userId: string,
    state: unknown,
    baseRevision: string | null,
    currentRevision: string | null,
  ): Promise<WriteDraftOutcome>;

  /** A no-op when this caller has no draft for this campaign — never an error. */
  deleteDraft(campaignId: string, userId: string): Promise<void>;

  /**
   * Every one of the caller's drafts across their org, newest first, by
   * `updatedAt`. `GET /campaigns/briefs/draft` (item 5 / fix round item 1)
   * walks this looking for the newest whose campaign `campaignMeta` still
   * answers for this caller — a draft alone never means its campaign is
   * still visible (team-hidden since, or otherwise gone).
   */
  listDraftsByRecency(userId: string): Promise<readonly LatestDraft[]>;
}
