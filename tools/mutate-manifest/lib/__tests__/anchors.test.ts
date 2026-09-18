import { describe, expect, test, vi } from "vitest";
import {
  anchorExitCode,
  checkAnchors,
  EXIT_DEAD,
  EXIT_LIVE,
  formatAnchorReport,
  type AnchorDeps,
} from "../anchors.js";

const mutation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  file: "src/target.ts",
  before: "const gate = true;",
  after: "const gate = false;",
  because: "the guard must red",
  command: ["yarn", "t"],
  verdict: "caught",
  ...over,
});

const manifestText = (...mutations: readonly Record<string, unknown>[]): string =>
  JSON.stringify({ version: 1, lane: "W4", mutations });

/** A fake filesystem: path -> contents, or `{ throws }` to reject with exactly that value. */
const fs = (files: Record<string, string | { throws: unknown }>): AnchorDeps => ({
  readText: async (path) => {
    const value = files[path];
    if (value === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
    if (typeof value !== "string") throw value.throws;
    return value;
  },
});

describe("checkAnchors", () => {
  test("passes an anchor that still appears exactly once", async () => {
    const report = await checkAnchors(
      ["m.json"],
      fs({ "m.json": manifestText(mutation()), "src/target.ts": "const gate = true;\n" }),
    );
    expect(report).toEqual({ manifests: 1, mutations: 1, retired: 0, faults: [] });
  });

  test("fails an anchor whose text is gone, and says the mutation can never replay", async () => {
    const report = await checkAnchors(
      ["m.json"],
      fs({ "m.json": manifestText(mutation()), "src/target.ts": "const gate = TRUE;\n" }),
    );
    expect(report.faults).toEqual([
      {
        kind: "not-exactly-once",
        manifest: "m.json",
        index: 0,
        mutation: expect.anything(),
        occurrences: 0,
      },
    ]);
    expect(formatAnchorReport(report)).toContain("can never replay again");
  });

  test("fails an AMBIGUOUS anchor too — Rule 2 refuses two occurrences as firmly as none", async () => {
    const report = await checkAnchors(
      ["m.json"],
      fs({
        "m.json": manifestText(mutation()),
        "src/target.ts": "const gate = true;\nconst gate = true;\n",
      }),
    );
    expect(report.faults[0]).toMatchObject({ kind: "not-exactly-once", occurrences: 2 });
  });

  test("reports a file that is gone as its own fault, not as a missing anchor", async () => {
    const report = await checkAnchors(["m.json"], fs({ "m.json": manifestText(mutation()) }));
    expect(report.faults[0]).toMatchObject({ kind: "missing-file", manifest: "m.json", index: 0 });
    expect(formatAnchorReport(report)).toContain("FILE GONE  m.json#0");
  });

  test("carries a non-Error rejection through rather than losing what happened", async () => {
    const report = await checkAnchors(
      ["m.json"],
      fs({ "m.json": manifestText(mutation()), "src/target.ts": { throws: "EACCES" } }),
    );
    expect(report.faults[0]).toMatchObject({ kind: "missing-file", detail: "EACCES" });
  });

  test("skips a retired mutation and counts it, rather than hunting for text it admits is gone", async () => {
    const report = await checkAnchors(
      ["m.json"],
      fs({ "m.json": manifestText(mutation({ retired: "the subject was deleted in #468" })) }),
    );
    expect(report).toEqual({ manifests: 1, mutations: 1, retired: 1, faults: [] });
    expect(formatAnchorReport(report)).toContain("0 live, 1 retired");
  });

  test("reads each source file once however many manifests anchor into it", async () => {
    const readText = vi.fn(async (path: string) =>
      path.endsWith(".json") ? manifestText(mutation()) : "const gate = true;\n",
    );
    await checkAnchors(["a.json", "b.json", "c.json"], { readText });
    expect(readText.mock.calls.filter(([p]) => p === "src/target.ts")).toHaveLength(1);
  });

  test("a manifest it cannot read is a fault, never a skip", async () => {
    const report = await checkAnchors(["gone.json"], fs({}));
    expect(report.faults[0]).toMatchObject({ kind: "unreadable", manifest: "gone.json" });
    expect(anchorExitCode(report)).toBe(EXIT_DEAD);
  });

  test("carries a non-Error rejection from a manifest read through as well", async () => {
    const report = await checkAnchors(["m.json"], fs({ "m.json": { throws: "EPERM" } }));
    expect(report.faults[0]).toMatchObject({ kind: "unreadable", detail: "EPERM" });
  });

  test("a malformed manifest FAILS the check — including an unexplained retirement", async () => {
    const report = await checkAnchors(
      ["m.json"],
      fs({ "m.json": manifestText(mutation({ retired: true })) }),
    );
    expect(report.faults[0]).toMatchObject({ kind: "malformed", manifest: "m.json" });
    expect(report.faults[0]).toMatchObject({ detail: expect.stringContaining("non-empty reason") });
    expect(anchorExitCode(report)).toBe(EXIT_DEAD);
  });

  test("keeps checking the manifests after one it could not parse", async () => {
    const report = await checkAnchors(
      ["bad.json", "good.json"],
      fs({
        "bad.json": "{oops",
        "good.json": manifestText(mutation()),
        "src/target.ts": "const gate = TRUE;\n",
      }),
    );
    expect(report.faults.map((f) => f.kind)).toEqual(["malformed", "not-exactly-once"]);
  });
});

describe("formatAnchorReport", () => {
  test("says plainly when every live anchor resolves", async () => {
    const report = await checkAnchors(
      ["m.json"],
      fs({ "m.json": manifestText(mutation()), "src/target.ts": "const gate = true;\n" }),
    );
    expect(formatAnchorReport(report)).toBe(
      "anchors: 1 manifest(s), 1 mutation(s): 1 live, 0 retired. Every live anchor resolves exactly once.",
    );
  });

  test("names the manifest, the 0-based index, the file and the claim at stake", async () => {
    const report = await checkAnchors(
      ["m.json"],
      fs({
        "m.json": manifestText(mutation(), mutation({ before: "const other = 1;" })),
        "src/target.ts": "const gate = true;\n",
      }),
    );
    const text = formatAnchorReport(report);
    expect(text).toContain("DEAD ANCHOR  m.json#1");
    expect(text).toContain("file: src/target.ts");
    expect(text).toContain("because: the guard must red");
    expect(text).toContain("1 fault(s)");
    expect(text).toContain("retire it with a reason if the code is gone");
  });

  test("prints the detail of a manifest it could not parse", () => {
    expect(
      formatAnchorReport({
        manifests: 1,
        mutations: 0,
        retired: 0,
        faults: [{ kind: "malformed", manifest: "m.json", detail: "version must be 1" }],
      }),
    ).toContain("MALFORMED MANIFEST  m.json\n  version must be 1");
  });

  test("prints the detail of a manifest it could not read", () => {
    expect(
      formatAnchorReport({
        manifests: 1,
        mutations: 0,
        retired: 0,
        faults: [{ kind: "unreadable", manifest: "m.json", detail: "EACCES" }],
      }),
    ).toContain("UNREADABLE MANIFEST  m.json\n  EACCES");
  });
});

describe("anchorExitCode", () => {
  test("is zero only when nothing is dead", async () => {
    const live = await checkAnchors(
      ["m.json"],
      fs({ "m.json": manifestText(mutation()), "src/target.ts": "const gate = true;\n" }),
    );
    expect(anchorExitCode(live)).toBe(EXIT_LIVE);
  });
});
