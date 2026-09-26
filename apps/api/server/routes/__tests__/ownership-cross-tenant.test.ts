import { describe, test, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief } from "../../lib/brief-files.js";
import { writeReport } from "../../lib/report.js";
import { writePool } from "../../lib/pools.js";
import { getAssetStore, getBriefStore, getDecisionStore } from "../../lib/ports/index.js";
import resultGetHandler from "../campaigns/result.get.js";
import decisionsGetHandler from "../campaigns/decisions.get.js";
import decisionsPutHandler from "../campaigns/decisions.put.js";
import assetsGetHandler from "../campaigns/assets.get.js";
import assetsPostHandler from "../campaigns/assets.post.js";
import packagePostHandler from "../campaigns/package.post.js";
import poolsCopyHandler from "../campaigns/pools/copy.post.js";
import poolsPatchHandler from "../campaigns/pools/[briefId].patch.js";
import briefDuplicateHandler from "../campaigns/briefs/[id]/duplicate.post.js";
import {
  ACME_TENANT,
  LOCAL_TENANT,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
} from "./tenant-harness.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const sampleBrief: CampaignBrief = {
  id: "camp",
  name: "Camp",
  status: "draft",
  mode: "classic",
  products: [{ id: "p1", name: "P1" }],
  aspectRatios: ["1:1"],
  treatments: ["bold"],
};

