import { describe, test, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
  type CopyGeneratorPort,
  PipelineExecutionLog,
} from "@campaignfoundry/CampaignOrchestration";
import { writeReport } from "../../lib/report.js";
import { writePool } from "../../lib/pools.js";
import { getBriefStore, getJobStore } from "../../lib/ports/index.js";
import { FsBriefStore } from "../../lib/ports/fs-brief-store.js";
import type { TenantContext } from "../../lib/tenant.js";
import * as pipeline from "../../lib/pipeline.js";
import resultGetHandler from "../campaigns/result.get.js";
import decisionsGetHandler from "../campaigns/decisions.get.js";
import decisionsPutHandler from "../campaigns/decisions.put.js";
import jobsIndexHandler from "../campaigns/jobs/index.get.js";
import packageListHandler from "../campaigns/packages/[campaignId].get.js";
import packageZipHandler from "../campaigns/packages/[campaignId]/[platformZip].get.js";
import packagePostHandler from "../campaigns/package.post.js";
import poolGetHandler from "../campaigns/pools/[briefId].get.js";
import poolPatchHandler from "../campaigns/pools/[briefId].patch.js";
import poolsCopyHandler from "../campaigns/pools/copy.post.js";
import briefPutHandler from "../campaigns/briefs/[id].put.js";
import briefDuplicateHandler from "../campaigns/briefs/[id]/duplicate.post.js";
import assetsGetHandler from "../campaigns/assets.get.js";
import assetsPostHandler from "../campaigns/assets.post.js";
import outputGetHandler from "../output/[...path].get.js";
import {
  LOCAL_TENANT,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
} from "./tenant-harness.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const UNKNOWN_UUID = "00000000-0000-0000-0000-000000000000";

const makeBrief = (id: string): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  mode: "brief",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  treatments: [{ id: "bold", layout: "headline-bottom", tone: "bold" }],
});

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

