import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetDatabase, setDatabase } from "../../db/database.js";
import type { SqlClient, SqlRows } from "../../db/sql-client.js";
import { runEnvironment } from "../../run-environment.js";
import { LOCAL_TENANT } from "../../tenant.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../index.js";
import { renderTarget } from "../render-target.js";

/**
 * `renderTarget` — the one place a run's slug becomes the uuid its renders are
 * keyed by (PT-4e, D207). Three claims are proved here and each is a tenancy
 * claim, not a lookup detail: it is ORG-scoped, it does not filter by team, and
 * under `fs` it asks the database nothing at all.
 */

const ACME = "acme";
const GLOBEX = "globex";
const CAMPAIGN = "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c";
const OTHER_CAMPAIGN = "00000000-0000-4000-8000-000000000001";

/** A `SqlClient` that answers one query and records what it was asked. */
function stubDb(rows: ReadonlyArray<{ id: string }>): SqlClient & { seen: () => string[][] } {
  const seen: string[][] = [];
  const query = async <R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlRows<R>> => {
    seen.push([text, ...(params ?? []).map(String)]);
    return { rows: rows as R[] };
  };
  return {
    query,
    exec: async () => undefined,
    transaction: async (work) => work({ query, exec: async () => undefined }),
    end: async () => undefined,
    seen: () => seen,
  };
}

/** A database that refuses every question, so "never touched" is observable. */
function throwingDb(): SqlClient {
  const refuse = async (): Promise<never> => {
    throw new Error("the database must not be opened under OBJECT_STORE=fs");
  };
  return {
    query: refuse,
    exec: refuse,
    transaction: refuse,
    end: refuse,
  } as unknown as SqlClient;
}

const envFor = (orgId: string) => runEnvironment({ ...LOCAL_TENANT, orgId, userId: "u1" });

describe("renderTarget", () => {
  const savedStore = process.env.OBJECT_STORE;

  beforeEach(() => {
    process.env.OBJECT_STORE = "s3";
  });

  afterEach(() => {
    resetDatabase();
    resetObjectStoreClient();
    if (savedStore === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = savedStore;
  });

  test("under s3 it answers the campaign uuid for this org's slug", async () => {
    const db = stubDb([{ id: CAMPAIGN }]);
    setDatabase(db);
    expect(await renderTarget(envFor(ACME), "summer-launch")).toEqual({
      campaignId: CAMPAIGN,
      slug: "summer-launch",
    });
    // The one statement, org-scoped, with the org as the FIRST parameter — the
    // slug is the variable part and org_id is the scope.
    expect(db.seen()).toEqual([
      ["select id from campaign where org_id = $1 and slug = $2", ACME, "summer-launch"],
    ]);
  });

  test("the same slug in another org resolves to that org's campaign, or to nothing", async () => {
    // A slug is NOT globally unique — the constraint is `(org_id, slug)` — so
    // without `org_id` in the WHERE clause this answers another tenant's id
    // and the caller writes its renders into that tenant's prefix.
    const db = stubDb([{ id: OTHER_CAMPAIGN }]);
    setDatabase(db);
    expect(await renderTarget(envFor(GLOBEX), "summer-launch")).toEqual({
      campaignId: OTHER_CAMPAIGN,
      slug: "summer-launch",
    });
    expect(db.seen()[0]).toEqual([
      "select id from campaign where org_id = $1 and slug = $2",
      GLOBEX,
      "summer-launch",
    ]);

    // …and an org with no such slug answers absent rather than forbidden.
    resetDatabase();
    const empty = stubDb([]);
    setDatabase(empty);
    expect(await renderTarget(envFor(ACME), "summer-launch")).toBeUndefined();
  });

  test("it does NOT filter by team (D207): a team change between enqueue and run cannot fail a run", async () => {
    // The query asks for the id and nothing else — no team join, no visibility
    // predicate. Team rules belong to the routes that gate visibility; a second
    // copy here would fail a claimed job whose team changed under it.
    const db = stubDb([{ id: CAMPAIGN }]);
    setDatabase(db);
    await renderTarget(envFor(ACME), "summer-launch");
    expect(db.seen()[0]![0]).not.toMatch(/team/i);
    expect(db.seen()[0]).toHaveLength(3);
  });

  test("under fs it answers undefined WITHOUT touching the database", async () => {
    process.env.OBJECT_STORE = "fs";
    // Not for speed: a file-backed deployment with no Postgres at all must keep
    // working, and `database()` would open a pool it has no settings for.
    setDatabase(throwingDb());
    expect(await renderTarget(envFor(ACME), "summer-launch")).toBeUndefined();
  });

  test("an unset or empty OBJECT_STORE is fs, so it asks nothing either", async () => {
    delete process.env.OBJECT_STORE;
    setDatabase(throwingDb());
    expect(await renderTarget(envFor(ACME), "summer-launch")).toBeUndefined();
    process.env.OBJECT_STORE = "";
    expect(await renderTarget(envFor(ACME), "summer-launch")).toBeUndefined();
  });

  test("a store that answers no rows leaves the run with no target, not with a throw", async () => {
    setDatabase(stubDb([]));
    // `undefined` is the shape both absences share, and it is what lets
    // `buildPipeline` refuse and `runCampaign` explain without either of them
    // having to re-derive which absence it was.
    await expect(renderTarget(envFor(ACME), "missing")).resolves.toBeUndefined();
  });

  test("the object store client is not built by a lookup", async () => {
    // Resolving a target is a DATABASE question. A render key is built later,
    // and a composition root that opened a bucket to learn a uuid would fail a
    // run with an unreachable store for a reason that has nothing to do with
    // the run.
    setDatabase(stubDb([{ id: CAMPAIGN }]));
    const built = vi.fn();
    setObjectStoreClient(new Proxy({} as never, { get: built }));
    await renderTarget(envFor(ACME), "summer-launch");
    expect(built).not.toHaveBeenCalled();
  });
});
