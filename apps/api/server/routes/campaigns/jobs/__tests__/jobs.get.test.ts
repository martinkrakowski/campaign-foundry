import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createApp, createRouter, toWebHandler } from "h3";
import { acquireJob, resetJobs } from "../../../../lib/jobs.js";
import { LOCAL_TENANT } from "../../../../lib/tenant.js";
import handler from "../index.get.js";

const api = () => {
  const app = createApp();
  const router = createRouter();
  router.get("/campaigns/jobs", handler);
  app.use(router);
  return toWebHandler(app);
};

const get = (query: string) => api()(new Request(`http://x/campaigns/jobs${query}`));

describe("GET /campaigns/jobs?campaignId=", () => {
  beforeEach(async () => {
    await resetJobs();
  });
  afterEach(async () => {
    await resetJobs();
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
});
