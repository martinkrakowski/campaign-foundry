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
import { BriefRefNotFoundError } from "../../brief-asset-refs.js";
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

  test("two instances, same org, different actors, same brief id: the second waits for the first", async () => {
    const order: string[] = [];
    let unlock: () => void = () => {};
    const lock = new Promise<void>((r) => (unlock = r));
    const other = new PgBriefStore(db, "local", "other");

    const p1 = store.withBriefLock("shared-camp", async () => {
      await lock;
      order.push("p1");
    });
    const p2 = other.withBriefLock("shared-camp", async () => {
      order.push("p2");
    });
    const pOther = other.withBriefLock("shared-other", async () => {
      order.push("pOther");
    });

    await pOther;
    expect(order).toEqual(["pOther"]);
    unlock();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["pOther", "p1", "p2"]);
  });

  test("two instances, different orgs, same brief id: neither waits for the other", async () => {
    const order: string[] = [];
    let unlock: () => void = () => {};
    const held = new Promise<void>((r) => (unlock = r));
    const otherOrg = new PgBriefStore(db, "other-org", "local");

    const p1 = store.withBriefLock("cross-org-camp", async () => {
      await held;
      order.push("p1");
    });
    const p2 = otherOrg.withBriefLock("cross-org-camp", async () => {
      order.push("p2");
    });

    await Promise.race([p1, p2]);
    expect(order).toEqual(["p2"]);
    unlock();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["p2", "p1"]);
  });

  test("a rejected fn on one instance does not reject the next call on the other instance", async () => {
    const other = new PgBriefStore(db, "local", "other");

    await expect(
      store.withBriefLock("shared-poison", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(other.withBriefLock("shared-poison", async () => "after")).resolves.toBe("after");
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
    // A legacy pair: a slug equal to another campaign's uuid can no longer be created
    // through the store (FU-slug-uuid-409), so the row is planted and then Saved into.
    await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, [
      "local",
      hidden.campaignId,
    ]);
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

    // A legacy pair: a slug equal to another campaign's uuid can no longer be created
    // through the store (FU-slug-uuid-409), so the row is planted and then Saved into.
    await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, ["local", uuidA]);

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

/**
 * The tombstone (PT-9a1, D231, D233). Every case here plants `deleted_at` with
 * raw SQL on the harness's own database — the writers are lanes 9f/9g/9l/9m, and
 * no port writes the column yet, so a fixture that went through one would be
 * testing a lane that does not exist.
 *
 * The claim under all of it is that a tombstone reads as ABSENCE at every reader,
 * with the one deliberate exception of `campaignVisibility`, which says "hidden"
 * (D233 r2) because `campaignKnown` reads "absent" as "never created" and falls
 * through to its slug-keyed `report`/`asset` fallback — which a deleted,
 * ever-generated campaign still has rows in.
 */
describe("the campaign tombstone (PT-9a1, D231, D233)", () => {
  let db: SqlClient;
  let owner: PgBriefStore;

  beforeEach(async () => {
    db = await migratedDatabase();
    await seedTeams(db);
    owner = new PgBriefStore(db, "local", "owner", ["owner"], []);
  });
  afterEach(async () => {
    await db.end();
  });

  /** One saved version, then the tombstone: a campaign nobody has purged yet. */
  const tombstone = async (slug: string): Promise<string> => {
    const stored = await owner.createBrief(brief(slug));
    await db.query(`update campaign set deleted_at = now() where org_id = $1 and slug = $2`, [
      "local",
      slug,
    ]);
    return stored.campaignId!;
  };

  test("every brief reader answers a tombstoned campaign absent", async () => {
    const uuid = await tombstone("gone");

    expect(await owner.campaignTeam("gone")).toBeUndefined();
    expect(await owner.resolveCampaign("gone")).toBeUndefined();
    expect(await owner.resolveCampaign(uuid)).toBeUndefined();
    expect(await owner.listBriefs()).toEqual([]);
    expect(await owner.findBriefById("gone")).toBeUndefined();
    expect(await owner.getRevision("gone")).toBeUndefined();
    expect(await owner.exists("gone")).toBe(false);
    expect(await owner.campaignMeta("gone")).toBeUndefined();
    expect(await owner.campaignMeta(uuid)).toBeUndefined();
    // `readBrief` refuses rather than answering absence — ENOENT for a row no
    // reader can see, the same as for a slug never created. (`rewriteBrief`'s
    // own refusal is its own test below, which also asserts nothing was written.)
    await expect(owner.readBrief("gone")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a live campaign's readers are unchanged by the tombstone's presence", async () => {
    // The unchanged-behaviour control, and it is the one that can catch a filter
    // that over-reaches: a second, live campaign in the same org must be served
    // in full while a tombstoned sibling of the same shape sits beside it.
    await tombstone("gone");
    const live = await owner.createBrief(brief("live"));

    expect(await owner.campaignTeam("live")).toBeNull();
    expect(await owner.resolveCampaign("live")).toEqual({
      campaignId: live.campaignId,
      slug: "live",
    });
    expect((await owner.listBriefs()).map((b) => b.brief.id)).toEqual(["live"]);
    expect((await owner.findBriefById("live"))?.brief.id).toBe("live");
    expect(await owner.getRevision("live")).toBe(live.revision);
    expect(await owner.exists("live")).toBe(true);
    expect(await owner.campaignMeta("live")).toMatchObject({ slug: "live", hasVersion: true });
    expect(await owner.campaignMeta(live.campaignId!)).toMatchObject({ slug: "live" });
  });

  test("rewriteBrief answers notFound for a tombstoned slug, exactly as for a missing one", async () => {
    await tombstone("gone");
    await expect(owner.rewriteBrief(brief("gone", "v2"))).rejects.toMatchObject({ code: "ENOENT" });
    // And the refusal wrote nothing: the tombstoned campaign keeps its one
    // version, so a later reader that un-tombstones cannot find a v2.
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from brief_version bv
         join campaign c on c.id = bv.campaign_id where c.org_id = 'local' and c.slug = 'gone'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  // D233 r2: "hidden", not "absent" — the mechanism is `ownership.ts`'s
  // `campaignKnown` fallback, and the consequence is a deleted, ever-generated
  // campaign keeping serving its slug-keyed report. "Absent" is how this method
  // says "never created", which is the one case where that fallback is wanted.
  test("a tombstoned campaign answers hidden by slug", async () => {
    await tombstone("gone");
    expect(await owner.campaignVisibility("gone")).toBe("hidden");
  });

  test("a tombstoned campaign answers hidden by uuid", async () => {
    const uuid = await tombstone("gone");
    // The uuid ref, not the slug: this is the shape every route actually sends.
    // `resolveCampaign` is itself filtered, so it answers `undefined`, and
    // `result.get.ts`'s `resolved?.slug ?? campaignId` hands the RAW UUID TEXT to
    // this method — a slug-only query finds nothing for that text and would say
    // "absent", reopening the report fallback for a deleted campaign.
    expect(await owner.campaignVisibility(uuid)).toBe("hidden");
  });

  test("a team-hidden but NOT tombstoned uuid ref still answers hidden", async () => {
    // The control for the new uuid branch: it must not have changed the existing
    // by-team answer, which used to reach it through the slug query.
    const created = await owner.createBrief(brief("t2-only"), { teamId: "t2" });
    const outsider = new PgBriefStore(db, "local", "u1", [], ["t1"]);
    expect(await outsider.campaignVisibility(created.campaignId!)).toBe("hidden");
    expect(await owner.campaignVisibility(created.campaignId!)).toBe("visible");
  });

  test("campaignVisibility by uuid: a live campaign answers visible and an unknown uuid answers absent (tombstone-branch controls)", async () => {
    // The two arms of the new uuid branch that are NOT "hidden", which no route
    // can reach: every caller passes `resolved?.slug ?? ref`, so a uuid only
    // arrives here when `resolveCampaign` found nothing. Without these the branch
    // is uncovered below the 100% threshold, and the "live campaign answers
    // visible by uuid" half is the only observable change for a live campaign.
    const stored = await owner.createBrief(brief("live"));
    expect(await owner.campaignVisibility(stored.campaignId!)).toBe("visible");
    // The uuid branch misses, and the slug branch it falls through to misses too.
    expect(await owner.campaignVisibility("00000000-0000-4000-8000-000000000000")).toBe("absent");
  });

  test("a visible campaign whose slug is a tombstoned campaign's uuid answers visible", async () => {
    // Qodo on #680: an id match the caller may not see must fall through to the slug
    // lookup, as `resolveCampaign` does, or the visible campaign that `resolveCampaign`
    // DID resolve would 404 on every route that re-checks its slug.
    const uuid = await tombstone("gone");
    // A legacy pair: a slug equal to another campaign's uuid can no longer be created
    // through the store (FU-slug-uuid-409), so the row is planted and then Saved into.
    await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, ["local", uuid]);
    await owner.createBrief(brief(uuid));
    expect(await owner.campaignVisibility(uuid)).toBe("visible");
  });

  test("a visible campaign whose slug is a team-hidden campaign's uuid answers visible to the outsider", async () => {
    const hidden = await owner.createBrief(brief("t2-only"), { teamId: "t2" });
    // A legacy pair: a slug equal to another campaign's uuid can no longer be created
    // through the store (FU-slug-uuid-409), so the row is planted and then Saved into.
    await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, [
      "local",
      hidden.campaignId,
    ]);
    await owner.createBrief(brief(hidden.campaignId!));
    const outsider = new PgBriefStore(db, "local", "u1", [], ["t1"]);
    expect(await outsider.campaignVisibility(hidden.campaignId!)).toBe("visible");
  });

  test("releaseCampaign leaves a tombstoned versionless row for the purge", async () => {
    // Qodo on #680: a sourced create whose first Save loses the race to a tombstone
    // calls releaseCampaign from its error handler; the row must survive for the
    // queued purge, its slug still taken.
    await owner.createCampaign("blank");
    await db.query(`update campaign set deleted_at = now() where org_id = $1 and slug = $2`, [
      "local",
      "blank",
    ]);
    expect(await owner.releaseCampaign("blank")).toBe(false);
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from campaign where org_id = 'local' and slug = 'blank'`,
    );
    expect(rows[0]!.count).toBe(1);
  });

  // PT-9-2, D233: the race backstop. `createBrief`'s conflict branch reads the
  // row UNFILTERED (filtering it would leave `existing` empty right after the
  // insert's own conflict proved the row exists) and throws EEXIST on a
  // tombstone — before the version-count read, which is what stops a first-ever
  // Save writing version 1 into a tombstoned, versionless row.
  test("a first-ever Save against a tombstoned blank mint throws EEXIST, having written no version", async () => {
    const { campaignId } = await owner.createCampaign("blank");
    await db.query(`update campaign set deleted_at = now() where org_id = $1 and slug = $2`, [
      "local",
      "blank",
    ]);

    // Both assertions, in THIS order, and the order is the point: `expect(n).toBe(0)`
    // is the witness, so it must be able to fail FIRST. A `rejects` assertion placed
    // above it would abort the test at the mutant's first symptom — the missing
    // EEXIST — and the count, which is the only thing that can tell "threw before
    // the insert" from "threw after it", would never be evaluated at all.
    const outcome = await owner.createBrief(brief("blank")).then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from brief_version where campaign_id = $1`,
      [campaignId],
    );
    // Zero, not one: the throw ran before the insert into `brief_version`, so this
    // is not merely refused-before-a-second-version.
    expect(rows[0]!.n).toBe(0);
    expect(outcome).toMatchObject({ code: "EEXIST" });
  });
});

/**
 * D236: a brief version may only name ids that are `asset` rows of its own
 * campaign, checked inside the version's own transaction.
 *
 * The write-side checks in `brief-asset-refs.ts` ran in an EARLIER transaction,
 * so without this a deleter committing in the gap leaves a committed version
 * naming a row that no longer exists. The store learns which mode it is in from
 * the registry's sixth constructor argument and never from env, which is why
 * every store below states its mode explicitly.
 */
describe("the version's own ref check (PT-9d, D236)", () => {
  let db: SqlClient;
  /** The s3-mode store: the check on. Every positive case below uses this one. */
  let s3: PgBriefStore;

  beforeEach(async () => {
    db = await migratedDatabase();
    s3 = new PgBriefStore(db, "local", "local", [], [], true);
  });
  afterEach(async () => {
    await db.end();
  });

  /** One `asset` row (0016) on this campaign, as an upload would leave it. */
  const seedAsset = async (campaignId: string, name = "logo.png"): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      `insert into asset (org_id, campaign_id, kind, name, size, sha256, content_type)
       values ('local', $1, 'input', $2, 3, $3, 'image/png') returning id`,
      [campaignId, name, "0".repeat(64)],
    );
    return rows[0]!.id;
  };

  /** `brief()` with one product whose every ref is `ref` — a uuid, or a path. */
  const briefWithRef = (id: string, ref: string): CampaignBrief => ({
    ...brief(id),
    products: [
      {
        id: "prod-1",
        name: "Product 1",
        primaryColor: "#1473E6",
        logoPath: ref,
        inputAsset: ref,
      },
    ],
  });

  /** A uuid that names no `asset` row anywhere in this database. */
  const ORPHAN_UUID = "11111111-2222-4333-8444-555555555555";

  /**
   * A `SqlClient` that records every statement its transactions' inner
   * `tx.query` sees. A success alone cannot tell "skipped the query" from "ran
   * it and vacuously passed", so the skip is observed, not inferred.
   */
  const recordingClient = (inner: SqlClient): { client: SqlClient; statements: string[] } => {
    const statements: string[] = [];
    return {
      statements,
      client: {
        ...inner,
        transaction: (work) =>
          inner.transaction((tx) =>
            work({
              ...tx,
              query: async <R>(text: string, params?: readonly unknown[]) => {
                statements.push(text);
                return tx.query<R>(text, params);
              },
            }),
          ),
      },
    };
  };

  /** The recorded statements that read the `asset` table. */
  const assetReads = (statements: readonly string[]): string[] =>
    statements.filter((text) => text.includes("from asset"));

  test("an asset row deleted after the caller's own check refuses the write and adds no version", async () => {
    const { campaignId } = await s3.createCampaign("race");
    const assetId = await seedAsset(campaignId);
    // The caller's own `resolveBriefAssetRefs` check already ran and passed:
    // version 1 committed naming this id, which is what makes the delete below
    // a race the store has to catch rather than a ref that never existed.
    await s3.createBrief(briefWithRef("race", assetId));
    // A deleter that takes no campaign-row lock commits here.
    await db.query(`delete from asset where id = $1`, [assetId]);

    await expect(s3.rewriteBrief(briefWithRef("race", assetId))).rejects.toBeInstanceOf(
      BriefRefNotFoundError,
    );
    // The other half: the refusal rolled the whole transaction back, so the
    // version that would have named the freed row was never written. Still 1,
    // not 2 — the same count-the-rows proof PT-9a1's tombstone uses.
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from brief_version where campaign_id = $1`,
      [campaignId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  test("a uuid ref naming another campaign's asset is refused, in the same org", async () => {
    const mine = await s3.createCampaign("mine");
    const theirs = await s3.createCampaign("theirs");
    const foreign = await seedAsset(theirs.campaignId);
    // A same-org sibling campaign, so this is a cross-campaign ref and never an
    // org-isolation question: `campaign_id = $1` is what separates them.
    await s3.createBrief(brief("mine-with-a-version"));
    // Both transaction bodies, since each owns its own insertion point.
    await expect(s3.createBrief(briefWithRef("mine", foreign))).rejects.toBeInstanceOf(
      BriefRefNotFoundError,
    );
    await expect(
      s3.rewriteBrief(briefWithRef("mine-with-a-version", foreign)),
    ).rejects.toBeInstanceOf(BriefRefNotFoundError);
    // And neither wrote a version: the shortfall is caught before `dumpBrief`.
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from brief_version where campaign_id = $1`,
      [mine.campaignId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  test("a brief with no refs at all, and one whose every ref is a path, skip the asset query", async () => {
    // No refs at all: `collectRefs` returns nothing, so there is no array to ask
    // about. Products empty, and no audio, no beat backgrounds.
    const noRefs = recordingClient(db);
    await new PgBriefStore(noRefs.client, "local", "local", [], [], true).createBrief({
      ...brief("no-refs"),
      products: [],
    });
    expect(assetReads(noRefs.statements)).toEqual([]);

    // Every ref a path, and no uuid among them: a path cast to `::uuid[]` would
    // raise 22P02, a driver error rather than a refusal, so `isAssetId` has to
    // filter before the query rather than after it.
    const paths = recordingClient(db);
    await new PgBriefStore(paths.client, "local", "local", [], [], true).createBrief(
      briefWithRef("all-paths", "assets/inputs/all-paths/logo.png"),
    );
    expect(assetReads(paths.statements)).toEqual([]);

    // The POSITIVE CONTROL, through the identical wrapper: a brief naming one
    // real uuid ref against a seeded row DOES reach the query. Without it the
    // two assertions above are unfalsifiable — a wrapper that recorded nothing
    // at all would make them pass while proving nothing.
    const real = recordingClient(db);
    const realStore = new PgBriefStore(real.client, "local", "local", [], [], true);
    const { campaignId } = await realStore.createCampaign("one-real-ref");
    const assetId = await seedAsset(campaignId);
    await realStore.createBrief(briefWithRef("one-real-ref", assetId));
    expect(assetReads(real.statements)).toHaveLength(1);
  });

  test("an explicit assetIds false accepts a uuid-shaped ref naming no asset row", async () => {
    // D208 D: with fs there are no ids, so a uuid-shaped ref is a path like any
    // other. Spelled out as `false` rather than omitted — the explicit-mode
    // proof, beside the constructor default's own test below.
    const off = new PgBriefStore(db, "local", "local", [], [], false);
    const { campaignId } = await off.createCampaign("fs-mode");
    await expect(off.createBrief(briefWithRef("fs-mode", ORPHAN_UUID))).resolves.toMatchObject({
      campaignId,
    });
    await expect(off.rewriteBrief(briefWithRef("fs-mode", ORPHAN_UUID))).resolves.toMatchObject({
      campaignId,
    });
    // D208 D says "unchanged", so this is the whole claim: the uuid-shaped ref
    // is stored verbatim, not rewritten into a path and not refused.
    expect((await latestBody(db, campaignId)).products[0]!.logoPath).toBe(ORPHAN_UUID);
  });

  test("the constructor default is off, as the three-argument call sites expect", async () => {
    // Three arguments, exactly as the 100+ non-Owned call sites construct this
    // store. A default of `true` would both refuse these briefs and change what
    // every one of those files means, so the default is a requirement and not
    // an implementation detail.
    const defaulted = new PgBriefStore(db, "local", "local");
    const { campaignId } = await defaulted.createCampaign("defaulted");
    await expect(
      defaulted.createBrief(briefWithRef("defaulted", ORPHAN_UUID)),
    ).resolves.toMatchObject({ campaignId });
    await expect(
      defaulted.rewriteBrief(briefWithRef("defaulted", ORPHAN_UUID)),
    ).resolves.toMatchObject({ campaignId });
  });

  test("a campaign whose own slug is uuid-shaped text is checked identically to a normal slug", async () => {
    // D246 read for H5: `id` and `slug` share one text space, so a caller may
    // address a campaign by a uuid-shaped slug of its own. `SAFE_ID_PATTERN`
    // admits this text (lowercase hex and `-`). The check must key on the
    // resolved `campaign.id` surrogate and on nothing about `brief.id`'s own
    // shape, or a uuid-slugged campaign would silently skip it.
    const uuidSlug = "3f2b8c14-9d0e-4a51-b6c7-8e9f0a1b2c3d";
    const { campaignId } = await s3.createCampaign(uuidSlug);
    const assetId = await seedAsset(campaignId);

    await expect(s3.createBrief(briefWithRef(uuidSlug, assetId))).resolves.toMatchObject({
      campaignId,
    });
    await db.query(`delete from asset where id = $1`, [assetId]);
    await expect(s3.rewriteBrief(briefWithRef(uuidSlug, assetId))).rejects.toBeInstanceOf(
      BriefRefNotFoundError,
    );
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from brief_version where campaign_id = $1`,
      [campaignId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

/** The stored body of this campaign's latest version, parsed. */
async function latestBody(db: SqlClient, campaignId: string): Promise<CampaignBrief> {
  const { rows } = await db.query<{ body: string }>(
    `select body from brief_version where campaign_id = $1 order by version desc limit 1`,
    [campaignId],
  );
  return JSON.parse(rows[0]!.body) as CampaignBrief;
}

/**
 * The tombstone's own shape (PT-9a1, D231, D233 r2). Separate from the reader
 * block above because these are CLAIMS ABOUT THE MIGRATION, not about any
 * reader: no lane after this one may change the shape without its own migration,
 * and each claim below is a way a later change could quietly break.
 */
describe("0017_deletion migration — the tombstone's shape (D231, D233 r2)", () => {
  /** Everything below 0017, applied — so 0017 is the only pending one. */
  const through0016 = async (db: SqlClient): Promise<void> => {
    const all = await loadMigrations();
    await migrate(
      db,
      all.filter((m) => m.id < "0017"),
    );
  };

  test("the tombstone columns exist and an existing row reads null for both", async () => {
    const db = await emptyDatabase();
    try {
      const all = await loadMigrations();
      await migrate(
        db,
        all.filter((m) => m.id < "0017"),
      );
      const { rows: inserted } = await db.query<{ id: string }>(
        `insert into campaign (org_id, slug) values ('local', 'pre-migration') returning id`,
      );

      expect((await migrate(db, all))[0]).toBe("0017_deletion");

      const { rows } = await db.query<{ deleted_at: string | null; deleted_by: string | null }>(
        `select deleted_at, deleted_by from campaign where id = $1`,
        [inserted[0]!.id],
      );
      // Null-to-null for every pre-existing row, and no default: a live campaign
      // is live because nobody wrote a tombstone, not because a column defaulted.
      expect(rows[0]).toEqual({ deleted_at: null, deleted_by: null });
      const { rows: cols } = await db.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
          where table_name = 'campaign' and column_name in ('deleted_at', 'deleted_by')
          order by column_name`,
      );
      expect(cols).toEqual([
        { column_name: "deleted_at", data_type: "timestamp with time zone" },
        { column_name: "deleted_by", data_type: "text" },
      ]);
    } finally {
      await db.end();
    }
  });

  test("deletion.org_id keeps a value naming no org row — there is no foreign key", async () => {
    const db = await emptyDatabase();
    try {
      await through0016(db);
      await migrate(db, await loadMigrations());

      const { rows } = await db.query<{ org_id: string }>(
        `insert into deletion (org_id, kind, subject, requested_by, not_before)
         values ('no-such-org', 'campaign', 'x', 'u1', now())
         returning org_id`,
      );
      expect(rows[0]!.org_id).toBe("no-such-org");
      // The no-FK proof, read from the constraint catalog rather than inferred
      // from the insert succeeding: a `kind = 'org'` row is retained PAST its
      // org row's own purge window (D241), so a FK would refuse that org's delete
      // outright — this row must be able to outlive what it names.
      const { rows: fks } = await db.query<{ conname: string }>(
        `select conname from pg_constraint
          where conrelid = 'deletion'::regclass and contype = 'f'`,
      );
      expect(fks).toEqual([]);
      const { rows: org } = await db.query<{ n: number }>(
        `select count(*)::int as n from org where id = 'no-such-org'`,
      );
      expect(org[0]!.n).toBe(0);
    } finally {
      await db.end();
    }
  });

  test("the CHECK ties org_id to kind both ways, and a user row may be unscoped", async () => {
    const db = await emptyDatabase();
    try {
      await through0016(db);
      await migrate(db, await loadMigrations());

      // Both halves: a user erasure scoped to an org, and an org-scoped erasure
      // with no org. Either one alone would pass under a two-constraint shape
      // that only pinned `kind = 'user'`.
      await expect(
        db.query(
          `insert into deletion (org_id, kind, subject, requested_by, not_before)
           values ('local', 'user', 'erased:x', 'u1', now())`,
        ),
      ).rejects.toThrow(/check/i);
      await expect(
        db.query(
          `insert into deletion (org_id, kind, subject, requested_by, not_before)
           values (null, 'campaign', 'x', 'u1', now())`,
        ),
      ).rejects.toThrow(/check/i);
      // And the shape D240 (lane 9l) inserts: no single org to scope it to.
      const { rows } = await db.query<{ kind: string; org_id: string | null }>(
        `insert into deletion (kind, subject, requested_by, not_before)
         values ('user', 'erased:someone', 'u1', now())
         returning kind, org_id`,
      );
      expect(rows[0]).toEqual({ kind: "user", org_id: null });
    } finally {
      await db.end();
    }
  });

  test("the sweeper's partial index exists on not_before where not purged", async () => {
    const db = await emptyDatabase();
    try {
      await through0016(db);
      await migrate(db, await loadMigrations());

      const { rows } = await db.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where indexname = 'deletion_sweep_idx'`,
      );
      expect(rows[0]!.indexdef).toMatch(/WHERE \(purged_at IS NULL\)/);
    } finally {
      await db.end();
    }
  });
});
