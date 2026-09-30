import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief } from "@campaignfoundry/shared";
import type { SqlClient } from "../../db/sql-client.js";
import { emptyDatabase, migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
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
       values ($1, 1, $2, $3, $4)`,
      [rows[0]!.id, JSON.stringify({ id: "bad" }), "deadbeef", "local"],
    );

    const list = await store.listBriefs();
    expect(list.map((entry) => entry.brief.id)).toEqual(["good"]);
  });

  // jsonb re-serialises a nested object's own keys into its own order on
  // storage — the bug this test guards against. `body` is `text`, storing
  // exactly the `JSON.stringify(brief)` bytes the write took, so a round trip
  // through createBrief/rewriteBrief/readBrief never reorders a product's keys.
  test("a brief with non-alphabetical nested keys reads back with the same key order it was written with", async () => {
    const withOrderedProduct: CampaignBrief = {
      ...minimalBrief,
      products: [
        {
          logoPath: "logo.png",
          id: "prod-1",
          primaryColor: "#1473E6",
          name: "Product 1",
        } as CampaignBrief["products"][0],
      ],
    };
    await store.createBrief(withOrderedProduct);
    const read = await store.readBrief("test-camp");
    expect(Object.keys(read.products[0]!)).toEqual(["logoPath", "id", "primaryColor", "name"]);
    expect(JSON.stringify(read.products[0])).toBe(JSON.stringify(withOrderedProduct.products[0]));
  });

  test("findBriefById finds a brief by its slug, and findBriefFileById answers its file key", async () => {
    await store.createBrief(minimalBrief);
    const found = await store.findBriefById("test-camp");
    expect(found?.file).toBe("test-camp.yaml");
    expect(found?.brief.id).toBe("test-camp");
    expect(await store.findBriefFileById("test-camp")).toBe("test-camp.yaml");
  });

  test("findBriefFile answers the file key when .yaml is among the accepted extensions, by default or explicitly", async () => {
    await store.createBrief(minimalBrief);
    expect(await store.findBriefFile("test-camp")).toBe("test-camp.yaml");
    expect(await store.findBriefFile("test-camp", [".yml", ".yaml"])).toBe("test-camp.yaml");
  });

  test("findBriefFile answers undefined when .yaml is not among the accepted extensions, even for an existing brief", async () => {
    await store.createBrief(minimalBrief);
    expect(await store.findBriefFile("test-camp", [".yml", ".json"])).toBeUndefined();
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

  // D177 (PT-5b2): `POST /campaigns` mints a campaign row with no version yet
  // (createCampaign, below). This Save is that row's first — it must add
  // version 1 to it, never refuse the slug as taken the way a genuinely
  // existing brief still does.
  describe("createBrief on a versionless campaign row (D177, PT-5b2)", () => {
    test("adds version 1 to an existing row that has none, instead of EEXIST", async () => {
      await db.query("insert into campaign (org_id, slug) values ($1, $2)", ["local", "test-camp"]);

      const created = await store.createBrief(minimalBrief);
      expect(created.campaignId).toBeTruthy();
      expect(created.brief.id).toBe("test-camp");

      const { rows } = await db.query<{ version: number }>(
        `select bv.version from brief_version bv
           join campaign c on c.id = bv.campaign_id
          where c.org_id = 'local' and c.slug = 'test-camp'`,
      );
      expect(rows).toEqual([{ version: 1 }]);
    });

    test("a row that already has a version is still refused as EEXIST", async () => {
      await store.createBrief(minimalBrief);
      await expect(store.createBrief(minimalBrief)).rejects.toMatchObject({ code: "EEXIST" });
    });

    test("preserves the team createCampaign assigned when the Save passes no teamId", async () => {
      await db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team 1", "local"],
      );
      await db.query("insert into campaign (org_id, slug, team_id) values ($1, $2, $3)", [
        "local",
        "test-camp",
        "t1",
      ]);
      const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
      const member = new PgBriefStore(db, "local", "u2", [], ["t1"]);
      const stranger = new PgBriefStore(db, "local", "u3", [], []);

      await owner.createBrief(minimalBrief);

      expect(await stranger.campaignVisibility("test-camp")).toBe("hidden");
      expect((await member.findBriefById("test-camp"))?.brief.id).toBe("test-camp");
    });

    test("an explicit teamId on the first Save assigns it", async () => {
      await db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team 1", "local"],
      );
      await db.query("insert into campaign (org_id, slug) values ($1, $2)", ["local", "test-camp"]);
      const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
      const stranger = new PgBriefStore(db, "local", "u3", [], []);

      await owner.createBrief(minimalBrief, { teamId: "t1" });

      expect(await stranger.campaignVisibility("test-camp")).toBe("hidden");
    });

    test("a row hidden from this caller by team is still refused as EEXIST, never overwritten", async () => {
      await db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team 1", "local"],
      );
      await db.query("insert into campaign (org_id, slug, team_id) values ($1, $2, $3)", [
        "local",
        "test-camp",
        "t1",
      ]);
      const stranger = new PgBriefStore(db, "local", "u3", [], []);

      await expect(stranger.createBrief(minimalBrief)).rejects.toMatchObject({ code: "EEXIST" });
      const { rows } = await db.query<{ count: number }>(
        `select count(*)::int from brief_version bv
           join campaign c on c.id = bv.campaign_id
          where c.org_id = 'local' and c.slug = 'test-camp'`,
      );
      expect(rows[0]!.count).toBe(0);
    });
  });

  // D177 (PT-5b2, coordinator follow-up): `rewriteBrief`'s own "versions[0]!"
  // assumed createBrief always wrote version 1 first — no longer true once a
  // blank `POST /campaigns` create can leave a row with none. Answering
  // ENOENT here (exactly like a genuinely missing row) is what lets
  // `replaceBrief`'s existing ENOENT-falls-to-create branch complete the
  // row's first Save, and what lets `PUT /campaigns/briefs/:id` 404 instead
  // of crashing.
  describe("rewriteBrief and replaceBrief on a versionless campaign row (D177, PT-5b2)", () => {
    test("rewriteBrief answers ENOENT, not a crash", async () => {
      await db.query("insert into campaign (org_id, slug) values ($1, $2)", ["local", "test-camp"]);

      await expect(store.rewriteBrief(minimalBrief)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("replaceBrief falls through to createBrief, adding version 1", async () => {
      await db.query("insert into campaign (org_id, slug) values ($1, $2)", ["local", "test-camp"]);

      const replaced = await store.replaceBrief(minimalBrief);
      expect(replaced.brief.id).toBe("test-camp");

      const { rows } = await db.query<{ version: number }>(
        `select bv.version from brief_version bv
           join campaign c on c.id = bv.campaign_id
          where c.org_id = 'local' and c.slug = 'test-camp'`,
      );
      expect(rows).toEqual([{ version: 1 }]);
    });
  });

  describe("campaignTeam (PT-5b2 fix-round item 1)", () => {
    test("answers null for an org-wide campaign, the team id for a team-scoped one", async () => {
      await db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team 1", "local"],
      );
      const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
      await owner.createBrief(brief("org-wide"));
      await owner.createBrief(brief("teamed"), { teamId: "t1" });

      expect(await owner.campaignTeam("org-wide")).toBeNull();
      expect(await owner.campaignTeam("teamed")).toBe("t1");
    });

    test("answers undefined for an absent slug, and for one hidden by team", async () => {
      await db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team 1", "local"],
      );
      await store.createBrief(brief("teamed"), { teamId: "t1" });
      const outsider = new PgBriefStore(db, "local", "u2", [], ["t2"]);

      expect(await store.campaignTeam("nope")).toBeUndefined();
      expect(await outsider.campaignTeam("teamed")).toBeUndefined();
    });
  });

  describe("createCampaign (D177, PT-5b2)", () => {
    test("mints a campaign row with no version yet", async () => {
      const created = await store.createCampaign("fresh-slug");
      expect(created).toEqual({ campaignId: expect.any(String), slug: "fresh-slug" });

      const { rows } = await db.query<{ count: number }>(
        `select count(*)::int from brief_version where campaign_id = $1`,
        [created.campaignId],
      );
      expect(rows[0]!.count).toBe(0);
      expect(await store.findBriefById("fresh-slug")).toBeUndefined();
      expect(await store.campaignVisibility("fresh-slug")).toBe("visible");
    });

    test("a taken slug is EEXIST, whether the existing row has a version or not", async () => {
      await store.createCampaign("taken-blank");
      await expect(store.createCampaign("taken-blank")).rejects.toMatchObject({ code: "EEXIST" });

      await store.createBrief(brief("taken-versioned"));
      await expect(store.createCampaign("taken-versioned")).rejects.toMatchObject({
        code: "EEXIST",
      });
    });

    test.each(["cache", "jobs", "orgs", "packages"] as const)(
      "refuses a reserved campaign id %s",
      async (id) => {
        await expect(store.createCampaign(id)).rejects.toThrow(
          `"${id}" is reserved; choose another campaign id.`,
        );
      },
    );

    test("refuses an unsafe id", async () => {
      await expect(store.createCampaign("../evil")).rejects.toThrow(/not a safe id/);
    });

    test("honours teamId exactly like createBrief's", async () => {
      await db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team 1", "local"],
      );
      const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
      const stranger = new PgBriefStore(db, "local", "u3", [], []);

      await owner.createCampaign("team-slug", { teamId: "t1" });

      expect(await stranger.campaignVisibility("team-slug")).toBe("hidden");
    });

    test("an unknown team id refuses (EFORBIDDEN), and mints no row", async () => {
      const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
      await expect(owner.createCampaign("no-team", { teamId: "ghost" })).rejects.toMatchObject({
        code: "EFORBIDDEN",
      });
      expect(await owner.campaignVisibility("no-team")).toBe("absent");
    });

    test("two concurrent creates of the same slug: exactly one wins, the other retries", async () => {
      const results = await Promise.allSettled([
        store.createCampaign("race-slug"),
        store.createCampaign("race-slug"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "EEXIST" });
    });

    test("stores the display name and type (PT-5b3, D168, D177)", async () => {
      const created = await store.createCampaign("named-slug", {
        name: "My Campaign",
        type: "paid-social",
      });
      const { rows } = await db.query<{ name: string | null; type: string | null }>(
        `select name, type from campaign where id = $1`,
        [created.campaignId],
      );
      expect(rows[0]).toEqual({ name: "My Campaign", type: "paid-social" });
    });

    test("stores null name and type when options omit them (PT-5b3)", async () => {
      const created = await store.createCampaign("blank-meta");
      const { rows } = await db.query<{ name: string | null; type: string | null }>(
        `select name, type from campaign where id = $1`,
        [created.campaignId],
      );
      expect(rows[0]).toEqual({ name: null, type: null });
    });
  });

  describe("releaseCampaign (PT-5b2 fix-round item 2)", () => {
    test("deletes a versionless row and answers true", async () => {
      await store.createCampaign("mint-only");
      expect(await store.releaseCampaign("mint-only")).toBe(true);
      const { rows } = await db.query<{ count: number }>(
        `select count(*)::int from campaign where org_id = 'local' and slug = 'mint-only'`,
      );
      expect(rows[0]!.count).toBe(0);
    });

    test("leaves a versioned row untouched and answers false", async () => {
      await store.createBrief(minimalBrief);
      expect(await store.releaseCampaign("test-camp")).toBe(false);
      expect(await store.findBriefById("test-camp")).toMatchObject({ brief: { id: "test-camp" } });
    });

    test("answers false for a slug that was never reserved", async () => {
      expect(await store.releaseCampaign("nope")).toBe(false);
    });
  });

  describe("campaignMeta (PT-5b3, D168, D177)", () => {
    test("answers undefined for an unknown slug or uuid", async () => {
      expect(await store.campaignMeta("nope")).toBeUndefined();
      expect(await store.campaignMeta("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    });

    test("a versionless create answers its recorded name/type by slug and by uuid, hasVersion: false", async () => {
      const created = await store.createCampaign("versionless", {
        name: "Versionless",
        type: "short-video",
      });
      const expected = {
        campaignId: created.campaignId,
        slug: "versionless",
        name: "Versionless",
        type: "short-video",
        hasVersion: false,
      };
      expect(await store.campaignMeta("versionless")).toEqual(expected);
      expect(await store.campaignMeta(created.campaignId)).toEqual(expected);
    });

    test("a pre-lane campaign (created with no name/type) answers null name/type and hasVersion: true", async () => {
      const created = await store.createBrief(minimalBrief);
      expect(await store.campaignMeta("test-camp")).toEqual({
        campaignId: created.campaignId,
        slug: "test-camp",
        name: null,
        type: null,
        hasVersion: true,
      });
    });

    test("saving a version never clears the name/type recorded at create (item 4)", async () => {
      await store.createCampaign("first-save-meta", { name: "First Save", type: "display-ad" });
      const created = await store.createBrief(brief("first-save-meta"));
      expect(await store.campaignMeta("first-save-meta")).toEqual({
        campaignId: created.campaignId,
        slug: "first-save-meta",
        name: "First Save",
        type: "display-ad",
        hasVersion: true,
      });
    });

    test("another org's and a hidden campaign's refs are undefined, by slug and by uuid", async () => {
      await db.query("insert into org (id, name) values ($1, $2)", ["other", "Other"]);
      const otherStore = new PgBriefStore(db, "other", "local");
      const otherCreated = await otherStore.createCampaign("other-camp", { name: "Other" });
      expect(await store.campaignMeta("other-camp")).toBeUndefined();
      expect(await store.campaignMeta(otherCreated.campaignId)).toBeUndefined();

      await db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t-secret", "Secret", "local"],
      );
      const adminStore = new PgBriefStore(db, "local", "admin", ["admin"]);
      const hidden = await adminStore.createCampaign("hidden-camp", {
        name: "Hidden",
        teamId: "t-secret",
      });
      const outsider = new PgBriefStore(db, "local", "u2", [], ["t-other"]);
      expect(await outsider.campaignMeta("hidden-camp")).toBeUndefined();
      expect(await outsider.campaignMeta(hidden.campaignId)).toBeUndefined();
      expect(await adminStore.campaignMeta("hidden-camp")).toEqual({
        campaignId: hidden.campaignId,
        slug: "hidden-camp",
        name: "Hidden",
        type: null,
        hasVersion: false,
      });
    });
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

  test("a rejected fn does not poison withBriefLock's chain for the next caller", async () => {
    await expect(
      store.withBriefLock("camp", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(store.withBriefLock("camp", async () => "after")).resolves.toBe("after");
  });

  test.each(["cache", "jobs", "orgs", "packages"] as const)(
    "createBrief and replaceBrief on non-existent brief refuse reserved campaign id %s",
    async (id) => {
      const b = brief(id);
      await expect(store.createBrief(b)).rejects.toThrow(
        `"${id}" is reserved; choose another campaign id.`,
      );
      await expect(store.replaceBrief(b)).rejects.toThrow(
        `"${id}" is reserved; choose another campaign id.`,
      );
    },
  );

  test("stored brief with reserved id lists, reads, rewrites and replaces", async () => {
    const { rows } = await db.query<{ id: string }>(
      "insert into campaign (org_id, slug) values ($1, $2) returning id",
      ["local", "cache"],
    );
    await db.query(
      `insert into brief_version (campaign_id, version, body, revision, actor)
       values ($1, 1, $2, $3, $4)`,
      [rows[0]!.id, JSON.stringify(brief("cache")), "deadbeef", "local"],
    );

    expect(await store.exists("cache")).toBe(true);
    expect(await store.findBriefFileById("cache")).toBe("cache.yaml");
    expect(await store.findBriefFile("cache")).toBe("cache.yaml");
    expect(await store.getRevision("cache")).toBe("deadbeef");
    expect(await store.campaignVisibility("cache")).toBe("visible");

    const list = await store.listBriefs();
    expect(list.some((entry) => entry.brief.id === "cache")).toBe(true);

    const read = await store.readBrief("cache");
    expect(read.id).toBe("cache");

    const rewritten = await store.rewriteBrief(brief("cache", "Updated cache"));
    expect(rewritten.brief.campaignMessage).toBe("Updated cache");

    const replaced = await store.replaceBrief(brief("cache", "Replaced cache"));
    expect(replaced.brief.campaignMessage).toBe("Replaced cache");
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

  // A ":" in an id must not let one (org, user) pair alias another. Naive
  // string concatenation ("postgres:" + orgId + ":" + userId) collides here:
  // ctxA's "local" + "x:y" and ctxB's "local:x" + "y" both concatenate to the
  // identical string "postgres:local:x:y". JSON-encoding the triple, decoded
  // with JSON.parse, cannot: a quoted string's ":" is never a delimiter.
  test("an orgId or userId containing ':' round-trips to its own store, not a colliding one", async () => {
    const db = await migratedDatabase();
    setDatabase(db);
    process.env.STORE_BACKEND = "postgres";

    const ctxA = { ...LOCAL_TENANT, orgId: "local", userId: "x:y" };
    const ctxB = { ...LOCAL_TENANT, orgId: "local:x", userId: "y" };
    expect(getBriefStore(ctxA)).not.toBe(getBriefStore(ctxB));

    // The realistic side (a real, FK-valid org) decodes correctly: the actor
    // written is exactly the colon-bearing userId, not a truncation of it.
    await getBriefStore(ctxA).createBrief(minimalBrief);
    const { rows } = await db.query<{ actor: string }>(
      `select bv.actor from brief_version bv
         join campaign c on c.id = bv.campaign_id
        where c.org_id = 'local' and c.slug = 'test-camp'`,
    );
    expect(rows).toEqual([{ actor: "x:y" }]);

    await db.end();
  });
});

/** Insert both test teams with the columns 0008 requires ("memberCount" quoted camelCase). */
async function seedTeams(db: SqlClient, orgId = "local"): Promise<void> {
  await db.query(
    `insert into team (id, name, "memberCount", org_id, created_at) values
       ($1, $2, 0, $3, now()),
       ($4, $5, 0, $3, now())`,
    ["t1", "Team One", orgId, "t2", "Team Two"],
  );
}

describe("Team scope on Postgres (D166, PT-2c)", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await migratedDatabase();
    await seedTeams(db);
  });
  afterEach(async () => {
    await db.end();
  });

  test("a campaign with no team is visible to any caller, regardless of role or team", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("org-wide"));

    const stranger = new PgBriefStore(db, "local", "u2", [], []);
    expect((await stranger.findBriefById("org-wide"))?.brief.id).toBe("org-wide");
    expect((await stranger.listBriefs()).map((b) => b.brief.id)).toContain("org-wide");
  });

  test("a member of the campaign's own team sees it, findBriefById and listBriefs both", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("t1-camp"), { teamId: "t1" });

    const member = new PgBriefStore(db, "local", "u1", [], ["t1"]);
    expect((await member.findBriefById("t1-camp"))?.brief.id).toBe("t1-camp");
    expect((await member.listBriefs()).map((b) => b.brief.id)).toContain("t1-camp");
  });

  // The mutation manifest anchors on listBriefs' team predicate: drop it and
  // this test's listBriefs assertion fails, because the outsider's listing
  // would then include a campaign belonging to a team they are not in.
  test("a member of another team cannot see the campaign, in findBriefById or listBriefs", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("t1-camp"), { teamId: "t1" });

    const outsider = new PgBriefStore(db, "local", "u2", [], ["t2"]);
    expect(await outsider.findBriefById("t1-camp")).toBeUndefined();
    expect((await outsider.listBriefs()).map((b) => b.brief.id)).not.toContain("t1-camp");
  });

  test("owner and admin roles see every campaign regardless of team", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("t1-camp"), { teamId: "t1" });

    const admin = new PgBriefStore(db, "local", "admin-user", ["admin"], []);
    expect((await admin.findBriefById("t1-camp"))?.brief.id).toBe("t1-camp");
    expect((await owner.findBriefById("t1-camp"))?.brief.id).toBe("t1-camp");
    // D166 item 6: the same admin visibility rule holds for listBriefs, not
    // only findBriefById.
    expect((await admin.listBriefs()).map((b) => b.brief.id)).toContain("t1-camp");
    expect((await owner.listBriefs()).map((b) => b.brief.id)).toContain("t1-camp");
  });

  // D166 item 6: the migration's "on delete set null" (0011_campaign_team.sql)
  // un-scopes a team's campaigns to org-wide rather than orphaning or
  // blocking the team delete.
  test("deleting a team sets its campaigns' team_id to null", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("t1-camp"), { teamId: "t1" });

    await db.query(`delete from team where id = $1`, ["t1"]);

    const { rows } = await db.query<{ team_id: string | null }>(
      `select team_id from campaign where org_id = 'local' and slug = 't1-camp'`,
    );
    expect(rows[0]!.team_id).toBeNull();

    // Now visible to everyone again, org-wide.
    const stranger = new PgBriefStore(db, "local", "u2", [], []);
    expect((await stranger.findBriefById("t1-camp"))?.brief.id).toBe("t1-camp");
  });

  test("createBrief with a team from another org refuses (EFORBIDDEN), and writes nothing", async () => {
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
      ["acme-team", "Acme Team", "acme"],
    );
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);

    await expect(
      owner.createBrief(brief("cross-org"), { teamId: "acme-team" }),
    ).rejects.toMatchObject({
      code: "EFORBIDDEN",
    });
    expect(await owner.findBriefById("cross-org")).toBeUndefined();
  });

  // D166 item 6 (PT-2c, qodo thread U1bo): the FK on campaign.team_id must
  // itself refuse a cross-org link — not just assertTeamInOrg, which a direct
  // SQL write, an import, or a future writer could bypass entirely.
  test("the database itself refuses a cross-org campaign/team link (composite FK), bypassing assertTeamInOrg", async () => {
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
      ["acme-team", "Acme Team", "acme"],
    );
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("direct-camp"));
    const { rows } = await db.query<{ id: string }>(
      `select id from campaign where org_id = 'local' and slug = 'direct-camp'`,
    );

    await expect(
      db.query(`update campaign set team_id = $1 where id = $2`, ["acme-team", rows[0]!.id]),
    ).rejects.toThrow();
  });

  test("createBrief with an unknown team id refuses the same way", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await expect(owner.createBrief(brief("no-team"), { teamId: "ghost" })).rejects.toMatchObject({
      code: "EFORBIDDEN",
    });
  });

  test("createBrief with teamId null behaves exactly like createBrief with no options", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    const created = await owner.createBrief(brief("still-org-wide"), { teamId: null });
    expect(created.brief.id).toBe("still-org-wide");
    const stranger = new PgBriefStore(db, "local", "u2", [], []);
    expect((await stranger.findBriefById("still-org-wide"))?.brief.id).toBe("still-org-wide");
  });

  test("rewriteBrief with a teamId assigns it; a plain rewriteBrief leaves an assigned team untouched", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("camp", "v1"));
    await owner.rewriteBrief(brief("camp", "v2"), { teamId: "t1" });

    const member = new PgBriefStore(db, "local", "u1", [], ["t1"]);
    expect((await member.findBriefById("camp"))?.brief.campaignMessage).toBe("v2");

    await owner.rewriteBrief(brief("camp", "v3"));
    expect((await member.findBriefById("camp"))?.brief.campaignMessage).toBe("v3");
  });

  test("rewriteBrief with a team from another org refuses and leaves the campaign unchanged", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("camp", "v1"));

    await expect(
      owner.rewriteBrief(brief("camp", "v2"), { teamId: "ghost" }),
    ).rejects.toMatchObject({
      code: "EFORBIDDEN",
    });
    expect((await owner.findBriefById("camp"))?.brief.campaignMessage).toBe("v1");
  });

  test("rewriteBrief, with or without a teamId, refuses a campaign hidden from the caller by team, as not found", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("t2-camp"), { teamId: "t2" });

    const outsider = new PgBriefStore(db, "local", "u1", [], ["t1"]);
    await expect(outsider.rewriteBrief(brief("t2-camp", "hacked"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      outsider.rewriteBrief(brief("t2-camp", "hacked"), { teamId: "t1" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await owner.findBriefById("t2-camp"))?.brief.campaignMessage).toBe(
      "Build great things",
    );
  });

  test("replaceBrief creates with a team when the slug is missing, and rewrites with it when present", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    const created = await owner.replaceBrief(brief("replaced"), { teamId: "t1" });
    expect(created.brief.id).toBe("replaced");

    const t1Member = new PgBriefStore(db, "local", "u1", [], ["t1"]);
    expect((await t1Member.findBriefById("replaced"))?.brief.id).toBe("replaced");

    await owner.replaceBrief(brief("replaced", "v2"), { teamId: "t2" });
    expect(await t1Member.findBriefById("replaced")).toBeUndefined();
  });

  test("rewriteBrief with teamId null clears an already-assigned team back to org-wide", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("camp", "v1"), { teamId: "t1" });
    await owner.rewriteBrief(brief("camp", "v2"), { teamId: null });

    const { rows } = await db.query<{ team_id: string | null }>(
      `select team_id from campaign where org_id = 'local' and slug = 'camp'`,
    );
    expect(rows[0]!.team_id).toBeNull();
  });

  test("replaceBrief creates org-wide (null) when the slug is missing and no teamId was given", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    const created = await owner.replaceBrief(brief("fresh"), { teamId: undefined });
    expect(created.brief.id).toBe("fresh");

    const { rows } = await db.query<{ team_id: string | null }>(
      `select team_id from campaign where org_id = 'local' and slug = 'fresh'`,
    );
    expect(rows[0]!.team_id).toBeNull();
  });

  // D181 fix round 2 (qodo, HIGH/Security): replaceBrief's ENOENT-falls-to-create
  // branch used to coerce a caller's omitted teamId to null before calling
  // createBrief, clearing an EXISTING row's team on its first Save via
  // ?replace=1 — the same versionless-row grandfather shape HX1's reserved-id
  // fix exposed for the first time, but the underlying defect was general
  // (any slug whose first Save happens to use replace=1, teamed or not,
  // reserved or not).
  test("replaceBrief preserves an existing versionless row's team when its first Save passes no teamId", async () => {
    // A blank POST /campaigns create: a row with a team (seedTeams's "t1")
    // and no version yet.
    await db.query("insert into campaign (org_id, slug, team_id) values ($1, $2, $3)", [
      "local",
      "test-camp",
      "t1",
    ]);
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    const member = new PgBriefStore(db, "local", "u2", [], ["t1"]);
    const stranger = new PgBriefStore(db, "local", "u3", [], []);

    await owner.replaceBrief(minimalBrief);

    expect(await stranger.campaignVisibility("test-camp")).toBe("hidden");
    expect((await member.findBriefById("test-camp"))?.brief.id).toBe("test-camp");
  });

  test("replaceBrief propagates a non-ENOENT error such as ECONFLICT instead of falling to create", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("camp"));
    await expect(
      owner.replaceBrief(brief("camp", "v2"), { teamId: "t1", expectedRevision: "wrong-revision" }),
    ).rejects.toMatchObject({ code: "ECONFLICT" });
  });

  test("campaignVisibility tells 'absent' from 'hidden' from 'visible'", async () => {
    const owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await owner.createBrief(brief("t2-only"), { teamId: "t2" });

    const outsider = new PgBriefStore(db, "local", "u1", [], ["t1"]);
    expect(await outsider.campaignVisibility("t2-only")).toBe("hidden");
    expect(await outsider.campaignVisibility("never-created")).toBe("absent");
    expect(await owner.campaignVisibility("t2-only")).toBe("visible");
  });
});

describe("0011_campaign_team migration (D166, PT-2c)", () => {
  test("an existing null team_id survives the migration; the column becomes text with a team FK", async () => {
    const db = await emptyDatabase();
    try {
      const all = await loadMigrations();
      // Everything below 0011: a later migration applied first would make
      // migrate() refuse 0011 as out of order.
      const upTo0010 = all.filter((m) => m.id < "0011");
      await migrate(db, upTo0010);

      const { rows: inserted } = await db.query<{ id: string }>(
        `insert into campaign (org_id, slug) values ('local', 'pre-migration') returning id`,
      );

      expect((await migrate(db, all))[0]).toBe("0011_campaign_team");

      const { rows } = await db.query<{ team_id: string | null }>(
        `select team_id from campaign where id = $1`,
        [inserted[0]!.id],
      );
      expect(rows[0]!.team_id).toBeNull();

      const { rows: col } = await db.query<{ data_type: string }>(
        `select data_type from information_schema.columns
          where table_name = 'campaign' and column_name = 'team_id'`,
      );
      expect(col[0]!.data_type).toBe("text");

      const { rows: fk } = await db.query<{ conname: string }>(
        `select conname from pg_constraint where conname = 'campaign_team_id_fkey'`,
      );
      expect(fk).toHaveLength(1);
    } finally {
      await db.end();
    }
  });
});

describe("0013_campaign_meta migration (PT-5b3, D168, D177)", () => {
  test("adds nullable name and type columns; an existing row gets null for both", async () => {
    const db = await emptyDatabase();
    try {
      const all = await loadMigrations();
      // Everything below 0013: a later migration applied first would make
      // migrate() refuse 0013 as out of order.
      const upTo0012 = all.filter((m) => m.id < "0013");
      await migrate(db, upTo0012);

      const { rows: inserted } = await db.query<{ id: string }>(
        `insert into campaign (org_id, slug) values ('local', 'pre-migration') returning id`,
      );

      expect((await migrate(db, all))[0]).toBe("0013_campaign_meta");

      const { rows } = await db.query<{ name: string | null; type: string | null }>(
        `select name, type from campaign where id = $1`,
        [inserted[0]!.id],
      );
      expect(rows[0]).toEqual({ name: null, type: null });

      const { rows: cols } = await db.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_name = 'campaign' and column_name in ('name', 'type')
          order by column_name`,
      );
      expect(cols).toEqual([
        { column_name: "name", is_nullable: "YES" },
        { column_name: "type", is_nullable: "YES" },
      ]);
    } finally {
      await db.end();
    }
  });
});