describe("PT-5b1: routes take campaign refs (D178)", () => {
  // (1) GET /campaigns/result
  describe("GET /campaigns/result", () => {
    test("answers identical response by slug and by uuid, and 404 for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-result"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const call = mountTenantRoute(resultGetHandler, {
          path: "/campaigns/result",
          tenant: LOCAL_TENANT,
        });

        // Initially no run: both answer 200 with empty
        const resSlug = await call(new Request(`http://x/campaigns/result?campaignId=${slug}`));
        const resUuid = await call(new Request(`http://x/campaigns/result?campaignId=${uuid}`));
        expect(resSlug.status).toBe(200);
        expect(resUuid.status).toBe(200);
        expect(await resUuid.json()).toEqual(await resSlug.json());

        // With a report written
        await writeReport(LOCAL_TENANT, makeReport(slug));
        const resSlugWithReport = await call(
          new Request(`http://x/campaigns/result?campaignId=${slug}`),
        );
        const resUuidWithReport = await call(
          new Request(`http://x/campaigns/result?campaignId=${uuid}`),
        );
        expect(resSlugWithReport.status).toBe(200);
        expect(resUuidWithReport.status).toBe(200);
        expect(await resUuidWithReport.json()).toEqual(await resSlugWithReport.json());

        // Unknown uuid gives 404
        const resUnknown = await call(
          new Request(`http://x/campaigns/result?campaignId=${UNKNOWN_UUID}`),
        );
        expect(resUnknown.status).toBe(404);
      } finally {
        await harness.cleanup();
      }
    });
  });

  // (2) GET /campaigns/decisions
  describe("GET /campaigns/decisions", () => {
    test("answers identical response by slug and by uuid, and 404 for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(
          makeBrief("camp-decisions-get"),
        );
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const call = mountTenantRoute(decisionsGetHandler, {
          path: "/campaigns/decisions",
          tenant: LOCAL_TENANT,
        });

        const resSlug = await call(new Request(`http://x/campaigns/decisions?campaignId=${slug}`));
        const resUuid = await call(new Request(`http://x/campaigns/decisions?campaignId=${uuid}`));
        expect(resSlug.status).toBe(200);
        expect(resUuid.status).toBe(200);
        expect(await resUuid.json()).toEqual(await resSlug.json());

        const resUnknown = await call(
          new Request(`http://x/campaigns/decisions?campaignId=${UNKNOWN_UUID}`),
        );
        expect(resUnknown.status).toBe(404);
      } finally {
        await harness.cleanup();
      }
    });
  });

  // (3) PUT /campaigns/decisions
  describe("PUT /campaigns/decisions", () => {
    test("answers identical response by slug and by uuid, and 409 with missing answer for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(
          makeBrief("camp-decisions-put"),
        );
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const call = mountTenantRoute(decisionsPutHandler, {
          method: "PUT",
          path: "/campaigns/decisions",
          tenant: LOCAL_TENANT,
        });

        // No run: both give 409 "This campaign has no run to review."
        const reqSlugNoRun = new Request("http://x/campaigns/decisions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ campaignId: slug, revision: null, decisions: {} }),
        });
        const reqUuidNoRun = new Request("http://x/campaigns/decisions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ campaignId: uuid, revision: null, decisions: {} }),
        });
        const resSlugNoRun = await call(reqSlugNoRun);
        const resUuidNoRun = await call(reqUuidNoRun);
        expect(resSlugNoRun.status).toBe(409);
        expect(resUuidNoRun.status).toBe(409);
        expect(await resUuidNoRun.json()).toEqual({ error: "This campaign has no run to review." });

        // Write report so a run exists
        await writeReport(LOCAL_TENANT, makeReport(slug));

        // Submit decisions by uuid
        const reqUuid = new Request("http://x/campaigns/decisions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campaignId: uuid,
            revision: null,
            decisions: { "p1/1x1.png": "approved" },
          }),
        });
        const resUuid = await call(reqUuid);
        expect(resUuid.status).toBe(200);
        const uuidBody = (await resUuid.json()) as {
          decisions: Record<string, { verdict: string }>;
          revision: string;
        };
        expect(uuidBody.decisions["p1/1x1.png"].verdict).toBe("approved");

        // Unknown uuid gives 409
        const reqUnknown = new Request("http://x/campaigns/decisions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ campaignId: UNKNOWN_UUID, revision: null, decisions: {} }),
        });
        const resUnknown = await call(reqUnknown);
        expect(resUnknown.status).toBe(409);
        expect(await resUnknown.json()).toEqual({ error: "This campaign has no run to review." });
      } finally {
        await harness.cleanup();
      }
    });
  });

  // (4) GET /campaigns/jobs
  describe("GET /campaigns/jobs", () => {
    test("answers identical response by slug and by uuid, and 404 with missing answer for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-jobs"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const call = mountTenantRoute(jobsIndexHandler, {
          path: "/campaigns/jobs",
          tenant: LOCAL_TENANT,
        });

        // No job running: 404 for both
        const resSlugNoJob = await call(new Request(`http://x/campaigns/jobs?campaignId=${slug}`));
        const resUuidNoJob = await call(new Request(`http://x/campaigns/jobs?campaignId=${uuid}`));
        expect(resSlugNoJob.status).toBe(404);
        expect(resUuidNoJob.status).toBe(404);
        expect(await resUuidNoJob.json()).toEqual({ error: "No running job for campaign" });

        // Enqueue a job
        const jobStore = getJobStore(LOCAL_TENANT);
        const job = await jobStore.enqueueJob(slug);
        expect(job.acquired).toBe(true);
        if (!job.acquired) throw new Error("Expected job to be acquired");

        const resSlug = await call(new Request(`http://x/campaigns/jobs?campaignId=${slug}`));
        const resUuid = await call(new Request(`http://x/campaigns/jobs?campaignId=${uuid}`));
        expect(resSlug.status).toBe(200);
        expect(resUuid.status).toBe(200);
        expect(await resUuid.json()).toEqual({ jobId: job.jobId });

        // Unknown uuid gives 404
        const resUnknown = await call(
          new Request(`http://x/campaigns/jobs?campaignId=${UNKNOWN_UUID}`),
        );
        expect(resUnknown.status).toBe(404);
        expect(await resUnknown.json()).toEqual({ error: "No running job for campaign" });
      } finally {
        await harness.cleanup();
      }
    });
  });

  // (5) GET /campaigns/packages/:campaignId and :platformZip
  describe("GET /campaigns/packages", () => {
    test("manifest listing and zip answer identical by slug and by uuid, and missing answer for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-packages"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const callList = mountTenantRoute(packageListHandler, {
          path: "/campaigns/packages/:campaignId",
          tenant: LOCAL_TENANT,
        });
        const callZip = mountTenantRoute(packageZipHandler, {
          path: "/campaigns/packages/:campaignId/:platformZip",
          tenant: LOCAL_TENANT,
        });

        // Unknown uuid gives missing answers
        const resListUnknown = await callList(
          new Request(`http://x/campaigns/packages/${UNKNOWN_UUID}`),
        );
        expect(resListUnknown.status).toBe(404);
        expect(await resListUnknown.json()).toEqual({ error: "No packages found" });

        const resZipUnknown = await callZip(
          new Request(`http://x/campaigns/packages/${UNKNOWN_UUID}/instagram-feed.zip`),
        );
        expect(resZipUnknown.status).toBe(404);
        expect(await resZipUnknown.json()).toEqual({ error: "Not found" });

        // Set up package files under slug
        const pkgDir = join(harness.outputRoot, "packages", slug, "instagram-feed");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "manifest.json"), '{"platform":"instagram-feed"}');
        writeFileSync(join(pkgDir, "hero.png"), PNG);

        // List by slug and uuid
        const resListSlug = await callList(new Request(`http://x/campaigns/packages/${slug}`));
        const resListUuid = await callList(new Request(`http://x/campaigns/packages/${uuid}`));
        expect(resListSlug.status).toBe(200);
        expect(resListUuid.status).toBe(200);
        expect(await resListUuid.json()).toEqual(await resListSlug.json());

        // Zip by slug and uuid
        const resZipSlug = await callZip(
          new Request(`http://x/campaigns/packages/${slug}/instagram-feed.zip`),
        );
        const resZipUuid = await callZip(
          new Request(`http://x/campaigns/packages/${uuid}/instagram-feed.zip`),
        );
        expect(resZipSlug.status).toBe(200);
        expect(resZipUuid.status).toBe(200);
        expect(Buffer.from(await resZipUuid.arrayBuffer()).length).toBe(
          Buffer.from(await resZipSlug.arrayBuffer()).length,
        );
      } finally {
        await harness.cleanup();
      }
    });
  });

  // (6) POST /campaigns/package
  describe("POST /campaigns/package", () => {
    test("packages by uuid and slug identically, and answers 404 for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-pkg-post"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        await writeReport(LOCAL_TENANT, makeReport(slug));
        const outDir = join(harness.outputRoot, "p1");
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "1x1.png"), PNG);

        const call = mountTenantRoute(packagePostHandler, {
          method: "POST",
          path: "/campaigns/package",
          tenant: LOCAL_TENANT,
        });

        // Unknown uuid
        const resUnknown = await call(
          new Request("http://x/campaigns/package", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ campaignId: UNKNOWN_UUID, platforms: ["instagram-feed"] }),
          }),
        );
        expect(resUnknown.status).toBe(404);
        expect(await resUnknown.json()).toEqual({ error: "Campaign report not found" });

        // Package by uuid
        const resUuid = await call(
          new Request("http://x/campaigns/package", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ campaignId: uuid, platforms: ["instagram-feed"] }),
          }),
        );
        expect(resUuid.status).toBe(200);

        // Package by slug
        const resSlug = await call(
          new Request("http://x/campaigns/package", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ campaignId: slug, platforms: ["instagram-feed"] }),
          }),
        );
        expect(resSlug.status).toBe(200);
      } finally {
        await harness.cleanup();
      }
    });
  });

  // (7) GET & PATCH /campaigns/pools/:briefId
  describe("GET and PATCH /campaigns/pools/:briefId", () => {
    test("answers identical response by slug and by uuid, and 404 for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-pools"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const callGet = mountTenantRoute(poolGetHandler, {
          path: "/campaigns/pools/:briefId",
          tenant: LOCAL_TENANT,
        });
        const callPatch = mountTenantRoute(poolPatchHandler, {
          method: "PATCH",
          path: "/campaigns/pools/:briefId",
          tenant: LOCAL_TENANT,
        });

        // Unknown uuid
        const resGetUnknown = await callGet(
          new Request(`http://x/campaigns/pools/${UNKNOWN_UUID}`),
        );
        expect(resGetUnknown.status).toBe(404);
        expect(await resGetUnknown.json()).toEqual({
          error: `Headline pool for brief "${UNKNOWN_UUID}" not found.`,
        });

        const resPatchUnknown = await callPatch(
          new Request(`http://x/campaigns/pools/${UNKNOWN_UUID}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ entries: [{ id: "h1", status: "approved" }] }),
          }),
        );
        expect(resPatchUnknown.status).toBe(404);
        expect(await resPatchUnknown.json()).toEqual({
          error: `Headline pool for brief "${UNKNOWN_UUID}" not found.`,
        });

        // Seed pool under slug
        await writePool(LOCAL_TENANT, {
          briefId: slug,
          generatedAt: "2026-09-24T00:00:00.000Z",
          model: "test-model",
          entries: [{ id: "h1", text: "Quality product", status: "approved" }],
        });

        // GET by slug and uuid
        const resGetSlug = await callGet(new Request(`http://x/campaigns/pools/${slug}`));
        const resGetUuid = await callGet(new Request(`http://x/campaigns/pools/${uuid}`));
        expect(resGetSlug.status).toBe(200);
        expect(resGetUuid.status).toBe(200);
        expect(await resGetUuid.json()).toEqual(await resGetSlug.json());

        // PATCH by uuid
        const resPatchUuid = await callPatch(
          new Request(`http://x/campaigns/pools/${uuid}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ entries: [{ id: "h1", status: "rejected" }] }),
          }),
        );
        expect(resPatchUuid.status).toBe(200);

        // GET by slug confirms the patch by uuid updated the slug pool
        const resGetAfterPatch = await callGet(new Request(`http://x/campaigns/pools/${slug}`));
        const poolBody = (await resGetAfterPatch.json()) as {
          pool: { entries: Array<{ id: string; status: string }> };
        };
        expect(poolBody.pool.entries[0].status).toBe("rejected");
      } finally {
        await harness.cleanup();
      }
    });
  });

  // (8) POST /campaigns/pools/copy
  describe("POST /campaigns/pools/copy", () => {
    test("copies pool by uuid and slug identically, and answers 404 for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-pools-copy"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const fakeGenerator: CopyGeneratorPort = {
          model: "mock-model",
          suggestHeadlines: vi.fn().mockResolvedValue(["Headline One", "Headline Two"]),
        };
        vi.spyOn(pipeline, "copyGenerator").mockReturnValue(fakeGenerator);

        const call = mountTenantRoute(poolsCopyHandler, {
          method: "POST",
          path: "/campaigns/pools/copy",
          tenant: LOCAL_TENANT,
        });

        // Unknown uuid
        const resUnknown = await call(
          new Request("http://x/campaigns/pools/copy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ briefId: UNKNOWN_UUID, count: 2 }),
          }),
        );
        expect(resUnknown.status).toBe(404);
        expect(await resUnknown.json()).toEqual({ error: `Brief "${UNKNOWN_UUID}" not found.` });

        // Copy by uuid
        const resUuid = await call(
          new Request("http://x/campaigns/pools/copy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ briefId: uuid, count: 2 }),
          }),
        );
        expect(resUuid.status).toBe(201);
        const uuidBody = (await resUuid.json()) as {
          pool: { briefId: string; entries: unknown[] };
        };
        expect(uuidBody.pool.briefId).toBe(slug);

        // Copy by slug
        const resSlug = await call(
          new Request("http://x/campaigns/pools/copy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ briefId: slug, count: 2 }),
          }),
        );
        expect(resSlug.status).toBe(200); // 200 because no new headlines added
      } finally {
        vi.restoreAllMocks();
        await harness.cleanup();
      }
    });

    test("answers the brief's own 404 and rethrows other errors from a brief that vanishes right after resolving (race)", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-copy-race"));
        const uuid = stored.campaignId!;
        const store = getBriefStore(LOCAL_TENANT);

        const call = mountTenantRoute(poolsCopyHandler, {
          method: "POST",
          path: "/campaigns/pools/copy",
          tenant: LOCAL_TENANT,
        });

        // The brief resolves (a campaign row exists) but has vanished by the
        // time the route looks it up for its content — the same shape a
        // concurrent delete would leave. Answers the route's own 404, same as
        // an unresolvable ref.
        vi.spyOn(store, "findBriefById").mockResolvedValueOnce(undefined);
        const resVanished = await call(
          new Request("http://x/campaigns/pools/copy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ briefId: uuid, count: 2 }),
          }),
        );
        expect(resVanished.status).toBe(404);
        expect(await resVanished.json()).toEqual({ error: `Brief "${uuid}" not found.` });

        // A genuine storage failure at that same lookup is never folded into
        // the brief's 404 — it surfaces as its own error.
        const dbError = new Error("connection reset");
        vi.spyOn(store, "findBriefById").mockRejectedValueOnce(dbError);
        const resFailed = await call(
          new Request("http://x/campaigns/pools/copy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ briefId: uuid, count: 2 }),
          }),
        );
        expect(resFailed.status).toBe(500);
      } finally {
        vi.restoreAllMocks();
        await harness.cleanup();
      }
    });

    test("rethrows a non-CampaignNotFoundError raised while resolving the ref", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(
          makeBrief("camp-copy-resolve-fail"),
        );
        const uuid = stored.campaignId!;
        const dbError = new Error("connection reset");
        vi.spyOn(getBriefStore(LOCAL_TENANT), "resolveCampaign").mockRejectedValueOnce(dbError);

        const call = mountTenantRoute(poolsCopyHandler, {
          method: "POST",
          path: "/campaigns/pools/copy",
          tenant: LOCAL_TENANT,
        });
        const res = await call(
          new Request("http://x/campaigns/pools/copy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ briefId: uuid, count: 2 }),
          }),
        );
        expect(res.status).toBe(500);
      } finally {
        vi.restoreAllMocks();
        await harness.cleanup();
      }
    });

    test("scans the brief directory once for the source on fs (no separate resolve lookup)", async () => {
      const harness = setupFsHarness();
      try {
        await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-copy-fs-scan"));

        const fakeGenerator: CopyGeneratorPort = {
          model: "mock-model",
          suggestHeadlines: vi.fn().mockResolvedValue(["Headline One"]),
        };
        vi.spyOn(pipeline, "copyGenerator").mockReturnValue(fakeGenerator);
        const findSpy = vi.spyOn(FsBriefStore.prototype, "findBriefById");

        const call = mountTenantRoute(poolsCopyHandler, {
          method: "POST",
          path: "/campaigns/pools/copy",
          tenant: LOCAL_TENANT,
        });
        const res = await call(
          new Request("http://x/campaigns/pools/copy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ briefId: "camp-copy-fs-scan", count: 1 }),
          }),
        );
        expect(res.status).toBe(201);
        // On fs the id IS the slug (D179): resolving the ref and then loading
        // its content must not scan the brief directory twice for the same id.
        expect(findSpy.mock.calls.filter(([id]) => id === "camp-copy-fs-scan")).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
        harness.cleanup();
      }
    });
  });

  // (9) PUT /campaigns/briefs/:id
  describe("PUT /campaigns/briefs/:id", () => {
    test("updates brief by uuid and by slug, and answers 404 for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-brief-put"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const call = mountTenantRoute(briefPutHandler, {
          method: "PUT",
          path: "/campaigns/briefs/:id",
          tenant: LOCAL_TENANT,
        });

        // Unknown uuid
        const resUnknown = await call(
          new Request(`http://x/campaigns/briefs/${UNKNOWN_UUID}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(makeBrief(UNKNOWN_UUID)),
          }),
        );
        expect(resUnknown.status).toBe(404);
        expect(await resUnknown.json()).toEqual({ error: `Brief "${UNKNOWN_UUID}" not found.` });

        // Update by uuid (brief body carrying slug)
        const resUuidSlugBody = await call(
          new Request(`http://x/campaigns/briefs/${uuid}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...makeBrief(slug), campaignMessage: "Updated by UUID" }),
          }),
        );
        expect(resUuidSlugBody.status).toBe(200);
        const resBody = (await resUuidSlugBody.json()) as { brief: { campaignMessage: string } };
        expect(resBody.brief.campaignMessage).toBe("Updated by UUID");

        // Update by uuid (brief body carrying uuid)
        const resUuidUuidBody = await call(
          new Request(`http://x/campaigns/briefs/${uuid}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...makeBrief(uuid), campaignMessage: "Updated by UUID 2" }),
          }),
        );
        expect(resUuidUuidBody.status).toBe(200);

        // Update by slug
        const resSlug = await call(
          new Request(`http://x/campaigns/briefs/${slug}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...makeBrief(slug), campaignMessage: "Updated by Slug" }),
          }),
        );
        expect(resSlug.status).toBe(200);
      } finally {
        await harness.cleanup();
      }
    });

    test("rethrows a non-CampaignNotFoundError raised while resolving the ref", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-put-race"));
        const uuid = stored.campaignId!;
        const dbError = new Error("connection reset");
        vi.spyOn(getBriefStore(LOCAL_TENANT), "resolveCampaign").mockRejectedValueOnce(dbError);

        const call = mountTenantRoute(briefPutHandler, {
          method: "PUT",
          path: "/campaigns/briefs/:id",
          tenant: LOCAL_TENANT,
        });
        const res = await call(
          new Request(`http://x/campaigns/briefs/${uuid}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(makeBrief(uuid)),
          }),
        );
        expect(res.status).toBe(500);
      } finally {
        vi.restoreAllMocks();
        await harness.cleanup();
      }
    });
  });

  // (10) POST /campaigns/briefs/:id/duplicate
  describe("POST /campaigns/briefs/:id/duplicate", () => {
    test("duplicates from uuid and from slug source, and answers 404 for unknown uuid source", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-duplicate"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const call = mountTenantRoute(briefDuplicateHandler, {
          method: "POST",
          path: "/campaigns/briefs/:id/duplicate",
          tenant: LOCAL_TENANT,
        });

        // Unknown uuid source
        const resUnknown = await call(
          new Request(`http://x/campaigns/briefs/${UNKNOWN_UUID}/duplicate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "dup-unknown" }),
          }),
        );
        expect(resUnknown.status).toBe(404);
        expect(await resUnknown.json()).toEqual({ error: `Brief "${UNKNOWN_UUID}" not found.` });

        // Duplicate with source = uuid
        const resUuid = await call(
          new Request(`http://x/campaigns/briefs/${uuid}/duplicate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "dup-from-uuid" }),
          }),
        );
        expect(resUuid.status).toBe(201);

        // Duplicate with source = slug
        const resSlug = await call(
          new Request(`http://x/campaigns/briefs/${slug}/duplicate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "dup-from-slug" }),
          }),
        );
        expect(resSlug.status).toBe(201);
      } finally {
        await harness.cleanup();
      }
    });

    test("answers the source's own 404 and rethrows other errors from a source that vanishes right after resolving (race)", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-dup-race"));
        const uuid = stored.campaignId!;
        const store = getBriefStore(LOCAL_TENANT);

        const call = mountTenantRoute(briefDuplicateHandler, {
          method: "POST",
          path: "/campaigns/briefs/:id/duplicate",
          tenant: LOCAL_TENANT,
        });

        // The source resolves (a campaign row exists) but has vanished by the
        // time the route looks it up for its content — the same shape a
        // concurrent delete would leave. Answers the route's own 404, same as
        // an unresolvable ref.
        vi.spyOn(store, "findBriefById").mockResolvedValueOnce(undefined);
        const resVanished = await call(
          new Request(`http://x/campaigns/briefs/${uuid}/duplicate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "dup-race-vanished" }),
          }),
        );
        expect(resVanished.status).toBe(404);
        expect(await resVanished.json()).toEqual({ error: `Brief "${uuid}" not found.` });

        // A genuine storage failure at that same lookup is never folded into
        // the source's 404 — it surfaces as its own error.
        const dbError = new Error("connection reset");
        vi.spyOn(store, "findBriefById").mockRejectedValueOnce(dbError);
        const resFailed = await call(
          new Request(`http://x/campaigns/briefs/${uuid}/duplicate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "dup-race-failed" }),
          }),
        );
        expect(resFailed.status).toBe(500);
      } finally {
        vi.restoreAllMocks();
        await harness.cleanup();
      }
    });

    test("rethrows a non-CampaignNotFoundError raised while resolving the source ref", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(
          makeBrief("camp-dup-resolve-fail"),
        );
        const uuid = stored.campaignId!;
        const dbError = new Error("connection reset");
        vi.spyOn(getBriefStore(LOCAL_TENANT), "resolveCampaign").mockRejectedValueOnce(dbError);

        const call = mountTenantRoute(briefDuplicateHandler, {
          method: "POST",
          path: "/campaigns/briefs/:id/duplicate",
          tenant: LOCAL_TENANT,
        });
        const res = await call(
          new Request(`http://x/campaigns/briefs/${uuid}/duplicate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "dup-resolve-fail-copy" }),
          }),
        );
        expect(res.status).toBe(500);
      } finally {
        vi.restoreAllMocks();
        await harness.cleanup();
      }
    });

    test("scans the brief directory once for the source on fs (no separate resolve lookup)", async () => {
      const harness = setupFsHarness();
      try {
        await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-dup-fs-scan"));
        const findSpy = vi.spyOn(FsBriefStore.prototype, "findBriefById");

        const call = mountTenantRoute(briefDuplicateHandler, {
          method: "POST",
          path: "/campaigns/briefs/:id/duplicate",
          tenant: LOCAL_TENANT,
        });
        const res = await call(
          new Request("http://x/campaigns/briefs/camp-dup-fs-scan/duplicate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "camp-dup-fs-scan-copy" }),
          }),
        );
        expect(res.status).toBe(201);
        // On fs the id IS the slug (D179): resolving the source ref and then
        // loading its content must not scan the brief directory twice for the
        // same source id. (A separate call checks the NEW id's own visibility
        // and is unaffected by this.)
        expect(findSpy.mock.calls.filter(([id]) => id === "camp-dup-fs-scan")).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
        harness.cleanup();
      }
    });
  });

  // (11) GET and POST /campaigns/assets
  describe("GET and POST /campaigns/assets", () => {
    test("assets get and post work identically by uuid and by slug, and answer 404 for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-assets"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        const callGet = mountTenantRoute(assetsGetHandler, {
          path: "/campaigns/assets",
          tenant: LOCAL_TENANT,
        });
        const callPost = mountTenantRoute(assetsPostHandler, {
          method: "POST",
          path: "/campaigns/assets",
          tenant: LOCAL_TENANT,
        });

        // Unknown uuid for GET (no name)
        const resGetUnknown = await callGet(
          new Request(`http://x/campaigns/assets?briefId=${UNKNOWN_UUID}`),
        );
        expect(resGetUnknown.status).toBe(404);

        // Unknown uuid for GET (with name)
        const resGetNameUnknown = await callGet(
          new Request(`http://x/campaigns/assets?briefId=${UNKNOWN_UUID}&name=test.png`),
        );
        expect(resGetNameUnknown.status).toBe(404);
        expect(await resGetNameUnknown.json()).toEqual({ error: 'Asset "test.png" not found.' });

        // Unknown uuid for POST
        const resPostUnknown = await callPost(
          new Request("http://x/campaigns/assets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              briefId: UNKNOWN_UUID,
              name: "logo.png",
              contentBase64: PNG.toString("base64"),
            }),
          }),
        );
        expect(resPostUnknown.status).toBe(404);
        expect(await resPostUnknown.json()).toEqual({
          error: `Campaign "${UNKNOWN_UUID}" not found.`,
        });

        // POST asset by uuid
        const resPostUuid = await callPost(
          new Request("http://x/campaigns/assets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              briefId: uuid,
              name: "uuid-asset.png",
              contentBase64: PNG.toString("base64"),
            }),
          }),
        );
        expect(resPostUuid.status).toBe(201);

        // POST asset by slug
        const resPostSlug = await callPost(
          new Request("http://x/campaigns/assets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              briefId: slug,
              name: "slug-asset.png",
              contentBase64: PNG.toString("base64"),
            }),
          }),
        );
        expect(resPostSlug.status).toBe(201);

        // GET asset list by slug and uuid
        const resListSlug = await callGet(new Request(`http://x/campaigns/assets?briefId=${slug}`));
        const resListUuid = await callGet(new Request(`http://x/campaigns/assets?briefId=${uuid}`));
        expect(resListSlug.status).toBe(200);
        expect(resListUuid.status).toBe(200);
        expect(await resListUuid.json()).toEqual(await resListSlug.json());

        // GET asset stream by uuid and slug
        const resStreamUuid = await callGet(
          new Request(`http://x/campaigns/assets?briefId=${uuid}&name=uuid-asset.png`),
        );
        const resStreamSlug = await callGet(
          new Request(`http://x/campaigns/assets?briefId=${slug}&name=uuid-asset.png`),
        );
        expect(resStreamUuid.status).toBe(200);
        expect(resStreamSlug.status).toBe(200);
        expect(Buffer.from(await resStreamUuid.arrayBuffer())).toEqual(
          Buffer.from(await resStreamSlug.arrayBuffer()),
        );
      } finally {
        await harness.cleanup();
      }
    });
  });

  // (12) GET /output/**
  describe("GET /output/**", () => {
    test("serves render and package by uuid identically to slug, and gives 404 for unknown uuid", async () => {
      const harness = await setupPgHarness();
      try {
        const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-output"));
        const uuid = stored.campaignId!;
        const slug = stored.brief.id;

        // Set up render under slug path
        const renderDir = join(harness.outputRoot, slug, "renders");
        mkdirSync(renderDir, { recursive: true });
        writeFileSync(join(renderDir, "hero.png"), PNG);

        // Set up package under packages/<slug>/...
        const pkgDir = join(harness.outputRoot, "packages", slug, "instagram-feed");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "feed.png"), PNG);

        const call = mountTenantRoute(outputGetHandler, {
          path: "/output/**:path",
          tenant: LOCAL_TENANT,
        });

        // Render by slug and by uuid
        const resRenderSlug = await call(new Request(`http://x/output/${slug}/renders/hero.png`));
        const resRenderUuid = await call(new Request(`http://x/output/${uuid}/renders/hero.png`));
        expect(resRenderSlug.status).toBe(200);
        expect(resRenderUuid.status).toBe(200);
        expect(Buffer.from(await resRenderUuid.arrayBuffer())).toEqual(
          Buffer.from(await resRenderSlug.arrayBuffer()),
        );

        // Package file by slug and by uuid
        const resPkgSlug = await call(
          new Request(`http://x/output/packages/${slug}/instagram-feed/feed.png`),
        );
        const resPkgUuid = await call(
          new Request(`http://x/output/packages/${uuid}/instagram-feed/feed.png`),
        );
        expect(resPkgSlug.status).toBe(200);
        expect(resPkgUuid.status).toBe(200);
        expect(Buffer.from(await resPkgUuid.arrayBuffer())).toEqual(
          Buffer.from(await resPkgSlug.arrayBuffer()),
        );

        // Unknown uuid render -> 404 Not found
        const resRenderUnknown = await call(
          new Request(`http://x/output/${UNKNOWN_UUID}/renders/hero.png`),
        );
        expect(resRenderUnknown.status).toBe(404);
        expect(await resRenderUnknown.json()).toEqual({ error: "Not found" });

        // Unknown uuid package -> 404 Not found
        const resPkgUnknown = await call(
          new Request(`http://x/output/packages/${UNKNOWN_UUID}/instagram-feed/feed.png`),
        );
        expect(resPkgUnknown.status).toBe(404);
        expect(await resPkgUnknown.json()).toEqual({ error: "Not found" });
      } finally {
        await harness.cleanup();
      }
    });

    test("checks visibility on the resolved slug, not the raw segment (uuid/slug collision)", async () => {
      const harness = await setupPgHarness();
      try {
        await harness.db.query(
          `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
          ["t-hidden", "Hidden Team", "local"],
        );

        // Visible campaign V: no team, so visible to every caller (D166 item 2).
        const visible = await getBriefStore(LOCAL_TENANT).createBrief(
          makeBrief("camp-collision-v"),
        );
        const visibleUuid = visible.campaignId!;
        const visibleSlug = visible.brief.id;

        // Hidden campaign H: its own SLUG is literally V's uuid, assigned to a
        // team this test's caller does not belong to. campaignVisibility
        // matches by slug, so checking it against the raw, unresolved uuid
        // segment (rather than the slug it resolves to) would find H instead
        // of V and wrongly hide V's own output.
        const hidden = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(visibleUuid), {
          teamId: "t-hidden",
        });
        const hiddenUuid = hidden.campaignId!;

        const renderDir = join(harness.outputRoot, visibleSlug, "renders");
        mkdirSync(renderDir, { recursive: true });
        writeFileSync(join(renderDir, "hero.png"), PNG);

        // A caller in neither team — H is hidden from it, V (team-less) is not.
        const restricted: TenantContext = {
          orgId: "local",
          userId: "restricted",
          roles: [],
          teamIds: [],
        };
        const call = mountTenantRoute(outputGetHandler, {
          path: "/output/**:path",
          tenant: restricted,
        });

        // V's own uuid resolves to V's own slug for the visibility check, not
        // to H just because H's slug happens to be that same uuid text.
        const resVisible = await call(
          new Request(`http://x/output/${visibleUuid}/renders/hero.png`),
        );
        expect(resVisible.status).toBe(200);
        expect(Buffer.from(await resVisible.arrayBuffer())).toEqual(PNG);

        // Reverse direction: H's own (real) uuid is still hidden -> 404.
        const resHidden = await call(new Request(`http://x/output/${hiddenUuid}/renders/hero.png`));
        expect(resHidden.status).toBe(404);
        expect(await resHidden.json()).toEqual({ error: "Not found" });
      } finally {
        await harness.cleanup();
      }
    });

    test("makes no brief-store lookup on fs (D179: the id is already the slug)", async () => {
      const harness = setupFsHarness();
      try {
        await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-output-fs"));
        const renderDir = join(harness.outputRoot, "camp-output-fs", "renders");
        mkdirSync(renderDir, { recursive: true });
        writeFileSync(join(renderDir, "hero.png"), PNG);

        const resolveSpy = vi.spyOn(FsBriefStore.prototype, "resolveCampaign");
        try {
          const call = mountTenantRoute(outputGetHandler, {
            path: "/output/**:path",
            tenant: LOCAL_TENANT,
          });
          const res = await call(new Request("http://x/output/camp-output-fs/renders/hero.png"));
          expect(res.status).toBe(200);
          expect(resolveSpy).not.toHaveBeenCalled();
        } finally {
          resolveSpy.mockRestore();
        }
      } finally {
        harness.cleanup();
      }
    });
  });

  // (13) FS backend behaviour: slug ref resolves to itself, nothing changes (D179)
  describe("FS backend behaviour (D179)", () => {
    test("on fs backend slug refs work unchanged", async () => {
      const harness = setupFsHarness();
      try {
        await getBriefStore(LOCAL_TENANT).createBrief(makeBrief("camp-fs"));

        const callResult = mountTenantRoute(resultGetHandler, {
          path: "/campaigns/result",
          tenant: LOCAL_TENANT,
        });
        const res = await callResult(new Request("http://x/campaigns/result?campaignId=camp-fs"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ halted: false, assets: [], log: null });

        const callDecisions = mountTenantRoute(decisionsGetHandler, {
          path: "/campaigns/decisions",
          tenant: LOCAL_TENANT,
        });
        const resDec = await callDecisions(
          new Request("http://x/campaigns/decisions?campaignId=camp-fs"),
        );
        expect(resDec.status).toBe(200);

        const resMissing = await callResult(
          new Request(`http://x/campaigns/result?campaignId=${UNKNOWN_UUID}`),
        );
        expect(resMissing.status).toBe(404);
      } finally {
        harness.cleanup();
      }
    });
  });
});
