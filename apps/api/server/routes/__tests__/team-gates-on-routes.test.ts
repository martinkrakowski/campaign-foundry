import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
  PipelineExecutionLog,
} from "@campaignfoundry/CampaignOrchestration";
import { err } from "@campaignfoundry/shared";
import { setCapabilities } from "../../lib/capabilities.js";
import { createJob, resetJobs } from "../../lib/jobs.js";
import { writePool } from "../../lib/pools.js";
import { writeReport } from "../../lib/report.js";
import { FsBriefStore } from "../../lib/ports/fs-brief-store.js";
import { PgBriefStore } from "../../lib/ports/pg-brief-store.js";
import type { TenantContext } from "../../lib/tenant.js";
import poolGetHandler from "../campaigns/pools/[briefId].get.js";
import poolPatchHandler from "../campaigns/pools/[briefId].patch.js";
import packagePostHandler from "../campaigns/package.post.js";
import packageListHandler from "../campaigns/packages/[campaignId].get.js";
import packageZipHandler from "../campaigns/packages/[campaignId]/[platformZip].get.js";
import outputGetHandler from "../output/[...path].get.js";
import decisionsPutHandler from "../campaigns/decisions.put.js";
import generatePostHandler from "../campaigns/generate.post.js";
import planPostHandler from "../campaigns/plan.post.js";
import jobGetHandler from "../campaigns/jobs/[id].get.js";
import jobsIndexHandler from "../campaigns/jobs/index.get.js";
import assetsPostHandler from "../campaigns/assets.post.js";
import {
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  type PgHarness,
} from "./tenant-harness.js";

