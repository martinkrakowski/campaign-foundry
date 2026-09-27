import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
  PipelineExecutionLog,
} from "@campaignfoundry/CampaignOrchestration";
import { setCapabilities } from "../../lib/capabilities.js";
import { resetJobs } from "../../lib/jobs.js";
import { writePool } from "../../lib/pools.js";
import { writeReport } from "../../lib/report.js";
import { PgBriefStore } from "../../lib/ports/pg-brief-store.js";
import type { TenantContext } from "../../lib/tenant.js";
import poolGetHandler from "../campaigns/pools/[briefId].get.js";
import poolPatchHandler from "../campaigns/pools/[briefId].patch.js";
import packageListHandler from "../campaigns/packages/[campaignId].get.js";
import packageZipHandler from "../campaigns/packages/[campaignId]/[platformZip].get.js";
import outputGetHandler from "../output/[...path].get.js";
import decisionsPutHandler from "../campaigns/decisions.put.js";
import generatePostHandler from "../campaigns/generate.post.js";
import assetsPostHandler from "../campaigns/assets.post.js";
import {
  mountTenantRoute,
  setupPgHarness,
  type PgHarness,
} from "./tenant-harness.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const sampleBrief: CampaignBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "t1-camp",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
};

const makeReport = (campaignId: string) => ({
  halted: false,
  assets: [
    {
      productId: "p1",
      aspectRatio: "1:1" as const,
      outputPath: "p1/1x1.png",
      proofPath: "proofs/p1.pdf",
      complianceScore: 0.9,
      passedCompliance: true,
      logoApplied: true,
      treatment: "default",
      backgroundSource: "procedural" as const,
    },
  ],
  log: new PipelineExecutionLog(campaignId, () => new Date("2026-01-01T00:00:00.000Z")),
});

const t1Member: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };
const tBMember: TenantContext = { orgId: "local", userId: "u2", roles: [], teamIds: ["tB"] };

