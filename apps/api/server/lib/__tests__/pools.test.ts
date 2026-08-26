import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
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
});
