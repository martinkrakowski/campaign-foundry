import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CampaignBrief, CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { isBriefSourceName } from "../brief-files.js";

const origRoot = process.env.PROJECT_ROOT;

const pool = (over: Partial<CopyPool> = {}): CopyPool => ({
  briefId: "camp",
  generatedAt: "2026-01-01T00:00:00.000Z",
  model: "openai/gpt-4o-mini",
  entries: [{ id: "h1", text: "Stay wild", status: "approved" }],
  ...over,
});

const filesFor = async (root: string) => {
  vi.resetModules();
  process.env.PROJECT_ROOT = root;
  return import("../pools.js");
};

describe("copy pool persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-pools-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
  });

  test("writePool then readPool round-trips JSON under briefs/<id>/pools.json", async () => {
    const { writePool, readPool, poolPath } = await filesFor(dir);
    const value = pool();
    await writePool(value);
    expect(await readPool("camp")).toEqual(value);
    expect(poolPath("camp")).toBe(join(dir, "briefs", "camp", "pools.json"));
    expect(JSON.parse(readFileSync(join(dir, "briefs", "camp", "pools.json"), "utf8"))).toEqual(value);
  });

  test("readPool returns undefined when the file is missing", async () => {
    const { readPool } = await filesFor(dir);
    expect(await readPool("camp")).toBeUndefined();
  });

  test("poolPath stays under briefs/ and rejects a traversing id segment", async () => {
    const { poolPath } = await filesFor(dir);
    expect(() => poolPath("../escape")).toThrow(/Path escapes the allowed directory/);
  });

  test("a briefs/<id>/ directory is not listed as a brief source", async () => {
    const { writePool } = await filesFor(dir);
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(
      join(dir, "briefs", "camp.yaml"),
      "id: camp\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n  - id: beta\n",
    );
    await writePool(pool());

    const { findBriefById } = await import("../brief-files.js");
    expect(await findBriefById("camp")).toMatchObject({
      path: join(dir, "briefs", "camp.yaml"),
      brief: { id: "camp" },
    });
    const listed = readdirSync(join(dir, "briefs"), { withFileTypes: true })
      .filter((e) => e.isFile() && isBriefSourceName(e.name))
      .map((e) => e.name);
    expect(listed).toEqual(["camp.yaml"]);
  });

  test("writePool overwrites atomically and does not leave a tmp sibling", async () => {
    const { writePool, readPool } = await filesFor(dir);
    await writePool(pool());
    await writePool(pool({ entries: [{ id: "h2", text: "Stay hydrated", status: "approved" }] }));
    expect(await readPool("camp")).toMatchObject({ entries: [{ id: "h2" }] });
    expect(readdirSync(join(dir, "briefs", "camp"))).toEqual(["pools.json"]);
  });

  test("cleans up the temp file when the atomic rename fails", async () => {
    const { writePool } = await filesFor(dir);
    mkdirSync(join(dir, "briefs", "camp", "pools.json"), { recursive: true });
    await expect(writePool(pool())).rejects.toThrow();
    expect(readdirSync(join(dir, "briefs", "camp")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("a write that fails before the tmp exists still rejects", async () => {
    const { writePool } = await filesFor(dir);
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "camp"), "not-a-dir");
    await expect(writePool(pool())).rejects.toThrow();
  });

  test("readPool rethrows a non-ENOENT error", async () => {
    const { readPool } = await filesFor(dir);
    mkdirSync(join(dir, "briefs", "camp"), { recursive: true });
    writeFileSync(join(dir, "briefs", "camp", "pools.json"), "{not-json");
    await expect(readPool("camp")).rejects.toThrow();
  });
  test("concurrent writePool calls use distinct temp files and both settle", async () => {
    const { writePool, readPool } = await filesFor(dir);
    await Promise.all([
      writePool(pool()),
      writePool(pool({ entries: [{ id: "h2", text: "Stay hydrated", status: "approved" }] })),
    ]);
    expect((await readPool("camp"))?.entries).toHaveLength(1);
    expect(readdirSync(join(dir, "briefs", "camp"))).toEqual(["pools.json"]);
  });

  test("withPoolLock runs sections for one brief in order and does not block other briefs", async () => {
    const { withPoolLock } = await filesFor(dir);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withPoolLock("camp", async () => {
      await gate;
      order.push("first");
      return 1;
    });
    const second = withPoolLock("camp", async () => {
      order.push("second");
      return 2;
    });
    const other = withPoolLock("other", async () => {
      order.push("other");
      return 3;
    });
    expect(await other).toBe(3);
    expect(order).toEqual(["other"]);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(["other", "first", "second"]);
  });

  test("withPoolLock keeps serving a brief after a section rejects", async () => {
    const { withPoolLock } = await filesFor(dir);
    await expect(
      withPoolLock("camp", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withPoolLock("camp", async () => "ok")).toBe("ok");
  });

  test("isPoolDirSymlink is false when missing or a real dir, true for a symlink, and rethrows other errors", async () => {
    const { isPoolDirSymlink } = await filesFor(dir);
    expect(await isPoolDirSymlink("camp")).toBe(false);
    mkdirSync(join(dir, "briefs", "camp"), { recursive: true });
    expect(await isPoolDirSymlink("camp")).toBe(false);
    symlinkSync(join(dir, "briefs", "camp"), join(dir, "briefs", "linked"));
    expect(await isPoolDirSymlink("linked")).toBe(true);
    await expect(isPoolDirSymlink("../escape")).rejects.toThrow(/Path escapes the allowed directory/);
  });
});

describe("planInputFor / pooledPlanner", () => {
  let dir: string;
  const brief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
    id: "camp",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
    mode: "variation",
    variation: { count: 2, seed: 1, axes: { headline: "pool://copy" } },
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-pools-plan-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
  });

  test("returns nothing for briefs without the headline axis, without touching the pool", async () => {
    const { planInputFor, wantsHeadlinePool } = await filesFor(dir);
    const plain = brief({ variation: { count: 2 } });
    expect(wantsHeadlinePool(plain)).toBe(false);
    expect(await planInputFor(plain)).toEqual({});
    expect(await planInputFor(brief({ variation: undefined }))).toEqual({});
  });

  test("returns the approved texts when the brief draws from pool://copy, or an empty list without a pool", async () => {
    const { planInputFor, wantsHeadlinePool, writePool } = await filesFor(dir);
    expect(wantsHeadlinePool(brief())).toBe(true);
    expect(await planInputFor(brief())).toEqual({ headlines: [] });
    await writePool(
      pool({
        entries: [
          { id: "h1", text: "Stay wild", status: "approved" },
          { id: "h2", text: "A miracle", status: "rejected", reason: "legal" },
          { id: "h3", text: "Go far", status: "approved" },
        ],
      }),
    );
    expect(await planInputFor(brief())).toEqual({ headlines: ["Stay wild", "Go far"] });
  });

  test("pooledPlanner binds the input to plan and forwards replan", async () => {
    const { pooledPlanner } = await filesFor(dir);
    const planner = pooledPlanner({ headlines: ["Stay wild", "Go far"] });
    const planned = planner.plan(brief());
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    expect(planned.value.variants.map((v) => v.headline).every((h) => h === "Stay wild" || h === "Go far")).toBe(true);
    const replanned = planner.replan(planned.value, 0, 1);
    expect(replanned.success).toBe(true);
    const bad = planner.replan(planned.value, 9, 1);
    expect(bad.success).toBe(false);
    expect(pooledPlanner({}).plan(brief()).success).toBe(false);
  });
});
