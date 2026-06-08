import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";

const web = (handler: EventHandler) => {
  const app = createApp();
  const router = createRouter();
  router.get("/campaigns/briefs", handler);
  app.use(router);
  return toWebHandler(app);
};

/** Fresh handler import with PROJECT_ROOT pointed at `root` (projectRoot is memoized). */
const handlerFor = async (root: string): Promise<EventHandler> => {
  vi.resetModules();
  process.env.PROJECT_ROOT = root;
  return (await import("../briefs.get.js")).default;
};

const validBrief = "id: good\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n  - id: beta\n";

describe("GET /campaigns/briefs", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-briefs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    vi.restoreAllMocks();
  });

  test("lists parseable briefs and skips malformed ones", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "good.yaml"), validBrief);
    writeFileSync(join(dir, "briefs", "bad.yaml"), "id: 1\nproducts: not-an-array\n"); // invalid → skipped
    writeFileSync(join(dir, "briefs", "ignore.txt"), "not a brief"); // wrong extension → filtered
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await web(await handlerFor(dir))(new Request("http://x/campaigns/briefs"));
    const json = (await res.json()) as { briefs: { file: string; brief: { id: string } }[] };

    expect(json.briefs).toHaveLength(1);
    expect(json.briefs[0]).toMatchObject({ file: "good.yaml", brief: { id: "good" } });
    expect(warn).toHaveBeenCalled(); // logged the skipped malformed brief
  });

  test("returns an empty list when the briefs directory is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await web(await handlerFor(dir))(new Request("http://x/campaigns/briefs")); // no briefs/ dir
    expect((await res.json()) as { briefs: unknown[] }).toEqual({ briefs: [] });
    expect(warn).toHaveBeenCalled();
  });
});
