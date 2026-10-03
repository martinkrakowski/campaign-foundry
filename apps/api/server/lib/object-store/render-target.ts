import { objectStore } from "../config.js";
import { database } from "../db/database.js";
import type { RunEnvironment } from "../run-environment.js";

/**
 * Where ONE run's renders go (PT-4e, D203, D207).
 *
 * Both halves are needed and neither can be derived from the other. `campaignId`
 * is the uuid a key must be built from (DoD 3: no key carries the slug), and the
 * store only knows uuids; `slug` is what the use case actually builds its
 * relative paths from, so the exporter needs it to know which leading segment
 * belongs to it. Resolving the pair ONCE, here, is what lets `buildPipeline`
 * refuse to guess: a target is a fact about the run, not something each adapter
 * re-derives from an environment or a row it happens to be holding.
 */
export interface RenderTarget {
  /** The campaign's own uuid — `campaign.id`, never its slug. */
  readonly campaignId: string;
  /** The brief id the use case's relative paths start with. */
  readonly slug: string;
}

/**
 * The campaign uuid behind a run's brief slug, or `undefined` when this run has
 * no target: either because the backend writes to disk (`fs`, which has no
 * campaign rows to key anything by) or because this org has no such campaign.
 *
 * **ORG-scoped, not team-filtered** (D207), and for the same reason D206 gave
 * for input assets: the row is only an id lookup, and the team rules belong to
 * the routes that gate visibility. Re-deciding them here would be a second copy
 * of one rule free to disagree — and worse, it would fail a run that a team
 * change between enqueue and start had every right to finish.
 *
 * `org_id` is in the WHERE clause and is the whole of the tenant scope. A slug
 * is NOT globally unique — the constraint is `(org_id, slug)` — so without it a
 * slug taken in another org would resolve to that org's campaign and this run
 * would write its renders into another tenant's prefix.
 *
 * Under `fs` it answers `undefined` WITHOUT touching the database. Not for
 * speed: a file-backed deployment with no Postgres at all must keep working,
 * and `database()` would open a pool it has no settings for. The `undefined`
 * means "nothing to key by", which under fs is exactly right — the exporter
 * there writes to `env.outputRoot` and needs no uuid.
 */
export async function renderTarget(
  env: RunEnvironment,
  slug: string,
): Promise<RenderTarget | undefined> {
  if (objectStore() === "fs") return undefined;
  const { rows } = await database().query<{ id: string }>(
    `select id from campaign where org_id = $1 and slug = $2`,
    [env.tenant.orgId, slug],
  );
  const campaignId = rows[0]?.id;
  return campaignId === undefined ? undefined : { campaignId, slug };
}
