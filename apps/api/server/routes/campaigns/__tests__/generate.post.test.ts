import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import { resetProjectRoot } from "@campaignfoundry/shared";
import {
  CANONICAL_TEMPLATES,
  templateFromCanonical,
  DEFAULT_CAMPAIGN_TYPE,
  type CreativeTemplate,
} from "@campaignfoundry/CampaignOrchestration";
import { setCapabilities } from "../../../lib/capabilities.js";
import { resetJobs } from "../../../lib/jobs.js";
import {
  getBriefStore,
  resetUsageStore,
  setTemplateStore,
  resetTemplateStore,
} from "../../../lib/ports/index.js";
import type { TemplateStorePort } from "../../../lib/ports/template-store.port.js";
import { LOCAL_TENANT } from "../../../lib/tenant.js";
import type { RunRequest } from "../../../lib/run-request.js";
import generateHandler from "../generate.post.js";

const ORG_ID = "tpl-123e4567-e89b-42d3-a456-426614174000";
const ORG_V1: CreativeTemplate = {
  ...CANONICAL_TEMPLATES["image-text"],
  id: ORG_ID,
  name: "Org Saved Image & Text",
};
const ORG_V2: CreativeTemplate = { ...ORG_V1, version: 2, name: "Org Saved Image & Text v2" };

// The claim is stubbed so the test can reach the pin resolution and the
// enqueued `RunRequest` without running the pipeline (see
// generate-campaign-gone.test.ts for the hoisting rules).
const enqueueMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/jobs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/jobs.js")>();
  enqueueMock.mockImplementation(() =>
    Promise.resolve({ acquired: true, jobId: "job-1", runningJobId: undefined }),
  );
  return { ...actual, enqueueJob: enqueueMock };
});

// Delivery is stubbed the same way: the route hands the RunRequest to
// `getRunDelivery(env).deliver`, and the stub is what the assertions read.
const deliverMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../../lib/ports/run-delivery-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/ports/run-delivery-registry.js")>();
  return { ...actual, getRunDelivery: () => ({ deliver: deliverMock }) };
});

const brief = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
  ],
  ...over,
});
const orgBrief = (over: Record<string, unknown> = {}) =>
  brief({ template: { ...templateFromCanonical(DEFAULT_CAMPAIGN_TYPE), id: ORG_ID }, ...over });

describe("POST /campaigns/generate — org template pins (RW-22)", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;
  const origRoot = process.env.PROJECT_ROOT;

  const call = () => {
    const app = createApp();
    const router = createRouter();
    router.post("/campaigns/generate", generateHandler);
    app.use(router);
    return toWebHandler(app)(
      new Request("http://x/campaigns/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  };
  let body: unknown;

  const store = (find: TemplateStorePort["findTemplate"]) => {
    setTemplateStore({
      listTemplates: () => Promise.resolve([]),
      exists: () => Promise.resolve(false),
      findTemplate: find,
    });
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-generate-pins-"));
    process.env.OUTPUT_DIR = dir;
    process.env.PROJECT_ROOT = dir;
    resetProjectRoot();
    await getBriefStore(LOCAL_TENANT).createCampaign("camp");
    setCapabilities({ motion: true });
    enqueueMock.mockClear();
    deliverMock.mockClear();
    body = undefined;
  });
  afterEach(async () => {
    await resetJobs();
    resetUsageStore();
    resetTemplateStore();
    rmSync(dir, { recursive: true, force: true });
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    resetProjectRoot();
    setCapabilities({ motion: false, reason: "not probed" });
  });

  test("refuses a missing org template with 400 naming template.id, before claiming any job", async () => {
    await store(() => Promise.resolve(undefined));
    body = orgBrief();
    const res = await call();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Campaign brief field "template.id" references unknown template "${ORG_ID}" (version 1).`,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
  });

  test("a cross-org pin answers the SAME 400 body as a missing one", async () => {
    await store(() => Promise.resolve(undefined)); // org B's store: org A's id is absent
    body = orgBrief();
    const res = await call();
    expect(res.status).toBe(400);
    const cross = await res.json();
    // the missing arm of the same message (identical body, no existence leak)
    expect(cross).toEqual({
      error: `Campaign brief field "template.id" references unknown template "${ORG_ID}" (version 1).`,
    });
  });

  test("refuses a version-mismatched pin with 400 before claiming any job", async () => {
    // the store's exact-match contract: an unknown version is undefined
    await store((_id: string, version?: number) =>
      Promise.resolve(version === 1 ? ORG_V1 : undefined),
    );
    body = orgBrief({
      template: { ...templateFromCanonical(DEFAULT_CAMPAIGN_TYPE), id: ORG_ID, version: 2 },
    });
    const res = await call();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Campaign brief field "template.id" references unknown template "${ORG_ID}" (version 2).`,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("accepts a brief pinned to org template v1 even after v2 is saved, and the run carries v1's materialised copy", async () => {
    const v1Layers = ORG_V1.layers;
    await store((_id: string, version?: number) =>
      Promise.resolve(version === 1 ? ORG_V1 : version === 2 ? ORG_V2 : undefined),
    );
    body = orgBrief();
    const res = await call();
    expect(res.status).toBe(202);
    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(deliverMock).toHaveBeenCalledOnce();
    const request = (deliverMock.mock.calls as unknown[][])[0]?.[0] as unknown as RunRequest;
    expect(request.brief.template.id).toBe(ORG_ID);
    expect(request.brief.template.version).toBe(1);
    expect(request.brief.template.layers).toEqual(v1Layers);
  });

  test("passes a canonical template with zero findTemplate lookups", async () => {
    const findTemplate = vi.fn(() => Promise.resolve(ORG_V1));
    await store(findTemplate);
    body = brief();
    const res = await call();
    expect(res.status).toBe(202);
    expect(findTemplate).not.toHaveBeenCalled();
  });

  test("a store read failure is a 500, never a 400", async () => {
    await store(() => Promise.reject(new Error("store on fire")));
    body = orgBrief();
    const res = await call();
    expect(res.status).toBe(500);
  });
});
