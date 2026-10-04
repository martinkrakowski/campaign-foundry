import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetDatabase, setDatabase } from "../../db/database.js";
import * as dbModule from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient, SqlRows } from "../../db/sql-client.js";
import { runEnvironment } from "../../run-environment.js";
import { LOCAL_TENANT } from "../../tenant.js";
import * as storeModule from "../index.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../index.js";
import { renderTarget } from "../render-target.js";

/**
 * `renderTarget` — the one place a run's ref becomes the uuid its renders are
 * keyed by (PT-4e, D207; fix 1).
 *
 * On the real PGlite harness rather than a stub, because the sharpest question
 * here is what POSTGRES does rather than what a Map does: `campaign.id` is a
 * `uuid` column, so a resolver that compared a slug against `id` does not answer
 * "no such campaign" — it raises a cast error. A stub would hand back an empty
 * row set for that query and every test here would pass against the code this
 * fix exists to remove.
 *
 * Four claims, each a tenancy claim rather than a lookup detail: the ref is read
 * with the SAME uuid-then-slug shape `PgBriefStore.campaignMeta` uses, `org_id`
 * is in BOTH of those queries, a non-uuid is never compared to `id`, and under
 * `fs` the database is not opened at all.
 */

const ACME = "acme";
const GLOBEX = "globex";
const SLUG = "winter-sale";
/** Fixed uuids, so a key assertion names one campaign rather than a random one. */
const CAMPAIGN = "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c";
const OTHER_CAMPAIGN = "00000000-0000-4000-8000-000000000001";

const envFor = (orgId: string) => runEnvironment({ ...LOCAL_TENANT, orgId, userId: "u1" });

/**
 * Seed an org and one campaign in it. The `id` may be pinned, because the case
 * that needs a uuid REF is a run whose `brief.id` is the uuid — and the only way
 * to have one is to choose it.
 */