const runCampaignSpy = vi.hoisted(() => vi.fn(async () => err(new Error("stub: route gate test"))));
vi.mock("../../lib/pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/pipeline.js")>();
  return { ...actual, runCampaign: runCampaignSpy };
});

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

  const jobCall = (id: string, tenant: TenantContext) => {
    const caller = mountTenantRoute(jobGetHandler, {
      path: "/campaigns/jobs/:id",
      tenant,
    });
    return caller(new Request(`http://x/campaigns/jobs/${id}`));
  };

  async function awaitSettled(jobId: string, tenant: TenantContext): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const body = (await (await jobCall(jobId, tenant)).json()) as { status: string };
      if (body.status === "completed" || body.status === "failed") return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for job ${jobId} to settle`);
  }

  afterEach(async () => {
    await resetJobs();
    runCampaignSpy.mockClear();
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

    // Package output path: team-B gets 404, team-1 gets 200
    const pkgOutDir = join(harness.outputRoot, "packages", "t1-camp", "instagram-feed");
    mkdirSync(pkgOutDir, { recursive: true });
    writeFileSync(join(pkgOutDir, "manifest.json"), "{}");

    const resPkgTB = await callTB(
      new Request("http://x/output/packages/t1-camp/instagram-feed/manifest.json"),
    );
    expect(resPkgTB.status).toBe(404);
    expect(await resPkgTB.json()).toEqual({ error: "Not found" });

    const resPkgT1 = await callT1(
      new Request("http://x/output/packages/t1-camp/instagram-feed/manifest.json"),
    );
    expect(resPkgT1.status).toBe(200);
    await resPkgT1.arrayBuffer();
  });

  test("GET /output/** normalises raw router params and prevents ./ or .. bypass", async () => {
    const outDir = join(harness.outputRoot, "t1-camp", "renders");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "hero.png"), PNG);

    const callWithRawPath = (pathParam: string, tenant: TenantContext) => {
      const handler = (event: Parameters<typeof outputGetHandler>[0]) => {
        event.context.params = { path: pathParam };
        return outputGetHandler(event);
      };
      const caller = mountTenantRoute(handler, { path: "/output/**:path", tenant });
      return caller(new Request("http://x/output/placeholder"));
    };

    // ./ detour: hidden campaign 404s for team-B, 200s for team-1
    const resDotTB = await callWithRawPath("./t1-camp/renders/hero.png", tBMember);
    expect(resDotTB.status).toBe(404);
    expect(await resDotTB.json()).toEqual({ error: "Not found" });

    const resDotT1 = await callWithRawPath("./t1-camp/renders/hero.png", t1Member);
    expect(resDotT1.status).toBe(200);
    await resDotT1.arrayBuffer();

    // .. detour: hidden campaign 404s for team-B, 200s for team-1
    const resDotDotTB = await callWithRawPath("zz/../t1-camp/renders/hero.png", tBMember);
    expect(resDotDotTB.status).toBe(404);
    expect(await resDotDotTB.json()).toEqual({ error: "Not found" });

    const resDotDotT1 = await callWithRawPath("zz/../t1-camp/renders/hero.png", t1Member);
    expect(resDotDotT1.status).toBe(200);
    await resDotDotT1.arrayBuffer();

    // Escaping path: rejected with 400 Invalid path BEFORE the gate (even for hidden campaign)
    const resEscapeTB = await callWithRawPath("t1-camp/../../etc/passwd", tBMember);
    expect(resEscapeTB.status).toBe(400);
    expect(await resEscapeTB.json()).toEqual({ error: "Invalid path" });
  });

  test("GET /output/** gates both campaign-id positions when slug is packages", async () => {
    const { rows } = await harness.db.query<{ id: string }>(
      "insert into campaign (org_id, slug, team_id) values ($1, $2, $3) returning id",
      ["local", "packages", "t1"],
    );
    await harness.db.query(
      `insert into brief_version (campaign_id, version, body, revision, actor)
       values ($1, 1, $2, $3, $4)`,
      [rows[0]!.id, JSON.stringify({ ...sampleBrief, id: "packages" }), "rev-packages", "owner"],
    );

    const packagesOutDir = join(harness.outputRoot, "packages", "renders");
    mkdirSync(packagesOutDir, { recursive: true });
    writeFileSync(join(packagesOutDir, "hero.png"), PNG);

    const callTB = mountTenantRoute(outputGetHandler, {
      path: "/output/**:path",
      tenant: tBMember,
    });
    const resTB = await callTB(new Request("http://x/output/packages/renders/hero.png"));
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: "Not found" });

    const callT1 = mountTenantRoute(outputGetHandler, {
      path: "/output/**:path",
      tenant: t1Member,
    });
    const resT1 = await callT1(new Request("http://x/output/packages/renders/hero.png"));
    expect(resT1.status).toBe(200);
    await resT1.arrayBuffer();
  });

  test("PUT /campaigns/decisions answers 409 for team-B, 200 for team-1", async () => {
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
    expect(resTB.status).toBe(409);
    expect(await resTB.json()).toEqual({ error: "This campaign has no run to review." });

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

  // PT-5c2 closes the gap this test used to document: generate now requires
  // a KNOWN campaign (`campaignMeta` defined — the campaign must already be
  // minted through `POST /campaigns`), so an unsaved, never-minted "draft"
  // id no longer runs — it answers the identical 404 a hidden campaign does.
  test("POST /campaigns/generate answers 404 for team-B on stored hidden campaign, 404 for an unknown/unminted draft, and 202 for team-1", async () => {
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

    // A never-minted "draft" id answers the SAME 404, and starts no job.
    const resDraftTB = await callTB(
      new Request("http://x/campaigns/generate?model=procedural", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...sampleBrief, id: "draft-camp" }),
      }),
    );
    expect(resDraftTB.status).toBe(404);
    expect(await resDraftTB.json()).toEqual({ error: 'Campaign "draft-camp" not found.' });

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
    const { jobId: t1JobId } = (await resT1.json()) as { jobId: string };
    await awaitSettled(t1JobId, t1Member);
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

  test("GET /campaigns/jobs?campaignId= answers 404 for team-B, 200 for team-1", async () => {
    const jobId = await createJob(t1Member, "t1-camp");

    const callTB = mountTenantRoute(jobsIndexHandler, {
      path: "/campaigns/jobs",
      tenant: tBMember,
    });
    const resTB = await callTB(new Request("http://x/campaigns/jobs?campaignId=t1-camp"));
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: "No running job for campaign" });

    const callT1 = mountTenantRoute(jobsIndexHandler, {
      path: "/campaigns/jobs",
      tenant: t1Member,
    });
    const resT1 = await callT1(new Request("http://x/campaigns/jobs?campaignId=t1-camp"));
    expect(resT1.status).toBe(200);
    expect(await resT1.json()).toEqual({ jobId });
  });

  test("POST /campaigns/package answers 404 for team-B, 200 for team-1, and writes nothing for team-B", async () => {
    await writeReport(t1Member, makeReport("t1-camp"));
    const outDir = join(harness.outputRoot, "p1");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "1x1.png"), PNG);

    const callTB = mountTenantRoute(packagePostHandler, {
      method: "POST",
      path: "/campaigns/package",
      tenant: tBMember,
    });
    const resTB = await callTB(
      new Request("http://x/campaigns/package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignId: "t1-camp", platforms: ["instagram-feed"] }),
      }),
    );
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: "Campaign report not found" });
    expect(existsSync(join(harness.outputRoot, "packages", "t1-camp"))).toBe(false);

    const callT1 = mountTenantRoute(packagePostHandler, {
      method: "POST",
      path: "/campaigns/package",
      tenant: t1Member,
    });
    const resT1 = await callT1(
      new Request("http://x/campaigns/package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignId: "t1-camp", platforms: ["instagram-feed"] }),
      }),
    );
    expect(resT1.status).toBe(200);
    expect(existsSync(join(harness.outputRoot, "packages", "t1-camp"))).toBe(true);
  });

  // PT-5c2: plan now gates the WHOLE route on a known campaign, not just the
  // pool — a hidden campaign 404s before the planner ever runs, an even
  // tighter leak-proofing than the old pool-only hide (422, which still
  // named the campaign's own pool file path).
  test("POST /campaigns/plan leaks no headlines for a hidden campaign", async () => {
    await writePool(t1Member, {
      briefId: "t1-camp",
      generatedAt: "2026-09-24T00:00:00.000Z",
      model: "test-model",
      entries: [{ id: "h1", text: "Secret Headline", status: "approved" }],
    });

    const pooledBrief: CampaignBrief = {
      ...sampleBrief,
      mode: "variation",
      variation: {
        count: 1,
        seed: 42,
        axes: {
          headline: "pool://copy",
        },
      },
    };

    const callTB = mountTenantRoute(planPostHandler, {
      method: "POST",
      path: "/campaigns/plan",
      tenant: tBMember,
    });
    const resTB = await callTB(
      new Request("http://x/campaigns/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pooledBrief),
      }),
    );
    expect(resTB.status).toBe(404);
    expect(await resTB.json()).toEqual({ error: 'Campaign "t1-camp" not found.' });

    const callT1 = mountTenantRoute(planPostHandler, {
      method: "POST",
      path: "/campaigns/plan",
      tenant: t1Member,
    });
    const resT1 = await callT1(
      new Request("http://x/campaigns/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pooledBrief),
      }),
    );
    expect(resT1.status).toBe(200);
    const bodyT1 = (await resT1.json()) as { variants: Array<{ headline?: string }> };
    expect(bodyT1.variants[0]?.headline).toBe("Secret Headline");
  });

  test("on the file backend (supportsTeams false), campaignVisibility is never called and routes behave as before", async () => {
    const fsHarness = setupFsHarness();
    try {
      const visibilitySpy = vi.spyOn(FsBriefStore.prototype, "campaignVisibility");

      const fsStore = new FsBriefStore(join(fsHarness.projectRoot, "briefs"));
      mkdirSync(join(fsHarness.projectRoot, "briefs"), { recursive: true });
      await fsStore.createBrief(sampleBrief);

      await writePool(t1Member, {
        briefId: "t1-camp",
        generatedAt: "2026-09-24T00:00:00.000Z",
        model: "test-model",
        entries: [{ id: "h1", text: "headline", status: "approved" }],
      });

      const outDir = join(fsHarness.outputRoot, "t1-camp", "renders");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "hero.png"), PNG);

      await writeReport(t1Member, makeReport("t1-camp"));

      // 1. GET /campaigns/pools/:briefId
      const callPool = mountTenantRoute(poolGetHandler, {
        path: "/campaigns/pools/:briefId",
        tenant: t1Member,
      });
      const resPool = await callPool(new Request("http://x/campaigns/pools/t1-camp"));
      expect(resPool.status).toBe(200);

      // 2. GET /output/**
      const callOutput = mountTenantRoute(outputGetHandler, {
        path: "/output/**:path",
        tenant: t1Member,
      });
      const resOutput = await callOutput(new Request("http://x/output/t1-camp/renders/hero.png"));
      expect(resOutput.status).toBe(200);
      await resOutput.arrayBuffer();

      // 3. PUT /campaigns/decisions
      const callDecisions = mountTenantRoute(decisionsPutHandler, {
        method: "PUT",
        path: "/campaigns/decisions",
        tenant: t1Member,
      });
      const resDecisions = await callDecisions(
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
      expect(resDecisions.status).toBe(200);

      // 4. POST /campaigns/package
      const p1Dir = join(fsHarness.outputRoot, "p1");
      mkdirSync(p1Dir, { recursive: true });
      writeFileSync(join(p1Dir, "1x1.png"), PNG);
      const callPackage = mountTenantRoute(packagePostHandler, {
        method: "POST",
        path: "/campaigns/package",
        tenant: t1Member,
      });
      const resPackage = await callPackage(
        new Request("http://x/campaigns/package", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ campaignId: "t1-camp", platforms: ["instagram-feed"] }),
        }),
      );
      expect(resPackage.status).toBe(200);

      // 5. POST /campaigns/plan
      const pooledBrief: CampaignBrief = {
        ...sampleBrief,
        mode: "variation",
        variation: {
          count: 1,
          seed: 42,
          axes: {
            headline: "pool://copy",
          },
        },
      };
      const callPlan = mountTenantRoute(planPostHandler, {
        method: "POST",
        path: "/campaigns/plan",
        tenant: t1Member,
      });
      const resPlan = await callPlan(
        new Request("http://x/campaigns/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pooledBrief),
        }),
      );
      expect(resPlan.status).toBe(200);

      // Assert that campaignVisibility was NEVER called on the file backend
      expect(visibilitySpy).not.toHaveBeenCalled();
      visibilitySpy.mockRestore();
    } finally {
      fsHarness.cleanup();
    }
  });
});
