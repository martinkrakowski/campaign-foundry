import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import { acquireJob, resetJobs } from "../../../../lib/jobs.js";
import { resetJobStore } from "../../../../lib/ports/index.js";
import { LOCAL_TENANT, type TenantContext } from "../../../../lib/tenant.js";
import handler from "../index.get.js";

const api = (tenant?: TenantContext) => {
  const app = createApp();
  if (tenant) {
    app.use(
      defineEventHandler((event) => {
        event.context.tenant = tenant;
      }),
    );
  }
  const router = createRouter();
  router.get("/campaigns/jobs", handler);
  app.use(router);
  return toWebHandler(app);
};

const get = (query: string, tenant?: TenantContext) =>
  api(tenant)(new Request(`http://x/campaigns/jobs${query}`));

describe("GET /campaigns/jobs?campaignId=", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-jobs-route-"));
    process.env.OUTPUT_DIR = join(dir, "output");
    process.env.PROJECT_ROOT = dir;
    resetJobStore();
    await resetJobs();
  });

  afterEach(async () => {
    await resetJobs();
    resetJobStore();
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns 400 for a missing campaignId", async () => {
    const res = await get("");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid campaign id" });
  });

  test("returns 400 for an invalid campaignId", async () => {
    const res = await get("?campaignId=Invalid_Campaign!");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid campaign id" });
  });

  test("returns 404 when no run holds the campaign", async () => {
    const res = await get("?campaignId=test-campaign");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "No running job for campaign" });
  });

  test("returns { jobId } when a run holds the campaign", async () => {
    const claim = await acquireJob(LOCAL_TENANT, "test-campaign");
    expect(claim.acquired).toBe(true);
    if (!claim.acquired) return;

    const res = await get("?campaignId=test-campaign");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ jobId: claim.jobId });
  });

  test("returns 404 when a job is held under a different tenant", async () => {
    const claim = await acquireJob(LOCAL_TENANT, "test-campaign");
    expect(claim.acquired).toBe(true);

    const acmeTenant: TenantContext = {
      orgId: "acme",
      userId: "u1",
      roles: ["member"],
      teamIds: [],
    };
    const res = await get("?campaignId=test-campaign", acmeTenant);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "No running job for campaign" });
  });
});
