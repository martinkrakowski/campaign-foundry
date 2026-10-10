import { describe, test, expect } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import briefsPostHandler from "../briefs.post.js";
import { mountTenantRoute, setupPgHarness } from "../../__tests__/tenant-harness.js";

/**
 * FU-slug-uuid-409 at the ROUTE. The store refuses a create whose slug equals a
 * same-org campaign's uuid; this file pins what `POST /campaigns/briefs` answers
 * for a body whose `id` is such a uuid, because the route has a gate of its own
 * before the store: a target the caller cannot see is 404, whatever its uuid.
 *
 * So the 409 is reachable only for a uuid of a campaign the caller CAN see:
 * versionless (the Save would have minted a second row whose slug is that uuid),
 * or versioned with `?replace=1` (the replace falls through to a create). A
 * hidden campaign's uuid and another organisation's answer 404, exactly as an
 * unknown id does, so the route gives no signal about campaigns out of sight.
 */

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

const owner: TenantContext = { orgId: "local", userId: "owner", roles: ["owner"], teamIds: [] };
const outsider: TenantContext = { orgId: "local", userId: "u9", roles: [], teamIds: [] };

const post = (tenant: TenantContext) =>
  mountTenantRoute(briefsPostHandler, { method: "POST", path: "/campaigns/briefs", tenant });

const campaignRows = (db: SqlClient, orgId: string) =>
  db
    .query<{ n: number }>(`select count(*)::int as n from campaign where org_id = $1`, [orgId])
    .then((r) => r.rows[0]!.n);

describe("POST /campaigns/briefs with an id that is a campaign's uuid (FU-slug-uuid-409)", () => {
  test("a visible versionless campaign's uuid answers 409 and mints no second row", async () => {
    const harness = await setupPgHarness();
    try {
      const blank = await new PgBriefStore(harness.db, "local", "local").createCampaign("blank");

      const res = await post(owner)(postReq({ ...sampleBrief, id: blank.campaignId }));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: `Brief "${blank.campaignId}" already exists.`,
      });
      expect(await campaignRows(harness.db, "local")).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("a visible versioned campaign's uuid with ?replace=1 answers 409 and mints no second row", async () => {
    const harness = await setupPgHarness();
    try {
      const saved = await new PgBriefStore(harness.db, "local", "local").createBrief({
        ...sampleBrief,
        id: "camp-a",
      });

      const res = await post(owner)(
        postReq({ ...sampleBrief, id: saved.campaignId }, "?replace=1"),
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: `Brief "${saved.campaignId}" already exists.`,
      });
      expect(await campaignRows(harness.db, "local")).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("a team-hidden campaign's uuid answers 404, as an unknown id does", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t-secret", "Secret", "local"],
      );
      const hidden = await new PgBriefStore(harness.db, "local", "admin", ["admin"]).createBrief(
        { ...sampleBrief, id: "hidden-camp" },
        { teamId: "t-secret" },
      );

      const res = await post(outsider)(postReq({ ...sampleBrief, id: hidden.campaignId }));

      expect(res.status).toBe(404);
      expect(await campaignRows(harness.db, "local")).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("another organisation's campaign uuid answers 404 and mints nothing", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(`insert into org (id, name) values ($1, $2)`, ["other", "Other"]);
      const theirs = await new PgBriefStore(harness.db, "other", "local").createBrief({
        ...sampleBrief,
        id: "their-camp",
      });

      const res = await post(owner)(postReq({ ...sampleBrief, id: theirs.campaignId }));

      expect(res.status).toBe(404);
      expect(await campaignRows(harness.db, "local")).toBe(0);
      expect(await campaignRows(harness.db, "other")).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });
});
