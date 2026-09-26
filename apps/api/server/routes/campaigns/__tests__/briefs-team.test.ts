import { describe, test, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { TenantContext } from "../../../lib/tenant.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import briefsPostHandler from "../briefs.post.js";
import briefsPutHandler from "../briefs/[id].put.js";
import duplicatePostHandler from "../briefs/[id]/duplicate.post.js";
import {
  LOCAL_TENANT,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
} from "../../__tests__/tenant-harness.js";

const sampleBrief: CampaignBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "camp",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
};

const postReq = (body: unknown, query = "") =>
  new Request(`http://x/campaigns/briefs${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const putReq = (body: unknown) =>
  new Request("http://x/campaigns/briefs/camp", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const owner: TenantContext = { orgId: "local", userId: "owner", roles: ["owner"], teamIds: [] };
const t1Member: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };
const t2Member: TenantContext = { orgId: "local", userId: "u2", roles: [], teamIds: ["t2"] };

/** POST /campaigns/briefs mounted for `tenant`; PUT needs `:id` in the path (D166 tests only ever target "camp"). */
function mount(tenant: TenantContext) {
  return {
    create: mountTenantRoute(briefsPostHandler, {
      method: "POST",
      path: "/campaigns/briefs",
      tenant,
    }),
    update: mountTenantRoute(briefsPutHandler, {
      method: "PUT",
      path: "/campaigns/briefs/:id",
      tenant,
    }),
    duplicate: mountTenantRoute(duplicatePostHandler, {
      method: "POST",
      path: "/campaigns/briefs/:id/duplicate",
      tenant,
    }),
  };
}

const duplicateReq = (sourceId: string, newId: string) =>
  new Request(`http://x/campaigns/briefs/${sourceId}/duplicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newId }),
  });

