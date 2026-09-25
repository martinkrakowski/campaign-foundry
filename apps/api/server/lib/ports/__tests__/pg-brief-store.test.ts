import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief } from "@campaignfoundry/shared";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { hashBytes } from "../../brief-files.js";
import { LOCAL_TENANT } from "../../tenant.js";
import { FsBriefStore } from "../fs-brief-store.js";
import { PgBriefStore } from "../pg-brief-store.js";
import { getBriefStore, resetBriefStore } from "../index.js";

const minimalBrief: CampaignBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "test-camp",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build great things",
  products: [{ id: "prod-1", name: "Product 1", primaryColor: "#1473E6", logoPath: "logo.png" }],
};

const brief = (id: string, message = "Build great things"): CampaignBrief => ({
  ...minimalBrief,
  id,
  campaignMessage: message,
});

describe("PgBriefStore (PT-3d, D168, D169)", () => {
  let db: SqlClient;
  let store: PgBriefStore;

  beforeEach(async () => {
    db = await migratedDatabase();
    store = new PgBriefStore(db, "local", "local");
  });
  afterEach(async () => {
    await db.end();
  });

  test("listBriefs lists every brief in the org at its latest version, ordered by slug", async () => {
    await store.createBrief(brief("zeta"));
    await store.createBrief(brief("alpha"));
    await store.rewriteBrief(brief("alpha", "Updated"));
    // Another org's brief must never appear in this org's listing.
    await db.query("insert into org (id, name) values ($1, $2)", ["other", "Other"]);
    await new PgBriefStore(db, "other", "local").createBrief(brief("alpha", "Other org"));

    const list = await store.listBriefs();
    expect(list.map((entry) => entry.file)).toEqual(["alpha.yaml", "zeta.yaml"]);
    expect(list[0]!.brief.campaignMessage).toBe("Updated");
    expect(list[0]!.brief.id).toBe("alpha");
    expect(list[1]!.brief.id).toBe("zeta");
  });

  test("listBriefs skips a row that no longer parses, the way the file store skips a bad file", async () => {
    await store.createBrief(brief("good"));
    const { rows } = await db.query<{ id: string }>(
      "insert into campaign (org_id, slug) values ($1, $2) returning id",
      ["local", "bad"],
    );
    await db.query(
      `insert into brief_version (campaign_id, version, body, revision, actor)
       values ($1, 1, $2::jsonb, $3, $4)`,
      [rows[0]!.id, JSON.stringify({ id: "bad" }), "deadbeef", "local"],
    );

    const list = await store.listBriefs();
    expect(list.map((entry) => entry.brief.id)).toEqual(["good"]);
  });

  test("findBriefById finds a brief by its slug, and findBriefFileById answers its file key", async () => {
    await store.createBrief(minimalBrief);
    const found = await store.findBriefById("test-camp");
    expect(found?.file).toBe("test-camp.yaml");
    expect(found?.brief.id).toBe("test-camp");
    expect(await store.findBriefFileById("test-camp")).toBe("test-camp.yaml");
  });

  test("findBriefFile answers the same file key as findBriefFileById", async () => {
    await store.createBrief(minimalBrief);
    expect(await store.findBriefFile("test-camp")).toBe("test-camp.yaml");
  });

  test("an unknown id answers absent everywhere, and readBrief and rewriteBrief refuse it as not found", async () => {
    await expect(store.findBriefById("missing")).resolves.toBeUndefined();
    await expect(store.findBriefFileById("missing")).resolves.toBeUndefined();
    await expect(store.findBriefFile("missing")).resolves.toBeUndefined();
    await expect(store.getRevision("missing")).resolves.toBeUndefined();
    await expect(store.exists("missing")).resolves.toBe(false);
    await expect(store.readBrief("missing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.readBrief("missing.yaml")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.rewriteBrief(brief("missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("readBrief accepts both the file key and the bare slug, and answers the same brief", async () => {
    await store.createBrief(minimalBrief);
    const fromKey = await store.readBrief("test-camp.yaml");
    const fromSlug = await store.readBrief("test-camp");
    expect(fromKey.id).toBe("test-camp");
    expect(fromSlug).toEqual(fromKey);
  });

  test("createBrief mints a campaign at version 1, with a revision equal to the SHA-256 of dumpBrief", async () => {
    const created = await store.createBrief(minimalBrief);
    expect(created.file).toBe("test-camp.yaml");
    expect(created.brief.id).toBe("test-camp");
    expect(created.revision).toBe(hashBytes(Buffer.from(dumpBrief(minimalBrief), "utf8")));

    const { rows } = await db.query<{ version: number; actor: string }>(
      `select bv.version, bv.actor from brief_version bv
         join campaign c on c.id = bv.campaign_id
        where c.org_id = 'local' and c.slug = 'test-camp'`,
    );
    expect(rows).toEqual([{ version: 1, actor: "local" }]);
  });

  test("createBrief is exclusive per (org, slug): a taken slug is EEXIST in the same org, and succeeds in another org", async () => {
    await store.createBrief(minimalBrief);
    await expect(store.createBrief(minimalBrief)).rejects.toMatchObject({ code: "EEXIST" });

    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    const acme = new PgBriefStore(db, "acme", "local");
    const created = await acme.createBrief(minimalBrief);
    expect(created.brief.id).toBe("test-camp");

    // Org isolation: acme's brief is invisible to local, and vice versa.
    expect(await store.findBriefById("test-camp")).toMatchObject({
      brief: { campaignMessage: "Build great things" },
    });
    await acme.rewriteBrief(brief("test-camp", "Acme's own"));
    expect((await acme.findBriefById("test-camp"))?.brief.campaignMessage).toBe("Acme's own");
    expect((await store.findBriefById("test-camp"))?.brief.campaignMessage).toBe(
      "Build great things",
    );
  });

  test("createBrief refuses an unsafe id", async () => {
    await expect(store.createBrief(brief("../evil"))).rejects.toThrow(/not a safe id/);
  });

  test("rewriteBrief writes the next version, unconditionally when no expectedRevision is given", async () => {
    await store.createBrief(minimalBrief);
    const updated = await store.rewriteBrief(brief("test-camp", "Updated message"));
    expect(updated.brief.campaignMessage).toBe("Updated message");
    expect(updated.revision).toBe(hashBytes(Buffer.from(dumpBrief(updated.brief), "utf8")));

    const { rows } = await db.query<{ version: number }>(
      `select bv.version from brief_version bv
         join campaign c on c.id = bv.campaign_id
        where c.org_id = 'local' and c.slug = 'test-camp'
        order by bv.version`,
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  test("rewriteBrief refuses a stale expectedRevision with ECONFLICT naming the current revision, and adds no version row", async () => {
    const created = await store.createBrief(minimalBrief);
    const second = await store.rewriteBrief(brief("test-camp", "v2"), {
      expectedRevision: created.revision,
    });

    const stale = store.rewriteBrief(brief("test-camp", "v3-stale"), {
      expectedRevision: created.revision,
    });
    await expect(stale).rejects.toMatchObject({ code: "ECONFLICT", revision: second.revision });

    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int from brief_version bv
         join campaign c on c.id = bv.campaign_id
        where c.org_id = 'local' and c.slug = 'test-camp'`,
    );
    expect(rows[0]!.count).toBe(2);
  });

  test("every write adds exactly one brief_version row, with the store's actor and the next version number", async () => {
    const actorStore = new PgBriefStore(db, "local", "reviewer-2");
    await actorStore.createBrief(minimalBrief);
    await actorStore.rewriteBrief(brief("test-camp", "v2"));
    await actorStore.rewriteBrief(brief("test-camp", "v3"));

    const { rows } = await db.query<{ version: number; actor: string }>(
      `select bv.version, bv.actor from brief_version bv
         join campaign c on c.id = bv.campaign_id
        where c.org_id = 'local' and c.slug = 'test-camp'
        order by bv.version`,
    );
    expect(rows).toEqual([
      { version: 1, actor: "reviewer-2" },
      { version: 2, actor: "reviewer-2" },
      { version: 3, actor: "reviewer-2" },
    ]);
  });

  test("replaceBrief creates when the slug is missing and rewrites when it already exists", async () => {
    const created = await store.replaceBrief(minimalBrief);
    expect(created.file).toBe("test-camp.yaml");

    const replaced = await store.replaceBrief(brief("test-camp", "Replaced"));
    expect(replaced.brief.campaignMessage).toBe("Replaced");

    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int from campaign where org_id = 'local' and slug = 'test-camp'`,
    );
    expect(rows[0]!.count).toBe(1);
  });

  test("replaceBrief propagates a non-ENOENT error such as ECONFLICT", async () => {
    await store.createBrief(minimalBrief);
    await expect(
      store.replaceBrief(minimalBrief, { expectedRevision: "wrong-revision" }),
    ).rejects.toMatchObject({ code: "ECONFLICT" });
  });

  test("getRevision and exists answer the current revision, or absence", async () => {
    expect(await store.exists("test-camp")).toBe(false);
    const created = await store.createBrief(minimalBrief);
    expect(await store.getRevision("test-camp")).toBe(created.revision);
    expect(await store.getRevision("test-camp.yaml")).toBe(created.revision);
    expect(await store.exists("test-camp")).toBe(true);
  });

  test("withBriefLock serialises critical sections per brief id", async () => {
    const order: string[] = [];
    let unlock: () => void = () => {};
    const lock = new Promise<void>((r) => (unlock = r));

    const p1 = store.withBriefLock("camp", async () => {
      await lock;
      order.push("p1");
    });
    const p2 = store.withBriefLock("camp", async () => {
      order.push("p2");
    });
    const pOther = store.withBriefLock("other", async () => {
      order.push("pOther");
    });

    await pOther;
    expect(order).toEqual(["pOther"]);
    unlock();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["pOther", "p1", "p2"]);
  });
});

describe("STORE_BACKEND=postgres puts briefs in the database, one store per (org, user) (PT-3d)", () => {
  const saved = process.env.STORE_BACKEND;

  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
    resetBriefStore();
    resetDatabase();
  });

  test("the default is the file store", () => {
    delete process.env.STORE_BACKEND;
    expect(getBriefStore(LOCAL_TENANT)).toBeInstanceOf(FsBriefStore);
  });

  test("postgres builds a database store per (org, user), and the store's actor is the user", async () => {
    const db = await migratedDatabase();
    setDatabase(db);
    process.env.STORE_BACKEND = "postgres";

    const local = getBriefStore(LOCAL_TENANT);
    expect(local).toBeInstanceOf(PgBriefStore);
    expect(getBriefStore(LOCAL_TENANT)).toBe(local);

    const secondUser = { ...LOCAL_TENANT, userId: "u2" };
    const other = getBriefStore(secondUser);
    expect(other).not.toBe(local);

    await other.createBrief(minimalBrief);
    const { rows } = await db.query<{ actor: string }>(
      `select bv.actor from brief_version bv
         join campaign c on c.id = bv.campaign_id
        where c.org_id = 'local' and c.slug = 'test-camp'`,
    );
    expect(rows).toEqual([{ actor: "u2" }]);

    await db.end();
  });
});