async function seedCampaign(
  db: SqlClient,
  orgId: string,
  slug: string,
  id?: string,
): Promise<string> {
  await db.query(`insert into org (id, name) values ($1, $1) on conflict do nothing`, [orgId]);
  if (id !== undefined) {
    await db.query(`insert into campaign (id, org_id, slug) values ($1, $2, $3)`, [
      id,
      orgId,
      slug,
    ]);
    return id;
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into campaign (org_id, slug) values ($1, $2) returning id`,
    [orgId, slug],
  );
  return rows[0]!.id;
}

/** Every statement this client is asked, whitespace-flattened for comparison. */
function recordStatements(db: SqlClient): string[] {
  const statements: string[] = [];
  const real = db.query.bind(db);
  vi.spyOn(db, "query").mockImplementation(
    async (text: string, params?: readonly unknown[]): Promise<SqlRows<never>> => {
      statements.push(text.replace(/\s+/g, " ").trim());
      return (await real(text as never, params as never)) as SqlRows<never>;
    },
  );
  return statements;
}

describe("renderTarget", () => {
  let db: SqlClient;
  const savedStore = process.env.OBJECT_STORE;

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    db = await migratedDatabase();
    setDatabase(db);
    setObjectStoreClient(new InMemoryObjectStore());
  });

  afterEach(async () => {
    resetDatabase();
    resetObjectStoreClient();
    vi.restoreAllMocks();
    if (savedStore === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = savedStore;
    await db.end();
  });

  test("under s3 a slug resolves to its campaign in this org, and to nothing outside it", async () => {
    await seedCampaign(db, ACME, SLUG, CAMPAIGN);
    expect(await renderTarget(envFor(ACME), SLUG)).toEqual({ campaignId: CAMPAIGN, slug: SLUG });
    // Absent, never forbidden: another org asking for this org's slug learns
    // nothing about it, which is the answer the routes have always given.
    expect(await renderTarget(envFor(GLOBEX), SLUG)).toBeUndefined();
  });

  test("a uuid ref resolves to its own row — the shape campaignMeta already accepts (fix 1)", async () => {
    // `generate.post.ts` gates on `campaignMeta(brief.id)`, which tries the uuid
    // FIRST and falls back to the slug. So a body brief whose `id` is the
    // campaign's uuid is accepted and queued — and a resolver that only knew
    // `slug = $2` then failed a run the gate had just approved.
    await seedCampaign(db, ACME, SLUG, CAMPAIGN);
    expect(await renderTarget(envFor(ACME), CAMPAIGN)).toEqual({
      campaignId: CAMPAIGN,
      slug: CAMPAIGN,
    });
  });

  test("`slug` is the REF, not the row's own slug, so uuid-addressed paths still map (fix 1)", async () => {
    // Deliberately different from `resolveCampaign`, which returns the ROW's
    // slug. `GenerateCampaignUseCase` builds every relative path with
    // `campaignScoped(brief.id, …)`, so a uuid-addressed run's paths start with
    // the uuid. Returning the row's real slug here would make `renderObjectKey`
    // refuse every one of them, because the leading segment would not be the one
    // the exporter was built for.
    await seedCampaign(db, ACME, SLUG, CAMPAIGN);
    const target = await renderTarget(envFor(ACME), CAMPAIGN);
    expect(target!.slug).toBe(CAMPAIGN);
    expect(target!.slug).not.toBe(SLUG);
  });

  test("a uuid ref from ANOTHER org resolves to nothing — org_id is on the uuid query too (fix 1)", async () => {
    await seedCampaign(db, ACME, SLUG, CAMPAIGN);
    await seedCampaign(db, GLOBEX, "their-campaign", OTHER_CAMPAIGN);
    // `OTHER_CAMPAIGN` is GLOBEX's own campaign and ACME asks for it. Without
    // `org_id` on the uuid branch this answers GLOBEX's row, and the run then
    // writes every render into the other tenant's prefix.
    expect(await renderTarget(envFor(ACME), OTHER_CAMPAIGN)).toBeUndefined();
    expect(await renderTarget(envFor(GLOBEX), OTHER_CAMPAIGN)).toEqual({
      campaignId: OTHER_CAMPAIGN,
      slug: OTHER_CAMPAIGN,
    });
  });

  test("a non-uuid ref is never compared to id: one query, the slug one (fix 1)", async () => {
    // `campaign.id` is a `uuid` column, so `where id = $2` with a slug raises a
    // cast ERROR rather than returning nothing — a resolver that took the uuid
    // branch for every ref would turn every slug run into a failure. Asserting
    // the ANSWER is not enough, because a throw inside the resolver could be
    // swallowed into the same `undefined`; so the statements are asserted too.
    await seedCampaign(db, ACME, SLUG, CAMPAIGN);
    const statements = recordStatements(db);
    expect(await renderTarget(envFor(ACME), SLUG)).toEqual({ campaignId: CAMPAIGN, slug: SLUG });
    expect(statements).toEqual([
      "select id, slug from campaign where org_id = $1 and slug = $2 and deleted_at is null",
    ]);
  });

  test("a tombstoned campaign resolves to nothing, by uuid and by slug alike", async () => {
    // A deleted campaign is ABSENT here, exactly as one that was never created:
    // `renderTarget` answers "nothing to key by", and a uuid nobody resolves is
    // the one thing that must not produce a prefix to write renders into. Both
    // branches are asserted because both carry the filter — the uuid branch
    // alone would still hand back the row for a slug-addressed run.
    await seedCampaign(db, ACME, SLUG, CAMPAIGN);
    await db.query(`update campaign set deleted_at = now() where org_id = $1 and id = $2`, [
      ACME,
      CAMPAIGN,
    ]);
    expect(await renderTarget(envFor(ACME), CAMPAIGN)).toBeUndefined();
    expect(await renderTarget(envFor(ACME), SLUG)).toBeUndefined();
    // The filter is on the ROW, not the slug: GLOBEX holds the same slug in its
    // own org, and a tombstone in ACME must not reach across and hide it.
    await seedCampaign(db, GLOBEX, SLUG, OTHER_CAMPAIGN);
    expect(await renderTarget(envFor(GLOBEX), SLUG)).toEqual({
      campaignId: OTHER_CAMPAIGN,
      slug: SLUG,
    });
  });

  test("a uuid matching no row falls back to the slug branch, within this org only (fix 1)", async () => {
    // A ref that is uuid-SHAPED, is nobody's id, and happens to be a slug here.
    // This is why the uuid branch must FALL THROUGH rather than return: `id` and
    // `slug` share one text space, so either can hold the ref.
    await seedCampaign(db, ACME, OTHER_CAMPAIGN, CAMPAIGN); // a campaign whose SLUG is a uuid
    await seedCampaign(db, GLOBEX, OTHER_CAMPAIGN); // and another org's slug by that text
    const globexOwn = await renderTarget(envFor(GLOBEX), OTHER_CAMPAIGN);
    // ACME's row, reached by SLUG — the uuid branch found nothing and fell through.
    expect(await renderTarget(envFor(ACME), OTHER_CAMPAIGN)).toEqual({
      campaignId: CAMPAIGN,
      slug: OTHER_CAMPAIGN,
    });
    // GLOBEX holds that text as a slug too, and gets ITS OWN row: the fallback is
    // scoped exactly as the uuid branch is, so the two orgs never trade campaigns.
    expect(globexOwn).toBeDefined();
    expect(globexOwn!.campaignId).not.toBe(CAMPAIGN);
    expect(globexOwn!.slug).toBe(OTHER_CAMPAIGN);
    // A third org, seeded but holding no campaign, answers nothing.
    await db.query(`insert into org (id, name) values ($1, $1)`, ["neither"]);
    expect(await renderTarget(envFor("neither"), OTHER_CAMPAIGN)).toBeUndefined();
  });

  test("both branches carry org_id as the first parameter (fix 1)", async () => {
    await seedCampaign(db, ACME, SLUG, CAMPAIGN);
    const statements = recordStatements(db);
    // Another org's uuid: the uuid branch runs and finds nothing, so the slug
    // branch runs too. An org id anywhere but $1 would scope nothing at all.
    expect(await renderTarget(envFor(GLOBEX), CAMPAIGN)).toBeUndefined();
    expect(statements).toEqual([
      "select id, slug from campaign where org_id = $1 and id = $2 and deleted_at is null",
      "select id, slug from campaign where org_id = $1 and slug = $2 and deleted_at is null",
    ]);
    // And its own: one statement, the uuid branch, because the slug branch is
    // only reached when the first misses.
    statements.length = 0;
    expect(await renderTarget(envFor(ACME), CAMPAIGN)).toEqual({
      campaignId: CAMPAIGN,
      slug: CAMPAIGN,
    });
    expect(statements).toEqual([
      "select id, slug from campaign where org_id = $1 and id = $2 and deleted_at is null",
    ]);
  });

  test("a bare `{ tenant }` is enough — `package.post.ts` has no run environment (PT-4h1)", async () => {
    // The parameter is `Pick<RunEnvironment, "tenant">`, so the route that resolves
    // a packaging target can pass the one thing this function reads. The refusal
    // is the compile-time claim: this call has no `outputRoot`, no `assetRoot`,
    // no font and no provider settings, so if the resolver ever reached for one
    // this file would not typecheck rather than the route failing at runtime.
    await seedCampaign(db, ACME, SLUG, CAMPAIGN);
    expect(await renderTarget({ tenant: { ...LOCAL_TENANT, orgId: ACME } }, SLUG)).toEqual({
      campaignId: CAMPAIGN,
      slug: SLUG,
    });
    // Absent is absent on the narrow parameter too — the org id is what scopes the
    // query, and it is the one field the caller has.
    expect(
      await renderTarget({ tenant: { ...LOCAL_TENANT, orgId: GLOBEX } }, SLUG),
    ).toBeUndefined();
  });

  describe("under fs it answers undefined WITHOUT opening the database (fix 1)", () => {
    /** Every query path raises, so "not used" is a failure rather than a claim. */
    const refuse = async (): Promise<never> => {
      throw new Error("the database must not be opened under OBJECT_STORE=fs");
    };
    const throwingDb = (): SqlClient =>
      ({
        query: refuse,
        exec: refuse,
        transaction: refuse,
        end: refuse,
      }) as unknown as SqlClient;

    for (const [what, store] of [
      ["OBJECT_STORE=fs", "fs"],
      ["an unset OBJECT_STORE", undefined],
      ["an empty OBJECT_STORE", ""],
    ] as const) {
      test(what, async () => {
        if (store === undefined) delete process.env.OBJECT_STORE;
        else process.env.OBJECT_STORE = store;
        setDatabase(throwingDb());
        // Spied on the ACCESSOR, not only on the client. A throwing client only
        // fails when a query REACHES it, so a resolver that merely asked for the
        // database — opening a pool on a file-backed deployment that has no
        // Postgres settings at all — would still have passed. Calling
        // `database()` is itself the defect.
        const opened = vi.fn(() => throwingDb());
        const asked = vi.spyOn(dbModule, "database").mockImplementation(opened);
        expect(await renderTarget(envFor(ACME), SLUG)).toBeUndefined();
        expect(asked).not.toHaveBeenCalled();
        expect(opened).not.toHaveBeenCalled();
      });
    }
  });

  test("resolving a target is a database question and opens no object store (fix 1)", async () => {
    // A key is built LATER. A composition root that opened a bucket to learn a
    // uuid would fail a run whose only sin is an unreachable store.
    await seedCampaign(db, ACME, SLUG, CAMPAIGN);
    const opened = vi.fn(() => new InMemoryObjectStore());
    const asked = vi.spyOn(storeModule, "objectStoreClient").mockImplementation(opened);
    expect(await renderTarget(envFor(ACME), SLUG)).toBeDefined();
    expect(asked).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });
});
