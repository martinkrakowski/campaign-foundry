import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes } from "../../brief-files.js";
import { FsDecisionStore } from "../fs-decision-store.js";

const record = {
  verdict: "approved" as const,
  actor: "local",
  at: "2026-09-24T00:00:00.000Z",
  run: "run-1",
};

describe("FsDecisionStore", () => {
  let root: string;
  const file = (id: string) => join(root, "decisions", `${id}.json`);
  const seed = (id: string, text: string) => {
    mkdirSync(join(root, "decisions"), { recursive: true });
    writeFileSync(file(id), text);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cf-decision-store-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("decisions round-trip with the revision of the bytes written; none reads as {} at null", async () => {
    const store = new FsDecisionStore(root);
    await expect(store.readDecisions("camp")).resolves.toEqual({ decisions: {}, revision: null });
    const revision = await store.writeDecisions("camp", { "alpha/v0": record });
    expect(revision).toBe(hashBytes(await readFile(file("camp"))));
    const read = await store.readDecisions("camp");
    expect({ ...read.decisions }).toEqual({ "alpha/v0": record });
    expect(read.revision).toBe(revision);
    expect(readdirSync(join(root, "decisions"))).toEqual(["camp.json"]); // no temp left behind
  });

  test("a stored `__proto__` key reads back as its own entry, and nothing is inherited", async () => {
    seed("camp", `{"__proto__": ${JSON.stringify(record)}}`);
    const { decisions } = await new FsDecisionStore(root).readDecisions("camp");
    expect(Object.keys(decisions)).toEqual(["__proto__"]);
    expect(Object.hasOwn(decisions, "__proto__")).toBe(true);
    expect((decisions as Record<string, unknown>).toString).toBeUndefined();
  });

  test("an unsafe campaign id reads as none and cannot be written", async () => {
    const store = new FsDecisionStore(root);
    await expect(store.readDecisions("../evil")).resolves.toEqual({
      decisions: {},
      revision: null,
    });
    await expect(store.writeDecisions("../evil", {})).rejects.toThrow(/is not a safe id/);
  });

  test("a record that exists but cannot be read or parsed rejects: it is not the same as none", async () => {
    const store = new FsDecisionStore(root);
    seed("camp", "{not json");
    await expect(store.readDecisions("camp")).rejects.toThrow(SyntaxError);
    mkdirSync(join(root, "decisions", "dir.json"));
    await expect(store.readDecisions("dir")).rejects.toMatchObject({ code: "EISDIR" });
  });

  test.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a record without a run", JSON.stringify({ k: { verdict: "approved", actor: "a", at: "t" } })],
    [
      "a record without an actor",
      JSON.stringify({ k: { verdict: "approved", at: "t", run: "r" } }),
    ],
    [
      "a record without a time",
      JSON.stringify({ k: { verdict: "approved", actor: "a", run: "r" } }),
    ],
    ["an unknown verdict", JSON.stringify({ k: { ...record, verdict: "maybe" } })],
    ["a primitive record", JSON.stringify({ k: "approved" })],
  ])("a record that parses but is %s rejects rather than casting", async (_label, text) => {
    seed("camp", text);
    await expect(new FsDecisionStore(root).readDecisions("camp")).rejects.toThrow(
      /are not a decision map/,
    );
  });

  test("a write that fails leaves no temp file behind", async () => {
    const store = new FsDecisionStore(root);
    mkdirSync(file("camp"), { recursive: true }); // rename onto a dir fails
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
