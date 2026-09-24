import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsDecisionStore } from "../fs-decision-store.js";

const record = { verdict: "approved" as const, actor: "local", at: "2026-09-24T00:00:00.000Z" };

describe("FsDecisionStore", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cf-decision-store-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a campaign's decisions round-trip, and a campaign with none reads as {}", async () => {
    const store = new FsDecisionStore(root);
    await expect(store.readDecisions("camp")).resolves.toEqual({});
    await store.writeDecisions("camp", { "alpha/v0": record });
    await expect(store.readDecisions("camp")).resolves.toEqual({ "alpha/v0": record });
    expect(readdirSync(join(root, "decisions"))).toEqual(["camp.json"]); // no temp left behind
  });

  test("an unsafe campaign id reads as {} and cannot be written", async () => {
    const store = new FsDecisionStore(root);
    await expect(store.readDecisions("../evil")).resolves.toEqual({});
    await expect(store.writeDecisions("../evil", {})).rejects.toThrow(/is not a safe id/);
  });

  test("a record that exists but cannot be read or parsed rejects: it is not the same as none", async () => {
    const store = new FsDecisionStore(root);
    mkdirSync(join(root, "decisions"), { recursive: true });
    writeFileSync(join(root, "decisions", "camp.json"), "{not json");
    await expect(store.readDecisions("camp")).rejects.toThrow(SyntaxError);
    mkdirSync(join(root, "decisions", "dir.json"));
    await expect(store.readDecisions("dir")).rejects.toMatchObject({ code: "EISDIR" });
  });

  test("a write that fails leaves no temp file behind", async () => {
    const store = new FsDecisionStore(root);
    mkdirSync(join(root, "decisions", "camp.json"), { recursive: true }); // rename onto a dir fails
    await expect(store.writeDecisions("camp", {})).rejects.toBeDefined();
    expect(readdirSync(join(root, "decisions")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a staging write that fails before its temp exists surfaces that failure, not the cleanup's",
    async () => {
      const store = new FsDecisionStore(root);
      mkdirSync(join(root, "decisions"), { recursive: true });
      chmodSync(join(root, "decisions"), 0o500); // the temp cannot be created
      try {
        await expect(store.writeDecisions("camp", {})).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        chmodSync(join(root, "decisions"), 0o700);
      }
    },
  );
});
