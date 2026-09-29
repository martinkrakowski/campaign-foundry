/**
 * The per-user last-opened campaign pointer (PT-5e, D173, D180): which
 * campaign this user last opened, so the bare `/brief`, `/grid`, `/export`,
 * `/runs` and `/compliance` routes can hand them back to it.
 *
 * This is a POINTER, never an address (D37, unchanged by the move): the URL
 * still names which campaign a page shows — `/brief/<id>` for the editor,
 * `?campaign=<id>` for the shell pages (PT-5c3) — and the pointer only decides
 * where a BARE url goes. `campaignId` is the same shape `BriefStorePort`
 * answers from `campaignMeta`/`resolveCampaign`: the Postgres surrogate uuid, or
 * the slug on the filesystem backend (D179 — on fs the id IS the slug).
 *
 * One pointer per (org, user), never per browser: that is the whole point of
 * the move (D173 — the server is the store of record), and it is what makes the
 * pointer survive a reload and answer the same on another device, where a
 * `localStorage` record could not.
 *
 * `updatedAt` is an ISO-8601 UTC instant, the store's own clock — never
 * client-supplied — and exists for the same reason `StoredDraft.updatedAt` does:
 * a record that says when the user last was here.
 */
export interface LastOpenedPointer {
  readonly campaignId: string;
  readonly updatedAt: string;
}

/**
 * Port for one user's last-opened campaign (PT-5e). The org scope is the
 * store's own construction (the registry key, `lib/ports/index.ts`, mirroring
 * `PgDecisionStore`/`PgDraftStore`); the user is passed per call, and comes
 * from the session only — never a request body (route-side rule, not this
 * port's).
 *
 * A pointer to a campaign that has since been deleted never outlives it (the
 * `campaign_id` FK cascades, `0015_last_opened.sql`), and a pointer to a
 * campaign that is merely hidden by team is resolved by the ROUTE through
 * `campaignMeta` — this port is deliberately not told about team visibility, so
 * it cannot answer a hidden campaign differently from a deleted one (PT-2d).
 *
 * No `node:fs`, path joining, or `process.cwd()` may leak through this
 * interface, per `.agents/architecture.md`.
 */
export interface LastOpenedStorePort {
  /** `undefined` when this user has never opened a campaign, or it was cleared. */
  read(userId: string): Promise<LastOpenedPointer | undefined>;

  /**
   * Record this user's pointer — an upsert keyed on (org, user), never an audit
   * trail, so opening the same campaign twice leaves one row with a newer
   * `updated_at`. The caller has already resolved the campaign it is naming
   * (a hidden or missing ref never reaches here; the route answers 404), so
   * `campaignId` is a campaign this store's org owns.
   */
  write(campaignId: string, userId: string): Promise<LastOpenedPointer>;
}