describe("PT-2b: cross-tenant ownership at the port (item 2 and item 4)", () => {
  // (2) GET /campaigns/result: 404 for unowned campaign, 200 empty for own campaign with no run
  test("GET /campaigns/result answers 404 for another org's campaign on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(resultGetHandler, {
        path: "/campaigns/result",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request("http://x/campaigns/result?campaignId=camp"));
      expect(resAcme.status).toBe(404);

      const callLocal = mountTenantRoute(resultGetHandler, {
        path: "/campaigns/result",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request("http://x/campaigns/result?campaignId=camp"));
      expect(resLocal.status).toBe(200);
      expect(await resLocal.json()).toEqual({ halted: false, assets: [], log: null });
    } finally {
      harness.cleanup();
    }
  });

  test("GET /campaigns/result answers 404 for another org's campaign on postgres", async () => {
    const harness = await setupPgHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(resultGetHandler, {
        path: "/campaigns/result",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request("http://x/campaigns/result?campaignId=camp"));
      expect(resAcme.status).toBe(404);

      const callLocal = mountTenantRoute(resultGetHandler, {
        path: "/campaigns/result",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request("http://x/campaigns/result?campaignId=camp"));
      expect(resLocal.status).toBe(200);
      expect(await resLocal.json()).toEqual({ halted: false, assets: [], log: null });
    } finally {
      await harness.cleanup();
    }
  });

  // (2) GET /campaigns/decisions: 404 for unowned campaign, 200 empty for own campaign with no decisions
  test("GET /campaigns/decisions answers 404 for another org's campaign on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(decisionsGetHandler, {
        path: "/campaigns/decisions",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request("http://x/campaigns/decisions?campaignId=camp"));
      expect(resAcme.status).toBe(404);

      const callLocal = mountTenantRoute(decisionsGetHandler, {
        path: "/campaigns/decisions",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request("http://x/campaigns/decisions?campaignId=camp"));
      expect(resLocal.status).toBe(200);
      expect(await resLocal.json()).toEqual({ decisions: {}, revision: null });
    } finally {
      harness.cleanup();
    }
  });

  test("GET /campaigns/decisions answers 404 for another org's campaign on postgres", async () => {
    const harness = await setupPgHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(decisionsGetHandler, {
        path: "/campaigns/decisions",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request("http://x/campaigns/decisions?campaignId=camp"));
      expect(resAcme.status).toBe(404);

      const callLocal = mountTenantRoute(decisionsGetHandler, {
        path: "/campaigns/decisions",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request("http://x/campaigns/decisions?campaignId=camp"));
      expect(resLocal.status).toBe(200);
      expect(await resLocal.json()).toEqual({ decisions: {}, revision: null });
    } finally {
      await harness.cleanup();
    }
  });

  // (2) GET /campaigns/assets list: 404 for unowned campaign, 200 empty for own campaign with no assets
  test("GET /campaigns/assets list answers 404 for another org's campaign on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(assetsGetHandler, {
        path: "/campaigns/assets",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request("http://x/campaigns/assets?briefId=camp"));
      expect(resAcme.status).toBe(404);

      const callLocal = mountTenantRoute(assetsGetHandler, {
        path: "/campaigns/assets",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request("http://x/campaigns/assets?briefId=camp"));
      expect(resLocal.status).toBe(200);
      expect(await resLocal.json()).toEqual({ assets: [] });
    } finally {
      harness.cleanup();
    }
  });

  // (4) PUT /campaigns/decisions: 404 for another org's campaign
  test("PUT /campaigns/decisions answers 404 for another org's campaign on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
      await writeReport(LOCAL_TENANT, {
        halted: false,
        assets: [{ productId: "p1", outputPath: "p1/1x1.png" } as any],
        log: { campaignId: "camp" },
      });

      const callAcme = mountTenantRoute(decisionsPutHandler, {
        method: "PUT",
        path: "/campaigns/decisions",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/decisions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campaignId: "camp",
            revision: null,
            decisions: { "p1/1x1/bold": "approved" },
          }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      harness.cleanup();
    }
  });

  test("PUT /campaigns/decisions answers 404 for another org's campaign on postgres", async () => {
    const harness = await setupPgHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
      await writeReport(LOCAL_TENANT, {
        halted: false,
        assets: [{ productId: "p1", outputPath: "p1/1x1.png" } as any],
        log: { campaignId: "camp" },
      });

      const callAcme = mountTenantRoute(decisionsPutHandler, {
        method: "PUT",
        path: "/campaigns/decisions",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/decisions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campaignId: "camp",
            revision: null,
            decisions: { "p1/1x1/bold": "approved" },
          }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  // (4) POST /campaigns/package: 404 for another org's campaign
  test("POST /campaigns/package answers 404 for another org's campaign on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
      await writeReport(LOCAL_TENANT, {
        halted: false,
        assets: [{ productId: "p1", outputPath: "p1/1x1.png" } as any],
        log: { campaignId: "camp" },
      });

      const callAcme = mountTenantRoute(packagePostHandler, {
        method: "POST",
        path: "/campaigns/package",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/package", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ campaignId: "camp", platforms: ["instagram-feed"] }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      harness.cleanup();
    }
  });

  // (4) POST /campaigns/pools/copy: 404 for another org's campaign (body-driven brief)
  test("POST /campaigns/pools/copy answers 404 for another org's campaign on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(poolsCopyHandler, {
        method: "POST",
        path: "/campaigns/pools/copy",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/pools/copy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brief: sampleBrief }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      harness.cleanup();
    }
  });

  test("POST /campaigns/pools/copy answers 404 for another org's campaign on postgres", async () => {
    const harness = await setupPgHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(poolsCopyHandler, {
        method: "POST",
        path: "/campaigns/pools/copy",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/pools/copy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brief: sampleBrief }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  // (4) PATCH /campaigns/pools/:briefId: 404 for another org's campaign
  test("PATCH /campaigns/pools/:briefId answers 404 for another org's campaign on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
      await writePool(LOCAL_TENANT, {
        briefId: "camp",
        generatedAt: "2026-09-24T00:00:00.000Z",
        model: "test-model",
        entries: [{ id: "h1", text: "headline", status: "approved" }],
      });

      const callAcme = mountTenantRoute(poolsPatchHandler, {
        method: "PATCH",
        path: "/campaigns/pools/:briefId",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/pools/camp", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entries: [{ id: "h1", status: "rejected" }] }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      harness.cleanup();
    }
  });

  test("PATCH /campaigns/pools/:briefId answers 404 for another org's campaign on postgres", async () => {
    const harness = await setupPgHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
      await writePool(LOCAL_TENANT, {
        briefId: "camp",
        generatedAt: "2026-09-24T00:00:00.000Z",
        model: "test-model",
        entries: [{ id: "h1", text: "headline", status: "approved" }],
      });

      const callAcme = mountTenantRoute(poolsPatchHandler, {
        method: "PATCH",
        path: "/campaigns/pools/:briefId",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/pools/camp", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entries: [{ id: "h1", status: "rejected" }] }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  // (4) POST /campaigns/briefs/:id/duplicate: 404 for another org's source campaign
  test("POST /campaigns/briefs/:id/duplicate answers 404 for another org's source campaign on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(briefDuplicateHandler, {
        method: "POST",
        path: "/campaigns/briefs/:id/duplicate",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/briefs/camp/duplicate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newId: "camp-copy" }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      harness.cleanup();
    }
  });

  test("POST /campaigns/briefs/:id/duplicate answers 404 for another org's source campaign on postgres", async () => {
    const harness = await setupPgHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(briefDuplicateHandler, {
        method: "POST",
        path: "/campaigns/briefs/:id/duplicate",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/briefs/camp/duplicate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newId: "camp-copy" }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  // (4) POST /campaigns/assets: 404 for another org's campaign
  test("POST /campaigns/assets answers 404 for another org's campaign on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);

      const callAcme = mountTenantRoute(assetsPostHandler, {
        method: "POST",
        path: "/campaigns/assets",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/assets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            briefId: "camp",
            name: "logo.png",
            contentBase64: PNG.toString("base64"),
          }),
        }),
      );
      expect(resAcme.status).toBe(404);
    } finally {
      harness.cleanup();
    }
  });
});
