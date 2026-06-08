import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../generate.js";

const KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"];

const briefJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "camp",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [
      { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
      { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "assets/inputs/missing-logo.png" },
    ],
    ...over,
  });

describe("generate CLI main()", () => {
  let dir: string;
  const snap: Record<string, string | undefined> = {};
  const origOut = process.env.OUTPUT_DIR;
  const origExit = process.exitCode;

  beforeEach(() => {
    for (const k of KEYS) {
      snap[k] = process.env[k];
      delete process.env[k]; // force the offline procedural path
    }
    dir = mkdtempSync(join(tmpdir(), "cf-cli-"));
    process.env.OUTPUT_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = origExit;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    process.exitCode = origExit;
    vi.restoreAllMocks();
  });

  test("generates from the default sample brief and writes a report", async () => {
    await main(); // no arg → arg('--brief') ?? default sample brief
    expect(existsSync(resolve(dir, "report.json"))).toBe(true);
    expect(process.exitCode).not.toBe(1);
  });

  test("reads the brief path from the --brief argv flag", async () => {
    const path = join(dir, "argv.json");
    writeFileSync(path, briefJson());
    process.argv.push("--brief", path);
    try {
      await main(); // no arg → falls through to arg('--brief')
    } finally {
      process.argv.splice(-2, 2);
    }
    expect(existsSync(resolve(dir, "reports", "camp.json"))).toBe(true);
  });

  test("renders ok and warn rows (good logo vs missing logo)", async () => {
    const path = join(dir, "mixed.json");
    writeFileSync(path, briefJson());
    await main(path);
    expect(existsSync(resolve(dir, "reports", "camp.json"))).toBe(true);
  });

  test("exits 1 on a business-rule failure", async () => {
    const path = join(dir, "solo.json");
    writeFileSync(path, briefJson({ products: [{ id: "solo", name: "S", primaryColor: "#111111", logoPath: "x.png" }] }));
    await main(path);
    expect(process.exitCode).toBe(1);
  });

  test("warns and writes no creatives when the legal gate halts", async () => {
    const path = join(dir, "halt.json");
    writeFileSync(path, briefJson({ campaignMessage: "A guaranteed miracle cure" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await main(path);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/halted at the legal gate/);
  });
});