describe("POST/PUT /campaigns/briefs — teamId (D166, PT-2c item 3)", () => {
  test("teamId on the fs backend answers 400 (item 5: teams are Postgres-only)", async () => {
    const harness = setupFsHarness();
    try {
      const { create } = mount(LOCAL_TENANT);
      const res = await create(postReq({ ...sampleBrief, teamId: "t1" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Postgres/);
    } finally {
      harness.cleanup();
    }
  });

  test("a non-string teamId answers 400 before parsing the brief", async () => {
    const harness = setupFsHarness();
    try {
      const { create } = mount(LOCAL_TENANT);
      const res = await create(postReq({ ...sampleBrief, teamId: 7 }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/teamId/);
    } finally {
      harness.cleanup();
    }
  });

  test("a non-object body answers 400 rather than throwing", async () => {
    const harness = setupFsHarness();
    try {
      const { create } = mount(LOCAL_TENANT);
      const res = await create(postReq(["not", "an", "object"]));
      expect(res.status).toBe(400);
    } finally {
      harness.cleanup();
    }
  });

  test("creating with a team the caller belongs to succeeds, and the team is invisible to another team's member", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values
           ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
        ["t1", "Team One", "local", "t2", "Team Two"],
      );

      const res = await mount(t1Member).create(postReq({ ...sampleBrief, teamId: "t1" }));
      expect(res.status).toBe(201);

      const { rows } = await harness.db.query<{ team_id: string | null }>(
        `select team_id from campaign where org_id = 'local' and slug = 'camp'`,
      );
      expect(rows[0]!.team_id).toBe("t1");
    } finally {
      await harness.cleanup();
    }
  });

  test("creating with a team the caller does not belong to, and is not owner/admin, answers 403", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t2", "Team Two", "local"],
      );
      const res = await mount(t1Member).create(postReq({ ...sampleBrief, teamId: "t2" }));
      expect(res.status).toBe(403);

      const { rows } = await harness.db.query(
        `select 1 from campaign where org_id = 'local' and slug = 'camp'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("an owner naming a team unknown to this org answers 403 (EFORBIDDEN), and writes nothing", async () => {
    const harness = await setupPgHarness();
    try {
      const res = await mount(owner).create(postReq({ ...sampleBrief, teamId: "ghost" }));
      expect(res.status).toBe(403);
      const { rows } = await harness.db.query(
        `select 1 from campaign where org_id = 'local' and slug = 'camp'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT with no teamId leaves an already-assigned team untouched", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team One", "local"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, teamId: "t1" }));

      const res = await mount(owner).update(putReq({ ...sampleBrief, campaignMessage: "v2" }));
      expect(res.status).toBe(200);

      const { rows } = await harness.db.query<{ team_id: string | null }>(
        `select team_id from campaign where org_id = 'local' and slug = 'camp'`,
      );
      expect(rows[0]!.team_id).toBe("t1");
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT on a campaign hidden by team answers 404, never disclosing it exists", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t2", "Team Two", "local"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, teamId: "t2" }));

      const res = await mount(t1Member).update(
        putReq({ ...sampleBrief, campaignMessage: "hacked" }),
      );
      expect(res.status).toBe(404);

      const { rows } = await harness.db.query<{ body: string }>(
        `select bv.body from brief_version bv join campaign c on c.id = bv.campaign_id
          where c.org_id = 'local' and c.slug = 'camp' order by bv.version desc limit 1`,
      );
      expect(JSON.parse(rows[0]!.body).campaignMessage).toBe("Build faster");
    } finally {
      await harness.cleanup();
    }
  });

  test("a member reassigning their own campaign to their own team via PUT succeeds", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team One", "local"],
      );
      await mount(owner).create(postReq(sampleBrief));

      const res = await mount(t1Member).update(
        putReq({ ...sampleBrief, teamId: "t1", campaignMessage: "v2" }),
      );
      expect(res.status).toBe(200);

      const { rows } = await harness.db.query<{ team_id: string | null }>(
        `select team_id from campaign where org_id = 'local' and slug = 'camp'`,
      );
      expect(rows[0]!.team_id).toBe("t1");
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT with a teamId on the fs backend answers 400 (item 5: teams are Postgres-only)", async () => {
    const harness = setupFsHarness();
    try {
      const res = await mount(LOCAL_TENANT).update(putReq({ ...sampleBrief, teamId: "t1" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Postgres/);
    } finally {
      harness.cleanup();
    }
  });

  test("PUT with a team the caller may not assign answers 403, and leaves the brief unchanged", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t2", "Team Two", "local"],
      );
      await mount(owner).create(postReq(sampleBrief));

      const res = await mount(t1Member).update(
        putReq({ ...sampleBrief, teamId: "t2", campaignMessage: "hacked" }),
      );
      expect(res.status).toBe(403);

      const { rows } = await harness.db.query<{ body: string }>(
        `select bv.body from brief_version bv join campaign c on c.id = bv.campaign_id
          where c.org_id = 'local' and c.slug = 'camp' order by bv.version desc limit 1`,
      );
      expect(JSON.parse(rows[0]!.body).campaignMessage).toBe("Build faster");
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT with a team unknown to this org answers 403 (EFORBIDDEN) even for an owner", async () => {
    const harness = await setupPgHarness();
    try {
      await mount(owner).create(postReq(sampleBrief));

      const res = await mount(owner).update(
        putReq({ ...sampleBrief, teamId: "ghost", campaignMessage: "v2" }),
      );
      expect(res.status).toBe(403);

      const { rows } = await harness.db.query<{ body: string }>(
        `select bv.body from brief_version bv join campaign c on c.id = bv.campaign_id
          where c.org_id = 'local' and c.slug = 'camp' order by bv.version desc limit 1`,
      );
      expect(JSON.parse(rows[0]!.body).campaignMessage).toBe("Build faster");
    } finally {
      await harness.cleanup();
    }
  });

  test("POST ?replace=1 with a team on Postgres rewrites the existing campaign's team", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values
           ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
        ["t1", "Team One", "local", "t2", "Team Two"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, teamId: "t1" }));

      const res = await mount(owner).create(
        postReq({ ...sampleBrief, teamId: "t2", campaignMessage: "v2" }, "?replace=1"),
      );
      expect(res.status).toBe(201);

      const { rows } = await harness.db.query<{ team_id: string | null }>(
        `select team_id from campaign where org_id = 'local' and slug = 'camp'`,
      );
      expect(rows[0]!.team_id).toBe("t2");
    } finally {
      await harness.cleanup();
    }
  });

  test("POST ?replace=1 with no teamId on Postgres leaves the campaign's team untouched", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team One", "local"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, teamId: "t1" }));

      const res = await mount(owner).create(
        postReq({ ...sampleBrief, campaignMessage: "v2" }, "?replace=1"),
      );
      expect(res.status).toBe(201);

      const { rows } = await harness.db.query<{ team_id: string | null }>(
        `select team_id from campaign where org_id = 'local' and slug = 'camp'`,
      );
      expect(rows[0]!.team_id).toBe("t1");
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT with a non-object body answers 400 rather than throwing", async () => {
    const harness = setupFsHarness();
    try {
      const res = await mount(LOCAL_TENANT).update(putReq(["not", "an", "object"]));
      expect(res.status).toBe(400);
    } finally {
      harness.cleanup();
    }
  });

  test("PUT with a non-string teamId answers 400 before parsing the brief", async () => {
    const harness = setupFsHarness();
    try {
      const res = await mount(LOCAL_TENANT).update(putReq({ ...sampleBrief, teamId: 7 }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/teamId/);
    } finally {
      harness.cleanup();
    }
  });

  // D166 item 5: `teamId: null` clears an assigned team back to org-wide.
  // Widening visibility is a bigger move than assigning a specific team, so
  // it is gated the same way item 3's assignment is — just owner/admin here.
  test("PUT with teamId: null clears an assigned team back to org-wide, for an owner", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team One", "local"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, teamId: "t1" }));

      const res = await mount(owner).update(
        putReq({ ...sampleBrief, teamId: null, campaignMessage: "v2" }),
      );
      expect(res.status).toBe(200);

      const { rows } = await harness.db.query<{ team_id: string | null }>(
        `select team_id from campaign where org_id = 'local' and slug = 'camp'`,
      );
      expect(rows[0]!.team_id).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT with teamId: null answers 403 for a plain member, and leaves the team assigned", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team One", "local"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, teamId: "t1" }));

      const res = await mount(t1Member).update(
        putReq({ ...sampleBrief, teamId: null, campaignMessage: "hacked" }),
      );
      expect(res.status).toBe(403);

      const { rows } = await harness.db.query<{ team_id: string | null }>(
        `select team_id from campaign where org_id = 'local' and slug = 'camp'`,
      );
      expect(rows[0]!.team_id).toBe("t1");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("Save as / duplicate refuse a hidden asset source or target (D166, PT-2c items 2 and 3)", () => {
  test("Save as (POST /campaigns/briefs) 404s when a logoPath names a campaign hidden by team, and copies nothing", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values
           ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
        ["t1", "Team One", "local", "t2", "Team Two"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, id: "t1-camp", teamId: "t1" }));

      const hiddenAssets = join(harness.projectRoot, "assets", "inputs", "t1-camp");
      mkdirSync(hiddenAssets, { recursive: true });
      writeFileSync(join(hiddenAssets, "logo.png"), "T1-SECRET-LOGO");

      const res = await mount(t2Member).create(
        postReq({
          ...sampleBrief,
          id: "evil-camp",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#1473E6",
              logoPath: "assets/inputs/t1-camp/logo.png",
            },
          ],
        }),
      );
      expect(res.status).toBe(404);

      expect(existsSync(join(harness.projectRoot, "assets", "inputs", "evil-camp"))).toBe(false);
      const { rows } = await harness.db.query(
        `select 1 from campaign where org_id = 'local' and slug = 'evil-camp'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("POST answers 409 for a target id hidden by team, before any asset copy runs into it", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values
           ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
        ["t1", "Team One", "local", "t2", "Team Two"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, id: "t1-camp", teamId: "t1" }));

      // A campaign t2Member legitimately owns, whose assets are visible to them.
      await mount(t2Member).create(postReq({ ...sampleBrief, id: "t2-src", teamId: "t2" }));
      const t2SrcAssets = join(harness.projectRoot, "assets", "inputs", "t2-src");
      mkdirSync(t2SrcAssets, { recursive: true });
      writeFileSync(join(t2SrcAssets, "logo.png"), "T2-OWN-LOGO");

      // t2Member tries to create/overwrite "t1-camp" (hidden from them, so it
      // reads as a fresh id) naming their own campaign's asset as source — the
      // copy must never land in t1-camp's asset directory ahead of the 409.
      const res = await mount(t2Member).create(
        postReq({
          ...sampleBrief,
          id: "t1-camp",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#1473E6",
              logoPath: "assets/inputs/t2-src/logo.png",
            },
          ],
        }),
      );
      expect(res.status).toBe(409);

      expect(existsSync(join(harness.projectRoot, "assets", "inputs", "t1-camp", "logo.png"))).toBe(
        false,
      );
    } finally {
      await harness.cleanup();
    }
  });

  test("duplicate 404s when the source brief itself references a campaign hidden by team, and copies nothing from it", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values
           ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
        ["t1", "Team One", "local", "t2", "Team Two"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, id: "t1-camp", teamId: "t1" }));
      const hiddenAssets = join(harness.projectRoot, "assets", "inputs", "t1-camp");
      mkdirSync(hiddenAssets, { recursive: true });
      writeFileSync(join(hiddenAssets, "secret.png"), "T1-SECRET");

      // Written directly through the store, bypassing the create route's own
      // Save-as visibility check — the point of this test is duplicate's OWN
      // check on "additional" source ids, not briefs.post.ts's.
      const t2Store = new PgBriefStore(harness.db, "local", "u2", [], ["t2"]);
      await t2Store.createBrief(
        {
          ...sampleBrief,
          id: "t2-source",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#1473E6",
              logoPath: "assets/inputs/t1-camp/secret.png",
            },
          ],
        },
        { teamId: "t2" },
      );

      const res = await mount(t2Member).duplicate(duplicateReq("t2-source", "dup-dest"));
      expect(res.status).toBe(404);
      expect(existsSync(join(harness.projectRoot, "assets", "inputs", "dup-dest"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  test("duplicate answers 409 for a newId hidden by team, before any asset copy runs into it", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values
           ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
        ["t1", "Team One", "local", "t2", "Team Two"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, id: "t1-camp", teamId: "t1" }));
      await mount(t2Member).create(postReq({ ...sampleBrief, id: "t2-source", teamId: "t2" }));
      const srcAssets = join(harness.projectRoot, "assets", "inputs", "t2-source");
      mkdirSync(srcAssets, { recursive: true });
      writeFileSync(join(srcAssets, "logo.png"), "T2-OWN-LOGO");

      const res = await mount(t2Member).duplicate(duplicateReq("t2-source", "t1-camp"));
      expect(res.status).toBe(409);

      expect(existsSync(join(harness.projectRoot, "assets", "inputs", "t1-camp", "logo.png"))).toBe(
        false,
      );
      // The pre-existing t1-camp brief itself must be untouched.
      const { rows } = await harness.db.query<{ body: string }>(
        `select bv.body from brief_version bv join campaign c on c.id = bv.campaign_id
          where c.org_id = 'local' and c.slug = 't1-camp' order by bv.version desc limit 1`,
      );
      expect(JSON.parse(rows[0]!.body).campaignMessage).toBe("Build faster");
    } finally {
      await harness.cleanup();
    }
  });
});
