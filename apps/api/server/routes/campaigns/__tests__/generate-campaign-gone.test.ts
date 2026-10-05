import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import { resetProjectRoot } from "@campaignfoundry/shared";
import { setCapabilities } from "../../../lib/capabilities.js";
import { resetJobs } from "../../../lib/jobs.js";
import { getBriefStore, resetProviderKeyStore, resetUsageStore } from "../../../lib/ports/index.js";
import { LOCAL_TENANT } from "../../../lib/tenant.js";
import generateHandler from "../generate.post.js";

// PT-9c's 404 arm is reached ONLY when `enqueueJob` throws `CampaignGoneError`,
// so the mock must throw the REAL class (the route checks `instanceof`). The
// class is fetched with a dynamic `await import(...)` inside the mock factory —
// never a top-level import — because a top-level reference would make the
// hoisted `vi.fn` depend on an import the factory is queued ahead of. The
// factory spreads `actual`, so `resetJobs` stays real for `afterEach`.
//
// NOTE (deviation from the brief's literal sketch): the brief wrote this as
// `const enqueueMock = vi.hoisted(async () => {...return vi.fn(...)})`, an async
// hoisted factory. In vitest 4.1.8 `vi.hoisted` does NOT await an async factory —
// it stores the returned Promise as-is, so `enqueueJob: enqueueMock` would hand
// the route a Promise and the call `enqueueJob(env, brief.id)` would throw
// "not a function" (500, not 404). The shape below is the same intent — a hoisted
// `vi.fn` whose throwing impl is installed inside the (async) mock factory after
// the real class is dynamically imported — and it is the only difference.
const enqueueMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/jobs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/jobs.js")>();
  const { CampaignGoneError } = await import("../../../lib/ports/job-store.port.js");
  enqueueMock.mockImplementation(async () => {
    throw new CampaignGoneError("camp");
  });
  return { ...actual, enqueueJob: enqueueMock };
});

const brief = (over: Record<string, unknown> = {}) => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
  ],
  ...over,
});

describe("POST /campaigns/generate — a claim refused as CampaignGoneError answers 404 with the route's not-found body", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;
  const origRoot = process.env.PROJECT_ROOT;

  const call = (body: unknown, model = "procedural") => {
    const app = createApp();
    const router = createRouter();
    router.post("/campaigns/generate", generateHandler);
    app.use(router);
    const query = model ? `?model=${model}` : "";
    return toWebHandler(app)(
      new Request(`http://x/campaigns/generate${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-generate-gone-"));
    process.env.OUTPUT_DIR = dir;
    // PT-5c2: generate now requires a known campaign — isolate PROJECT_ROOT
    // (never the ambient one) and mint "camp" every test here sends.
    process.env.PROJECT_ROOT = dir;
    resetProjectRoot();
    await getBriefStore(LOCAL_TENANT).createCampaign("camp");
    setCapabilities({ motion: true });
    enqueueMock.mockClear();
  });
  afterEach(async () => {
    await resetJobs();
    resetUsageStore();
    resetProviderKeyStore();
    rmSync(dir, { recursive: true, force: true });
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    resetProjectRoot();
    setCapabilities({ motion: false, reason: "not probed" });
  });

  // Title is pinned: the manifest/one-shot mutation key off it by name.
  test("a claim refused as CampaignGoneError answers 404 with the route's not-found body", async () => {
    const res = await call(brief());

    // Without the createCampaign above, campaignMeta (:116) answers the same 404
    // body on main — so reaching the claim is what makes the refusal (not the
    // gate) the source of the 404. `toHaveBeenCalledOnce` pins that: a reverted
    // catch arm lets the rejection reach h3 as a 500 instead.
    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Campaign "camp" not found.` });
  });
});
