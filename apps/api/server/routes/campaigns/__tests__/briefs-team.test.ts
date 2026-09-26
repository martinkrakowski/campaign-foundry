import { describe, test, expect } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { TenantContext } from "../../../lib/tenant.js";
import briefsPostHandler from "../briefs.post.js";
import briefsPutHandler from "../briefs/[id].put.js";
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
  };
}

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
});
