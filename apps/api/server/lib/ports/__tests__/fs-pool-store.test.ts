import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { FsPoolStore } from "../fs-pool-store.js";
import { InvalidCopyPoolError } from "../pool-store.port.js";

const pool = (over: Partial<CopyPool> = {}): CopyPool => ({
  briefId: "camp",
  generatedAt: "2026-01-01T00:00:00.000Z",
  model: "openai/gpt-4o-mini",
  entries: [{ id: "h1", text: "Stay wild", status: "approved" }],
  ...over,
});

describe("FsPoolStore", () => {
  let dir: string;
  let store: FsPoolStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-fs-pool-"));
    mkdirSync(dir, { recursive: true });
    store = new FsPoolStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("poolPath is the confined pools.json path and rejects a traversing id segment", () => {
    expect(store.poolPath("camp")).toBe(join(dir, "camp", "pools.json"));
    expect(() => store.poolPath("../escape")).toThrow(/Path escapes the allowed directory/);
  });

  test("writePool then readPool round-trips JSON under briefs/<id>/pools.json", async () => {
    const value = pool();
    await store.writePool(value);
    expect(await store.readPool("camp")).toEqual(value);
    expect(JSON.parse(readFileSync(join(dir, "camp", "pools.json"), "utf8"))).toEqual(value);
  });

  test("readPool returns undefined when the file is missing", async () => {
    expect(await store.readPool("camp")).toBeUndefined();
  });

  test("writePool overwrites atomically and does not leave a tmp sibling", async () => {
    await store.writePool(pool());
    await store.writePool(pool({ entries: [{ id: "h2", text: "Stay hydrated", status: "approved" }] }));
    expect(await store.readPool("camp")).toMatchObject({ entries: [{ id: "h2" }] });
    expect(readdirSync(join(dir, "camp"))).toEqual(["pools.json"]);
  });

  test("cleans up the temp file when the atomic rename fails", async () => {
    mkdirSync(join(dir, "camp", "pools.json"), { recursive: true });
    await expect(store.writePool(pool())).rejects.toThrow();
    expect(readdirSync(join(dir, "camp")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("a write that fails before the tmp exists still rejects", async () => {
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, "camp"), "not-a-dir");
    await expect(store.writePool(pool())).rejects.toThrow();
  });

  test("readPool rejects a file that is not JSON as an invalid pool naming the file", async () => {
    mkdirSync(join(dir, "camp"), { recursive: true });
    writeFileSync(join(dir, "camp", "pools.json"), "{not-json");
    await expect(store.readPool("camp")).rejects.toThrow(InvalidCopyPoolError);
    await expect(store.readPool("camp")).rejects.toThrow(/^Copy pool briefs\/camp\/pools\.json is invalid: not JSON/);
  });

  test("readPool rethrows a non-ENOENT filesystem error", async () => {
    mkdirSync(join(dir, "camp", "pools.json"), { recursive: true });
    await expect(store.readPool("camp")).rejects.toThrow(/EISDIR/);
  });

  test.each([
    ["a non-object", "[]", "must be an object"],
    ["a missing briefId", { generatedAt: "t", model: "m", entries: [] }, "briefId must be a string"],
    ["a non-string generatedAt", { briefId: "camp", generatedAt: 1, model: "m", entries: [] }, "generatedAt must be a string"],
    ["a non-string model", { briefId: "camp", generatedAt: "t", model: null, entries: [] }, "model must be a string"],
    ["missing entries", { briefId: "camp", generatedAt: "t", model: "m" }, "entries must be an array"],
    ["a non-object entry", { briefId: "camp", generatedAt: "t", model: "m", entries: ["x"] }, "entries[0] must be an object"],
    [
      "an entry without an id",
      { briefId: "camp", generatedAt: "t", model: "m", entries: [{ id: "", text: "x", status: "approved" }] },
      "entries[0].id must be a non-empty string",
    ],
    [
      "a duplicate entry id",
      {
        briefId: "camp",
        generatedAt: "t",
        model: "m",
        entries: [
          { id: "h1", text: "x", status: "approved" },
          { id: "h1", text: "y", status: "approved" },
        ],
      },
      'entries[1].id "h1" appears more than once',
    ],
    [
      "a non-string text",
      { briefId: "camp", generatedAt: "t", model: "m", entries: [{ id: "h1", text: 42, status: "approved" }] },
      "entries[0].text must be a string",
    ],
    [
      "an unknown status",
      { briefId: "camp", generatedAt: "t", model: "m", entries: [{ id: "h1", text: "x", status: "maybe" }] },
      'entries[0].status must be "approved" or "rejected"',
    ],
    [
      "a non-string reason",
      { briefId: "camp", generatedAt: "t", model: "m", entries: [{ id: "h1", text: "x", status: "rejected", reason: 1 }] },
      "entries[0].reason must be a string",
    ],
  ])("readPool rejects a hand-edited pool with %s, naming the file and the problem", async (_label, content, problem) => {
    mkdirSync(join(dir, "camp"), { recursive: true });
    const raw = typeof content === "string" ? content : JSON.stringify(content);
    writeFileSync(join(dir, "camp", "pools.json"), raw);
    await expect(store.readPool("camp")).rejects.toThrow(InvalidCopyPoolError);
    await expect(store.readPool("camp")).rejects.toThrow(`Copy pool briefs/camp/pools.json is invalid: ${problem}.`);
  });

  test("concurrent writePool calls use distinct temp files and both settle", async () => {
    await Promise.all([
      store.writePool(pool()),
      store.writePool(pool({ entries: [{ id: "h2", text: "Stay hydrated", status: "approved" }] })),
    ]);
    expect((await store.readPool("camp"))?.entries).toHaveLength(1);
    expect(readdirSync(join(dir, "camp"))).toEqual(["pools.json"]);
  });

  test("copyPool copies the pool and rewrites the pool's own briefId to the destination", async () => {
    await store.writePool(pool({ entries: [{ id: "h1", text: "Stay wild", status: "approved" }] }));
    const copied = await store.copyPool("camp", "copy");
    expect(copied).toMatchObject({ briefId: "copy", entries: [{ id: "h1", text: "Stay wild", status: "approved" }] });
    // the byte copy would have named the old brief — the stored pool must not
    expect(JSON.parse(readFileSync(join(dir, "copy", "pools.json"), "utf8")).briefId).toBe("copy");
    // the source pool is untouched
    expect(await store.readPool("camp")).toMatchObject({ briefId: "camp" });
  });

  test("copyPool resolves undefined when the source has no pool", async () => {
    expect(await store.copyPool("camp", "copy")).toBeUndefined();
    expect(existsSync(join(dir, "copy", "pools.json"))).toBe(false);
  });

  test("copyPool refuses a symlinked briefs/<to> directory without writing through it", async () => {
    await store.writePool(pool());
    const elsewhere = join(tmpdir(), "cf-fs-pool-outside");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(dir, "copy"));
    await expect(store.copyPool("camp", "copy")).rejects.toThrow("Refusing to write through a symlink.");
    expect(existsSync(join(elsewhere, "pools.json"))).toBe(false);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
