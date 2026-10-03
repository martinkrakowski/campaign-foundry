import { objectStore } from "../config.js";
import { database } from "../db/database.js";
import type { RunEnvironment } from "../run-environment.js";
import { UUID_PATTERN } from "./object-keys.js";

/**
 * Where ONE run's renders go (PT-4e, D203, D207).
 *
 * Both halves are needed and neither can be derived from the other. `campaignId`
 * is the uuid a key must be built from (DoD 3: no key carries the slug), and the
 * store only knows uuids; `slug` is what the exporter checks every relative path
 * against, and those paths are built from the ref the caller used. Resolving the
 * pair ONCE, here, is what lets `buildPipeline` refuse to guess: a target is a
 * fact about the run, not something each adapter re-derives from an environment
 * or a row it happens to be holding.
 */
export interface RenderTarget {
  /** The campaign's own uuid — `campaign.id`, never its slug. */
  readonly campaignId: string;
  /**
   * The REF the use case's relative paths start with, exactly as it was passed —
   * not the row's own slug. See {@link renderTarget}.
   */
  readonly slug: string;
}

/**
 * The campaign uuid behind a run's brief ref, or `undefined` when this run has
 * no target: either because the backend writes to disk (`fs`, which has no
 * campaign rows to key anything by) or because this org has no such campaign.
 *
 * **The ref is a uuid OR a slug, resolved with the same shape
 * `PgBriefStore.campaignMeta` uses** (D178): a canonical uuid is tried as
 * `campaign.id` first, and only then as `campaign.slug`. This is not a
 * convenience — the gate that let the run start is `campaignMeta(brief.id)`, so a
 * body brief whose `id` is the campaign's uuid is APPROVED AND QUEUED, and a
 * resolver that knew only `slug = $2` then failed every such run with a message
 * about the campaign not being found. It is the same rule the input-asset path
 * resolves a brief's refs under (D206), for the same reason.
 *
 * **`slug` is the REF and never the row's slug**, which is where this
 * deliberately differs from `resolveCampaign`. `GenerateCampaignUseCase` builds
 * every relative path through `campaignScoped(brief.id, …)`, so a
 * uuid-addressed run's paths are `<uuid>/…`; returning the row's real slug here
 * would hand the exporter a `campaignSegment` that matches none of them, and
 * `renderObjectKey` would refuse every single write. The ref is what the paths
 * carry, so the ref is what the exporter must expect.
 *
 * A ref that is not uuid-shaped is NEVER compared to `id`. `campaign.id` is a
 * `uuid` column, so `where id = $2` with a slug is a cast ERROR from Postgres
 * rather than an empty answer — the uuid branch is gated on the shape, not
 * applied to everything.
 *
 * `org_id` is in the WHERE clause of BOTH branches and is the whole of the tenant
 * scope. A slug is NOT globally unique — the constraint is `(org_id, slug)` — and
 * a uuid is only as private as the org that issued it, so without it this
 * answers another tenant's campaign and the run writes its renders into the other
 * tenant's prefix. Neither branch filters by team (D207), for the reason D206
 * gives: the team rules belong to the routes that gate visibility, and a second
 * copy here would fail a claimed job whose team changed between enqueue and run.
 *
 * Under `fs` it answers `undefined` WITHOUT opening the database. Not for speed:
 * a file-backed deployment with no Postgres at all must keep working, and
 * `database()` would open a pool it has no settings for. The `undefined` means
 * "nothing to key by", which under fs is exactly right — the exporter there
 * writes to `env.outputRoot` and needs no uuid.
 */
export async function renderTarget(
  env: RunEnvironment,
  slug: string,
): Promise<RenderTarget | undefined> {
  if (objectStore() === "fs") return undefined;
  if (UUID_PATTERN.test(slug)) {
    const { rows } = await database().query<{ id: string }>(
      `select id, slug from campaign where org_id = $1 and id = $2`,
      [env.tenant.orgId, slug.toLowerCase()],
    );
    const byId = rows[0];
    // Falls THROUGH rather than returning `undefined`: `id` and `slug` share one
    // text space, so a uuid-shaped ref may be nobody's id and somebody's slug.
    if (byId !== undefined) return { campaignId: byId.id, slug };
  }
  const { rows } = await database().query<{ id: string }>(
    `select id, slug from campaign where org_id = $1 and slug = $2`,
    [env.tenant.orgId, slug],
  );
  const bySlug = rows[0];
  return bySlug === undefined ? undefined : { campaignId: bySlug.id, slug };
}