describe("campaignId and resolveCampaign (PT-5a, D168, D178)", () => {
  let db: SqlClient;
  let store: PgBriefStore;

  beforeEach(async () => {
    db = await migratedDatabase();
    store = new PgBriefStore(db, "local", "local");
  });
  afterEach(async () => {
    await db.end();
  });

  test("StoredBrief carries campaignId matching campaign.id (PT-5a, D168)", async () => {
    const created = await store.createBrief(brief("alpha"));
    expect(created.campaignId).toBeDefined();
    expect(typeof created.campaignId).toBe("string");

    const { rows } = await db.query<{ id: string }>(
      `select id from campaign where org_id = 'local' and slug = 'alpha'`,
    );
    expect(created.campaignId).toBe(rows[0]!.id);

    const found = await store.findBriefById("alpha");
    expect(found?.campaignId).toBe(rows[0]!.id);

    const listed = await store.listBriefs();
    expect(listed.find((b) => b.brief.id === "alpha")?.campaignId).toBe(rows[0]!.id);

    const rewritten = await store.rewriteBrief(brief("alpha", "Updated"));
    expect(rewritten.campaignId).toBe(rows[0]!.id);

    const replaced = await store.replaceBrief(brief("alpha", "Replaced"));
    expect(replaced.campaignId).toBe(rows[0]!.id);
  });

  test("a uuid and a slug resolve to the same campaign", async () => {
    const created = await store.createBrief(brief("alpha"));
    const uuid = created.campaignId;

    const bySlug = await store.resolveCampaign("alpha");
    const byUuid = await store.resolveCampaign(uuid);

    expect(bySlug).toEqual({ campaignId: uuid, slug: "alpha" });
    expect(byUuid).toEqual({ campaignId: uuid, slug: "alpha" });
  });

  test("another org's and a hidden campaign's refs are undefined", async () => {
    // Another org's campaign
    await db.query("insert into org (id, name) values ($1, $2)", ["other", "Other"]);
    const otherStore = new PgBriefStore(db, "other", "local");
    const otherCreated = await otherStore.createBrief(brief("other-camp"));
    const otherUuid = otherCreated.campaignId;

    expect(await store.resolveCampaign("other-camp")).toBeUndefined();
    expect(await store.resolveCampaign(otherUuid)).toBeUndefined();

    // Hidden campaign (team-scoped)
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
      ["t-secret", "Secret", "local"],
    );
    const adminStore = new PgBriefStore(db, "local", "admin", ["admin"]);
    const hiddenCreated = await adminStore.createBrief(brief("hidden-camp"), {
      teamId: "t-secret",
    });
    const hiddenUuid = hiddenCreated.campaignId;

    const memberStore = new PgBriefStore(db, "local", "u1", [], ["t-other"]);
    expect(await memberStore.resolveCampaign("hidden-camp")).toBeUndefined();
    expect(await memberStore.resolveCampaign(hiddenUuid)).toBeUndefined();

    // Positive control: admin can see it
    expect(await adminStore.resolveCampaign("hidden-camp")).toEqual({
      campaignId: hiddenUuid,
      slug: "hidden-camp",
    });
    expect(await adminStore.resolveCampaign(hiddenUuid)).toEqual({
      campaignId: hiddenUuid,
      slug: "hidden-camp",
    });
  });

  test("an uppercase uuid resolves like its lowercase form", async () => {
    const created = await store.createBrief(brief("alpha"));
    expect(await store.resolveCampaign(created.campaignId.toUpperCase())).toEqual({
      campaignId: created.campaignId,
      slug: "alpha",
    });
  });

  test("a hidden campaign's uuid does not mask a visible campaign whose slug is that uuid", async () => {
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
      ["t-secret", "Secret", "local"],
    );
    const adminStore = new PgBriefStore(db, "local", "admin", ["admin"]);
    const hidden = await adminStore.createBrief(brief("hidden-camp"), { teamId: "t-secret" });
    // A visible, org-wide campaign whose slug is the hidden campaign's uuid.
    const visible = await adminStore.createBrief(brief(hidden.campaignId));

    const memberStore = new PgBriefStore(db, "local", "u1", [], ["t-other"]);
    // Hidden reads as missing, so the ref falls through to the slug: the member
    // gets the visible campaign, exactly as if the hidden one did not exist.
    expect(await memberStore.resolveCampaign(hidden.campaignId)).toEqual({
      campaignId: visible.campaignId,
      slug: hidden.campaignId,
    });
    // The admin, who can see the hidden campaign, still gets the uuid match.
    expect(await adminStore.resolveCampaign(hidden.campaignId)).toEqual({
      campaignId: hidden.campaignId,
      slug: "hidden-camp",
    });
  });

  test("a lowercase uuid that is also a legal slug resolves as the uuid first", async () => {
    // Campaign A has id = uuidA, slug = "slug-a"
    const campA = await store.createBrief(brief("slug-a"));
    const uuidA = campA.campaignId;

    // Campaign B has id = uuidB, slug = uuidA (slug of B is uuid of A)
    const campB = await store.createBrief(brief(uuidA));
    const uuidB = campB.campaignId;

    // Resolving uuidA must resolve to Campaign A (uuid wins over slug)
    const resolvedA = await store.resolveCampaign(uuidA);
    expect(resolvedA).toEqual({ campaignId: uuidA, slug: "slug-a" });

    // Resolving uuidB resolves to Campaign B
    const resolvedB = await store.resolveCampaign(uuidB);
    expect(resolvedB).toEqual({ campaignId: uuidB, slug: uuidA });

    // If a slug happens to look like a uuid but NO campaign exists with that uuid,
    // it falls back to the slug
    const unusedUuid = "11111111-2222-3333-4444-555555555555";
    const campC = await store.createBrief(brief(unusedUuid));
    const resolvedC = await store.resolveCampaign(unusedUuid);
    expect(resolvedC).toEqual({ campaignId: campC.campaignId, slug: unusedUuid });
  });

  test("a non-uuid slug never causes postgres syntax error and missing ref is undefined", async () => {
    expect(await store.resolveCampaign("non-existent-slug")).toBeUndefined();
    expect(await store.resolveCampaign("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });
});
