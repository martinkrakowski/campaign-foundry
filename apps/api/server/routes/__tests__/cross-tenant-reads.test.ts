import { describe, test, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJob } from "../../lib/jobs.js";
import { getAssetStore } from "../../lib/ports/index.js";
import { writePool } from "../../lib/pools.js";
import assetsGetHandler from "../campaigns/assets.get.js";
import jobGetHandler from "../campaigns/jobs/[id].get.js";
import packageListHandler from "../campaigns/packages/[campaignId].get.js";
import packageZipHandler from "../campaigns/packages/[campaignId]/[platformZip].get.js";
import poolGetHandler from "../campaigns/pools/[briefId].get.js";
import outputHandler from "../output/[...path].get.js";
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

describe("cross-tenant id-taking reads (PT-2a item 3)", () => {
  test("GET /campaigns/assets answers 404 for another org's asset id on fs", async () => {
    const harness = setupFsHarness();
    try {
      await getAssetStore(LOCAL_TENANT).writeAsset("camp", "logo.png", PNG);

      const callAcme = mountTenantRoute(assetsGetHandler, {
        path: "/campaigns/assets",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/assets?briefId=camp&name=logo.png"),
      );
      expect(resAcme.status).toBe(404);
      expect(await resAcme.json()).toEqual({ error: 'Asset "logo.png" not found.' });

      const callLocal = mountTenantRoute(assetsGetHandler, {
        path: "/campaigns/assets",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(
        new Request("http://x/campaigns/assets?briefId=camp&name=logo.png"),
      );
      expect(resLocal.status).toBe(200);
    } finally {
      harness.cleanup();
    }
  });

  test("GET /campaigns/jobs/:id answers 404 for another org's job id on fs", async () => {
    const harness = setupFsHarness();
    try {
      const jobId = await createJob(LOCAL_TENANT, "camp");

      const callAcme = mountTenantRoute(jobGetHandler, {
        path: "/campaigns/jobs/:id",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request(`http://x/campaigns/jobs/${jobId}`));
      expect(resAcme.status).toBe(404);
      expect(await resAcme.json()).toEqual({ error: "Job not found" });

      const callLocal = mountTenantRoute(jobGetHandler, {
        path: "/campaigns/jobs/:id",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request(`http://x/campaigns/jobs/${jobId}`));
      expect(resLocal.status).toBe(200);
    } finally {
      harness.cleanup();
    }
  });

  test("GET /campaigns/jobs/:id answers 404 for another org's job id on postgres", async () => {
    const harness = await setupPgHarness();
    try {
      const jobId = await createJob(LOCAL_TENANT, "camp");

      const callAcme = mountTenantRoute(jobGetHandler, {
        path: "/campaigns/jobs/:id",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request(`http://x/campaigns/jobs/${jobId}`));
      expect(resAcme.status).toBe(404);
      expect(await resAcme.json()).toEqual({ error: "Job not found" });

      const callLocal = mountTenantRoute(jobGetHandler, {
        path: "/campaigns/jobs/:id",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request(`http://x/campaigns/jobs/${jobId}`));
      expect(resLocal.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  test("GET /campaigns/packages/:campaignId answers 404 for another org's packages on fs", async () => {
    const harness = setupFsHarness();
    try {
      const pkgDir = join(harness.outputRoot, "packages", "camp", "instagram-feed");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "manifest.json"), "{}");

      const callAcme = mountTenantRoute(packageListHandler, {
        path: "/campaigns/packages/:campaignId",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request("http://x/campaigns/packages/camp"));
      expect(resAcme.status).toBe(404);
      expect(await resAcme.json()).toEqual({ error: "No packages found" });

      const callLocal = mountTenantRoute(packageListHandler, {
        path: "/campaigns/packages/:campaignId",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request("http://x/campaigns/packages/camp"));
      expect(resLocal.status).toBe(200);
    } finally {
      harness.cleanup();
    }
  });

  test("GET /campaigns/packages/:campaignId/:platformZip answers 404 for another org's package zip on fs", async () => {
    const harness = setupFsHarness();
    try {
      const pkgDir = join(harness.outputRoot, "packages", "camp", "instagram-feed");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "manifest.json"), "{}");

      const callAcme = mountTenantRoute(packageZipHandler, {
        path: "/campaigns/packages/:campaignId/:platformZip",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(
        new Request("http://x/campaigns/packages/camp/instagram-feed.zip"),
      );
      expect(resAcme.status).toBe(404);
      expect(await resAcme.json()).toEqual({ error: "Not found" });

      const callLocal = mountTenantRoute(packageZipHandler, {
        path: "/campaigns/packages/:campaignId/:platformZip",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(
        new Request("http://x/campaigns/packages/camp/instagram-feed.zip"),
      );
      expect(resLocal.status).toBe(200);
    } finally {
      harness.cleanup();
    }
  });

  test("GET /campaigns/pools/:briefId answers 404 for another org's pool on fs", async () => {
    const harness = setupFsHarness();
    try {
      await writePool(LOCAL_TENANT, {
        briefId: "camp",
        generatedAt: "2026-09-24T00:00:00.000Z",
        model: "test-model",
        entries: [{ id: "h1", text: "headline", status: "approved" }],
      });

      const callAcme = mountTenantRoute(poolGetHandler, {
        path: "/campaigns/pools/:briefId",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request("http://x/campaigns/pools/camp"));
      expect(resAcme.status).toBe(404);
      expect(await resAcme.json()).toEqual({
        error: 'Headline pool for brief "camp" not found.',
      });

      const callLocal = mountTenantRoute(poolGetHandler, {
        path: "/campaigns/pools/:briefId",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request("http://x/campaigns/pools/camp"));
      expect(resLocal.status).toBe(200);
    } finally {
      harness.cleanup();
    }
  });

  test("GET /campaigns/pools/:briefId answers 404 for another org's pool on postgres", async () => {
    const harness = await setupPgHarness();
    try {
      await writePool(LOCAL_TENANT, {
        briefId: "camp",
        generatedAt: "2026-09-24T00:00:00.000Z",
        model: "test-model",
        entries: [{ id: "h1", text: "headline", status: "approved" }],
      });

      const callAcme = mountTenantRoute(poolGetHandler, {
        path: "/campaigns/pools/:briefId",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request("http://x/campaigns/pools/camp"));
      expect(resAcme.status).toBe(404);
      expect(await resAcme.json()).toEqual({
        error: 'Headline pool for brief "camp" not found.',
      });

      const callLocal = mountTenantRoute(poolGetHandler, {
        path: "/campaigns/pools/:briefId",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request("http://x/campaigns/pools/camp"));
      expect(resLocal.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  test("GET /output/** answers 404 for another org's output path on fs", async () => {
    const harness = setupFsHarness();
    try {
      const outDir = join(harness.outputRoot, "camp", "renders");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "hero.png"), PNG);

      const callAcme = mountTenantRoute(outputHandler, {
        path: "/output/**:path",
        tenant: ACME_TENANT,
      });
      const resAcme = await callAcme(new Request("http://x/output/camp/renders/hero.png"));
      expect(resAcme.status).toBe(404);
      expect(await resAcme.json()).toEqual({ error: "Not found" });

      const callLocal = mountTenantRoute(outputHandler, {
        path: "/output/**:path",
        tenant: LOCAL_TENANT,
      });
      const resLocal = await callLocal(new Request("http://x/output/camp/renders/hero.png"));
      expect(resLocal.status).toBe(200);
    } finally {
      harness.cleanup();
    }
  });
});
