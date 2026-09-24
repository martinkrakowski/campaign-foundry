import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import { getRunningJobId, resetJobs } from "../../../lib/jobs.js";
import { NOT_PROBED_REASON, setCapabilities } from "../../../lib/capabilities.js";
import generateHandler from "../generate.post.js";

import { LOCAL_TENANT } from "../../../lib/tenant.js";
const failing = { on: false };

vi.mock("../../../lib/run-environment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/run-environment.js")>();
  return {
    ...actual,
    runEnvironment: (...args: Parameters<typeof actual.runEnvironment>) => {
      if (failing.on) throw new Error("EACCES: .env.local is unreadable");
      return actual.runEnvironment(...args);
    },
  };
});

const brief = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "x.png" }],
};

/**
 * Review on #573 (Qodo): the run environment is resolved before the job is
 * claimed. Resolved after `acquireJob`, a throw would leave a persisted
 * "running" job that nothing settles, locking the campaign for good.
 */
describe("POST /campaigns/generate — the run environment is read before the claim", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-generate-env-"));
    process.env.OUTPUT_DIR = dir;
    // A post-boot server: the probe has landed, so the route does not wait on it.
    setCapabilities({ motion: true });
  });
  afterEach(async () => {
    failing.on = false;
    await resetJobs();
    setCapabilities({ motion: false, reason: NOT_PROBED_REASON });
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unreadable environment answers 500 and leaves no running job behind", async () => {
    failing.on = true;
    const app = createApp();
    const router = createRouter();
    router.post("/campaigns/generate", generateHandler);
    app.use(router);
    const res = await toWebHandler(app)(
      new Request("http://x/campaigns/generate?model=procedural", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(brief),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Could not read the run environment.",
      campaignId: "camp",
    });
    expect(await getRunningJobId(LOCAL_TENANT, "camp")).toBeUndefined();
  });
});