describe("PT-2d: team gates on routes (D166)", () => {
  let harness: PgHarness;

  beforeEach(async () => {
    setCapabilities({ motion: true });
    harness = await setupPgHarness();
    await harness.db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "tB", "Team B"],
    );
    const ownerStore = new PgBriefStore(harness.db, "local", "owner", ["owner"], []);
    await ownerStore.createBrief(sampleBrief, { teamId: "t1" });
  });

  afterEach(async () => {
    await resetJobs();
    setCapabilities({ motion: false, reason: "not probed" });
    await harness.cleanup();
  });

  test("GET /campaigns/pools/:briefId answers 404 for team-B, 200 for team-1", async () => {
    await writePool(t1Member, {
      briefId: "t1-camp",
      generatedAt: "2026-09-24T00:00:00.000Z",
      model: "test-model",
      entries: [{ id: "h1", text: "headline", status: "approved" }],
    });

    const callTB = mountTenantRoute(poolGetHandler, {
      path: "/campaigns/pools/:briefId",
      tenant: tBMember,
    });
    const resTB = await callTB(new Request("http://x/campaigns/pools/t1-camp"));
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({
      error: 'Headline pool for brief "t1-camp" not found.',
    });

    const callT1 = mountTenantRoute(poolGetHandler, {
      path: "/campaigns/pools/:briefId",
      tenant: t1Member,
    });
    const resT1 = await callT1(new Request("http://x/campaigns/pools/t1-camp"));
    expect(resT1.status).toBe(200);
  });

  test("PATCH /campaigns/pools/:briefId answers 404 for team-B, 200 for team-1", async () => {
    await writePool(t1Member, {
      briefId: "t1-camp",
      generatedAt: "2026-09-24T00:00:00.000Z",
      model: "test-model",
      entries: [{ id: "h1", text: "headline", status: "approved" }],
    });

    const callTB = mountTenantRoute(poolPatchHandler, {
      method: "PATCH",
      path: "/campaigns/pools/:briefId",
      tenant: tBMember,
    });
    const resTB = await callTB(
      new Request("http://x/campaigns/pools/t1-camp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: [{ id: "h1", status: "rejected" }] }),
      }),
    );
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({
      error: 'Headline pool for brief "t1-camp" not found.',
    });

    const callT1 = mountTenantRoute(poolPatchHandler, {
      method: "PATCH",
      path: "/campaigns/pools/:briefId",
      tenant: t1Member,
    });
    const resT1 = await callT1(
      new Request("http://x/campaigns/pools/t1-camp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: [{ id: "h1", status: "rejected" }] }),
      }),
    );
    expect(resT1.status).toBe(200);
  });

  test("GET /campaigns/packages/:campaignId answers 404 for team-B, 200 for team-1", async () => {
    const pkgDir = join(harness.outputRoot, "packages", "t1-camp", "instagram-feed");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "manifest.json"), "{}");

    const callTB = mountTenantRoute(packageListHandler, {
      path: "/campaigns/packages/:campaignId",
      tenant: tBMember,
    });
    const resTB = await callTB(new Request("http://x/campaigns/packages/t1-camp"));
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: "No packages found" });

    const callT1 = mountTenantRoute(packageListHandler, {
      path: "/campaigns/packages/:campaignId",
      tenant: t1Member,
    });
    const resT1 = await callT1(new Request("http://x/campaigns/packages/t1-camp"));
    expect(resT1.status).toBe(200);
  });

  test("GET /campaigns/packages/:campaignId/:platformZip answers 404 for team-B, 200 for team-1", async () => {
    const pkgDir = join(harness.outputRoot, "packages", "t1-camp", "instagram-feed");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "manifest.json"), "{}");

    const callTB = mountTenantRoute(packageZipHandler, {
      path: "/campaigns/packages/:campaignId/:platformZip",
      tenant: tBMember,
    });
    const resTB = await callTB(
      new Request("http://x/campaigns/packages/t1-camp/instagram-feed.zip"),
    );
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: "Not found" });

    const callT1 = mountTenantRoute(packageZipHandler, {
      path: "/campaigns/packages/:campaignId/:platformZip",
      tenant: t1Member,
    });
    const resT1 = await callT1(
      new Request("http://x/campaigns/packages/t1-camp/instagram-feed.zip"),
    );
    expect(resT1.status).toBe(200);
  });

  test("GET /output/** answers 404 for team-B, 200 for team-1, and serves non-campaign paths", async () => {
    const outDir = join(harness.outputRoot, "t1-camp", "renders");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "hero.png"), PNG);

    const nonCampaignDir = join(harness.outputRoot, "shared");
    mkdirSync(nonCampaignDir, { recursive: true });
    writeFileSync(join(nonCampaignDir, "preview.png"), PNG);

    const callTB = mountTenantRoute(outputGetHandler, {
      path: "/output/**:path",
      tenant: tBMember,
    });
    const resTB = await callTB(new Request("http://x/output/t1-camp/renders/hero.png"));
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: "Not found" });

    const callT1 = mountTenantRoute(outputGetHandler, {
      path: "/output/**:path",
      tenant: t1Member,
    });
    const resT1 = await callT1(new Request("http://x/output/t1-camp/renders/hero.png"));
    expect(resT1.status).toBe(200);
    await resT1.arrayBuffer();

    // Non-campaign path works for both
    const resNonCampTB = await callTB(new Request("http://x/output/shared/preview.png"));
    expect(resNonCampTB.status).toBe(200);
    await resNonCampTB.arrayBuffer();

    const resNonCampT1 = await callT1(new Request("http://x/output/shared/preview.png"));
    expect(resNonCampT1.status).toBe(200);
    await resNonCampT1.arrayBuffer();
  });

  test("PUT /campaigns/decisions answers 404 for team-B, 200 for team-1", async () => {
    await writeReport(t1Member, makeReport("t1-camp"));

    const callTB = mountTenantRoute(decisionsPutHandler, {
      method: "PUT",
      path: "/campaigns/decisions",
      tenant: tBMember,
    });
    const resTB = await callTB(
      new Request("http://x/campaigns/decisions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campaignId: "t1-camp",
          revision: null,
          decisions: { "p1/1x1/default": "approved" },
        }),
      }),
    );
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: 'Campaign "t1-camp" not found.' });

    const callT1 = mountTenantRoute(decisionsPutHandler, {
      method: "PUT",
      path: "/campaigns/decisions",
      tenant: t1Member,
    });
    const resT1 = await callT1(
      new Request("http://x/campaigns/decisions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campaignId: "t1-camp",
          revision: null,
          decisions: { "p1/1x1/default": "approved" },
        }),
      }),
    );
    expect(resT1.status).toBe(200);
  });

  test("POST /campaigns/generate answers 404 for team-B on stored hidden campaign, 202 for team-1, and 202 for unknown draft", async () => {
    const callTB = mountTenantRoute(generatePostHandler, {
      method: "POST",
      path: "/campaigns/generate",
      tenant: tBMember,
    });
    const resTB = await callTB(
      new Request("http://x/campaigns/generate?model=procedural", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sampleBrief),
      }),
    );
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: 'Campaign "t1-camp" not found.' });

    // Draft with unknown id still works for team-B
    const resDraftTB = await callTB(
      new Request("http://x/campaigns/generate?model=procedural", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...sampleBrief, id: "draft-camp" }),
      }),
    );
    expect(resDraftTB.status).toBe(202);

    const callT1 = mountTenantRoute(generatePostHandler, {
      method: "POST",
      path: "/campaigns/generate",
      tenant: t1Member,
    });
    const resT1 = await callT1(
      new Request("http://x/campaigns/generate?model=procedural", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sampleBrief),
      }),
    );
    expect(resT1.status).toBe(202);
  });

  test("POST /campaigns/assets answers 404 for team-B, 201 for team-1", async () => {
    const callTB = mountTenantRoute(assetsPostHandler, {
      method: "POST",
      path: "/campaigns/assets",
      tenant: tBMember,
    });
    const resTB = await callTB(
      new Request("http://x/campaigns/assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          briefId: "t1-camp",
          name: "logo.png",
          contentBase64: PNG.toString("base64"),
        }),
      }),
    );
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: 'Campaign "t1-camp" not found.' });

    const callT1 = mountTenantRoute(assetsPostHandler, {
      method: "POST",
      path: "/campaigns/assets",
      tenant: t1Member,
    });
    const resT1 = await callT1(
      new Request("http://x/campaigns/assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          briefId: "t1-camp",
          name: "logo.png",
          contentBase64: PNG.toString("base64"),
        }),
      }),
    );
    expect(resT1.status).toBe(201);
  });
});
