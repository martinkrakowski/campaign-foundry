import { describe, test, expect, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { TenantContext } from "../../../lib/tenant.js";
import * as pools from "../../../lib/pools.js";
import { InvalidCopyPoolError } from "../../../lib/ports/pool-store.port.js";
import { getAssetStore, getBriefStore, getPoolStore } from "../../../lib/ports/index.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import briefsPostHandler from "../briefs.post.js";
import briefsPutHandler from "../briefs/[id].put.js";
import duplicatePostHandler from "../briefs/[id]/duplicate.post.js";
import assetsGetHandler from "../assets.get.js";
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
    getAsset: mountTenantRoute(assetsGetHandler, {
      path: "/campaigns/assets",
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
      expect((await res.json()).error).toMatch(/isn.t supported in this workspace/);
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

  describe("first Save of a blank-created campaign (D177, PT-5b2)", () => {
    test("POST without replace adds version 1 to a versionless row, and preserves its team", async () => {
      const harness = await setupPgHarness();
      try {
        await harness.db.query(
          `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
          ["t1", "Team One", "local"],
        );
        await new PgBriefStore(harness.db, "local", "local").createCampaign("camp", {
          teamId: "t1",
        });

        const res = await mount(t1Member).create(postReq(sampleBrief));
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ file: "camp.yaml" });

        const { rows } = await harness.db.query<{ team_id: string | null }>(
          `select team_id from campaign where org_id = 'local' and slug = 'camp'`,
        );
        expect(rows[0]!.team_id).toBe("t1");

        // A second create of the same slug — now versioned — is still refused.
        const again = await mount(owner).create(postReq(sampleBrief));
        expect(again.status).toBe(409);
      } finally {
        await harness.cleanup();
      }
    });

    test("a versionless row hidden from this caller by team still answers 409, and is never written into", async () => {
      const harness = await setupPgHarness();
      try {
        await harness.db.query(
          `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
          ["t1", "Team One", "local"],
        );
        await new PgBriefStore(harness.db, "local", "local").createCampaign("camp", {
          teamId: "t1",
        });

        const res = await mount(t2Member).create(postReq(sampleBrief));
        expect(res.status).toBe(409);

        const { rows } = await harness.db.query<{ count: number }>(
          `select count(*)::int from brief_version bv
             join campaign c on c.id = bv.campaign_id
            where c.org_id = 'local' and c.slug = 'camp'`,
        );
        expect(rows[0]!.count).toBe(0);
      } finally {
        await harness.cleanup();
      }
    });

    // Coordinator follow-up: POST /campaigns is what makes a versionless row
    // possible at all, which made rewriteBriefInternal's "versions[0]!"
    // crash (PgBriefStore) reachable through both callers below. Neither may
    // ever 500.
    test("PUT against a blank-created (versionless) campaign 404s, never 500s", async () => {
      const harness = await setupPgHarness();
      try {
        await new PgBriefStore(harness.db, "local", "local").createCampaign("camp");

        const res = await mount(owner).update(putReq(sampleBrief));
        expect(res.status).toBe(404);
      } finally {
        await harness.cleanup();
      }
    });

    test("POST ?replace=1 against a blank-created (versionless) campaign adds version 1, never 500s", async () => {
      const harness = await setupPgHarness();
      try {
        await new PgBriefStore(harness.db, "local", "local").createCampaign("camp");

        const res = await mount(owner).create(postReq(sampleBrief, "?replace=1"));
        expect(res.status).toBe(201);

        const { rows } = await harness.db.query<{ version: number }>(
          `select bv.version from brief_version bv
             join campaign c on c.id = bv.campaign_id
            where c.org_id = 'local' and c.slug = 'camp'`,
        );
        expect(rows).toEqual([{ version: 1 }]);
      } finally {
        await harness.cleanup();
      }
    });
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
      expect((await res.json()).error).toMatch(/isn.t supported in this workspace/);
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

describe("duplicate by name on Postgres (D177/D178, PT-5b2)", () => {
  const duplicateByNameReq = (sourceId: string, name: string) =>
    new Request(`http://x/campaigns/briefs/${sourceId}/duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });

  test("derives the slug and dedupes against a taken one, including a versionless row", async () => {
    const harness = await setupPgHarness();
    try {
      await mount(owner).create(postReq(sampleBrief));
      // "camp" itself is taken (the source); mint a versionless row at the
      // FIRST candidate the name would derive, so the dedupe loop must skip
      // it exactly like an already-versioned campaign.
      await new PgBriefStore(harness.db, "local", "local").createCampaign("my-copy");

      const res = await mount(owner).duplicate(duplicateByNameReq("camp", "My Copy"));
      expect(res.status).toBe(201);
      const json = (await res.json()) as { brief: { id: string } };
      expect(json.brief.id).toBe("my-copy-2");

      // The versionless row is untouched — no version was ever added to it.
      const { rows } = await harness.db.query<{ count: number }>(
        `select count(*)::int from brief_version bv
           join campaign c on c.id = bv.campaign_id
          where c.org_id = 'local' and c.slug = 'my-copy'`,
      );
      expect(rows[0]!.count).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("a reserved-word name is skipped and lands on the next suffix", async () => {
    const harness = await setupPgHarness();
    try {
      await mount(owner).create(postReq(sampleBrief));
      const res = await mount(owner).duplicate(duplicateByNameReq("camp", "Cache"));
      expect(res.status).toBe(201);
      expect(((await res.json()) as { brief: { id: string } }).brief.id).toBe("cache-2");
    } finally {
      await harness.cleanup();
    }
  });

  test("an unexpected createCampaign failure (not EEXIST) surfaces as 500", async () => {
    const harness = await setupPgHarness();
    try {
      await mount(owner).create(postReq(sampleBrief));
      const spy = vi
        .spyOn(getBriefStore(owner), "createCampaign")
        .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
      const res = await mount(owner).duplicate(duplicateByNameReq("camp", "Broken"));
      expect(res.status).toBe(500);
      spy.mockRestore();
    } finally {
      await harness.cleanup();
    }
  });

  // PT-5b2 fix-round item 2 (coderabbit PRRT_kwDOSzP1zc6mgBvA / qodo
  // PRRT_kwDOSzP1zc6mgEyP): a failure AFTER createCampaign reserved the slug
  // must release it — a retry gets the SAME slug, never "-2".
  test("copyAssets failing after reservation releases it: a retry gets the same slug", async () => {
    const harness = await setupPgHarness();
    try {
      await mount(owner).create(postReq(sampleBrief));
      const spy = vi
        .spyOn(getAssetStore(LOCAL_TENANT), "copyAssets")
        .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
      const failed = await mount(owner).duplicate(duplicateByNameReq("camp", "Copy"));
      expect(failed.status).toBe(500);
      spy.mockRestore();

      expect(await getBriefStore(owner).campaignTeam("copy")).toBeUndefined();

      const retried = await mount(owner).duplicate(duplicateByNameReq("camp", "Copy"));
      expect(retried.status).toBe(201);
      expect(((await retried.json()) as { brief: { id: string } }).brief.id).toBe("copy");
    } finally {
      await harness.cleanup();
    }
  });

  test("createBrief failing after reservation releases it and the assets already copied", async () => {
    const harness = await setupPgHarness();
    try {
      await mount(owner).create(postReq(sampleBrief));
      const spy = vi
        .spyOn(getBriefStore(owner), "createBrief")
        .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
      const failed = await mount(owner).duplicate(duplicateByNameReq("camp", "Copy"));
      expect(failed.status).toBe(500);
      spy.mockRestore();

      expect(await getBriefStore(owner).campaignTeam("copy")).toBeUndefined();
      expect(await getAssetStore(LOCAL_TENANT).listAssets("copy")).toEqual([]);

      const retried = await mount(owner).duplicate(duplicateByNameReq("camp", "Copy"));
      expect(retried.status).toBe(201);
      expect(((await retried.json()) as { brief: { id: string } }).brief.id).toBe("copy");
    } finally {
      await harness.cleanup();
    }
  });

  // A source pool that becomes malformed only when copyPool re-reads it
  // (a narrow race — copyPool rewrites its briefId, C9/D71) hits the outer
  // catch's InvalidCopyPoolError branch post-reservation. The pool is written
  // before version 1 (coderabbit PRRT_kwDOSzP1zc6mg8ci), so nothing is
  // versioned yet and the reservation is released.
  test("a source pool that only fails validation during the copy answers 422 and releases the reservation", async () => {
    const harness = await setupPgHarness();
    try {
      await mount(owner).create(postReq(sampleBrief));
      await getPoolStore(LOCAL_TENANT).writePool({
        briefId: "camp",
        generatedAt: new Date().toISOString(),
        model: "test-model",
        entries: [{ id: "e1", text: "Hi", status: "approved" }],
      });
      const spy = vi
        .spyOn(pools, "copyPool")
        .mockRejectedValueOnce(new InvalidCopyPoolError("camp", "raced invalid"));

      const res = await mount(owner).duplicate(duplicateByNameReq("camp", "Copy"));
      expect(res.status).toBe(422);
      spy.mockRestore();

      expect(await getBriefStore(LOCAL_TENANT).campaignTeam("copy")).toBeUndefined();
      expect(await getBriefStore(LOCAL_TENANT).findBriefById("copy")).toBeUndefined();
      const retried = await mount(owner).duplicate(duplicateByNameReq("camp", "Copy"));
      expect(retried.status).toBe(201);
      expect(((await retried.json()) as { brief: { id: string } }).brief.id).toBe("copy");
    } finally {
      await harness.cleanup();
    }
  });

  // PT-5b2 fix-round item 3 (qodo PRRT_kwDOSzP1zc6mgEyM): an EEXIST raised
  // AFTER the reservation held (a concurrent writer's own Save landing
  // version 1 on the SAME slug) must answer 409, never be mistaken for a
  // taken candidate and retried onto "-2".
  test("a Save racing between reservation and the first-version write answers 409, not a retry", async () => {
    const harness = await setupPgHarness();
    try {
      await mount(owner).create(postReq(sampleBrief));
      const store = getBriefStore(LOCAL_TENANT);
      const assetStore = getAssetStore(LOCAL_TENANT);
      const originalCopyAssets = assetStore.copyAssets.bind(assetStore);
      const spy = vi
        .spyOn(assetStore, "copyAssets")
        .mockImplementationOnce(async (from: string, to: string) => {
          await store.createBrief({ ...sampleBrief, id: to, campaignMessage: "Racer's own save" });
          return originalCopyAssets(from, to);
        });

      const res = await mount(owner).duplicate(duplicateByNameReq("camp", "Copy"));
      expect(res.status).toBe(409);
      spy.mockRestore();

      const raced = await store.findBriefById("copy");
      expect(raced?.brief.campaignMessage).toBe("Racer's own save");
      expect(await store.campaignTeam("copy-2")).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });
});

// qodo PRRT_kwDOSzP1zc6mgEyD (HIGH, security): a copy of a team-scoped source
// made through either duplicate path must inherit the source's team, not
// default to org-wide. The legacy `newId` path never inherited a team either
// (createBrief(brief) with no options) — a pre-existing hole PT-2c left, not
// one PT-5b2 opened; both paths are fixed together.
describe("duplicate inherits the source campaign's team (PT-5b2 fix-round item 1)", () => {
  test("legacy newId: the copy is still team-1, and hidden from a team-B member", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values
           ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
        ["t1", "Team One", "local", "t2", "Team Two"],
      );
      await new PgBriefStore(harness.db, "local", "owner", ["owner"], []).createBrief(sampleBrief, {
        teamId: "t1",
      });

      const res = await mount(t1Member).duplicate(duplicateReq("camp", "camp-copy"));
      expect(res.status).toBe(201);

      const { rows } = await harness.db.query<{ team_id: string | null }>(
        `select team_id from campaign where org_id = 'local' and slug = 'camp-copy'`,
      );
      expect(rows[0]!.team_id).toBe("t1");

      const t2Store = new PgBriefStore(harness.db, "local", "u2", [], ["t2"]);
      expect(await t2Store.campaignVisibility("camp-copy")).toBe("hidden");
    } finally {
      await harness.cleanup();
    }
  });

  test("by name: the copy is still team-1, and hidden from a team-B member", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values
           ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
        ["t1", "Team One", "local", "t2", "Team Two"],
      );
      await new PgBriefStore(harness.db, "local", "owner", ["owner"], []).createBrief(sampleBrief, {
        teamId: "t1",
      });

      const res = await mount(t1Member).duplicate(
        new Request(`http://x/campaigns/briefs/camp/duplicate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Camp Copy" }),
        }),
      );
      expect(res.status).toBe(201);

      const { rows } = await harness.db.query<{ team_id: string | null }>(
        `select team_id from campaign where org_id = 'local' and slug = 'camp-copy'`,
      );
      expect(rows[0]!.team_id).toBe("t1");

      const t2Store = new PgBriefStore(harness.db, "local", "u2", [], ["t2"]);
      expect(await t2Store.campaignVisibility("camp-copy")).toBe("hidden");
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

  test("an unexpected assertSourceVisible failure (not CampaignNotFoundError) surfaces as 500", async () => {
    const harness = await setupPgHarness();
    try {
      const ownerStore = new PgBriefStore(harness.db, "local", "owner", ["owner"], []);
      await ownerStore.createBrief({ ...sampleBrief, id: "other-camp" });
      await ownerStore.createBrief({
        ...sampleBrief,
        id: "multi-source",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#1473E6",
            logoPath: "assets/inputs/other-camp/shared.png",
          },
        ],
      });
      const spy = vi
        .spyOn(getBriefStore(owner), "campaignVisibility")
        .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));

      const res = await mount(owner).duplicate(duplicateReq("multi-source", "dup-dest"));
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledWith("other-camp");
      spy.mockRestore();
    } finally {
      await harness.cleanup();
    }
  });

  test("an unexpected preflight readPool failure (not InvalidCopyPoolError) surfaces as 500", async () => {
    const harness = await setupPgHarness();
    try {
      await mount(owner).create(postReq(sampleBrief));
      const spy = vi
        .spyOn(getPoolStore(owner), "readPool")
        .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
      const res = await mount(owner).duplicate(duplicateReq("camp", "copy"));
      expect(res.status).toBe(500);
      spy.mockRestore();
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

describe("GET /campaigns/assets?name= respects team visibility (PT-2c, greptile thread Uiug)", () => {
  test("a named-asset fetch 404s for a campaign hidden from the caller by team", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values
           ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
        ["t1", "Team One", "local", "t2", "Team Two"],
      );
      await mount(owner).create(postReq({ ...sampleBrief, id: "t1-camp", teamId: "t1" }));

      const assetDir = join(harness.projectRoot, "assets", "inputs", "t1-camp");
      mkdirSync(assetDir, { recursive: true });
      writeFileSync(join(assetDir, "logo.png"), "T1-SECRET-LOGO");

      // The owning team's member can fetch it.
      const own = await mount(t1Member).getAsset(
        new Request("http://x/campaigns/assets?briefId=t1-camp&name=logo.png"),
      );
      expect(own.status).toBe(200);

      // A member of another team, naming the same campaign id and asset
      // filename, must 404 exactly like the listing path — not stream the
      // bytes to whoever guesses the campaign id.
      const outside = await mount(t2Member).getAsset(
        new Request("http://x/campaigns/assets?briefId=t1-camp&name=logo.png"),
      );
      expect(outside.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("duplicate checks every asset source before copying any of them (PT-2c, greptile thread U90U)", () => {
  test("duplicate 404s and leaves no orphaned assets when the source references a second hidden campaign, even though the source's own assets would otherwise copy", async () => {
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

      // t2-source is visible to t2Member and — unlike the earlier "duplicate
      // 404s ... and copies nothing from it" test — HAS its own asset files,
      // so copyAssets(id, newId) below has something to actually copy before
      // the second source (t1-camp, hidden from t2Member) is even checked.
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
      const t2SourceAssets = join(harness.projectRoot, "assets", "inputs", "t2-source");
      mkdirSync(t2SourceAssets, { recursive: true });
      writeFileSync(join(t2SourceAssets, "own-logo.png"), "T2-OWN-LOGO");

      const res = await mount(t2Member).duplicate(duplicateReq("t2-source", "dup-dest"));
      expect(res.status).toBe(404);

      // No brief, and — the point of this test — no orphaned asset directory
      // left behind from the primary source's copy that ran before the
      // second source's visibility was checked.
      expect(existsSync(join(harness.projectRoot, "assets", "inputs", "dup-dest"))).toBe(false);
      const { rows } = await harness.db.query(
        `select 1 from campaign where org_id = 'local' and slug = 'dup-dest'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("teamId on the fs backend is refused before any asset copy (PT-2c, coderabbit thread U_YF)", () => {
  test("POST refuses teamId on the fs backend before copying save-as assets, leaving no orphaned files", async () => {
    const harness = setupFsHarness();
    try {
      const sourceAssets = join(harness.projectRoot, "assets", "inputs", "src-camp");
      mkdirSync(sourceAssets, { recursive: true });
      writeFileSync(join(sourceAssets, "logo.png"), "SRC-LOGO");
      await mount(LOCAL_TENANT).create(postReq({ ...sampleBrief, id: "src-camp" }));

      const res = await mount(LOCAL_TENANT).create(
        postReq({
          ...sampleBrief,
          id: "evil-camp",
          teamId: "t1",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#1473E6",
              logoPath: "assets/inputs/src-camp/logo.png",
            },
          ],
        }),
      );
      expect(res.status).toBe(400);
      expect(existsSync(join(harness.projectRoot, "assets", "inputs", "evil-camp"))).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  // PUT never copies save-as assets (no extractSourceAssetBriefIds/copyAssets
  // in briefs/[id].put.ts), so there is no orphan to reproduce there — the
  // consistency fix coderabbit asks for is the CHECK ORDER: `supportsTeams`
  // before `canAssignTeam`, so an fs backend answers 400 even for a teamId
  // this caller could not have assigned anyway, rather than 403.
  test("PUT answers 400, not 403, for an unassignable teamId on the fs backend (supportsTeams checked before canAssignTeam)", async () => {
    const harness = setupFsHarness();
    try {
      await mount(LOCAL_TENANT).create(postReq(sampleBrief));

      const res = await mount(t2Member).update(putReq({ ...sampleBrief, teamId: "t1" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/isn.t supported in this workspace/);
    } finally {
      harness.cleanup();
    }
  });
});
