import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpBrief } from "../brief-files.js";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";

const origRoot = process.env.PROJECT_ROOT;

const minimal: CampaignBrief = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "x.png" }],
};

describe("dumpBrief", () => {
  test("emits sample-campaign key order and omits absent optionals", () => {
    const dumped = dumpBrief(minimal);
    expect([...dumped.matchAll(/^([a-zA-Z]+):/gm)].map((m) => m[1])).toEqual([
      "id",
      "targetRegion",
      "targetAudience",
      "campaignMessage",
      "products",
    ]);
    expect(dumped).not.toMatch(/^localizedMessage:/m);
    expect(dumped).not.toMatch(/^treatments:/m);
  });

  test("includes optional keys in sample order when present", () => {
    const dumped = dumpBrief({
      ...minimal,
      localizedMessage: "Hallo",
      treatments: [{ id: "bold-bottom", layout: "headline-bottom", tone: "bold" }],
      mode: "variation",
      variation: { count: 4 },
      output: { formats: ["static"] },
    });
    expect([...dumped.matchAll(/^([a-zA-Z]+):/gm)].map((m) => m[1])).toEqual([
      "id",
      "targetRegion",
      "targetAudience",
      "campaignMessage",
      "localizedMessage",
      "products",
      "treatments",
      "mode",
      "variation",
      "output",
    ]);
  });
});

describe("brief file lookup and write", () => {
  let dir: string;

  const filesFor = async (root: string) => {
    vi.resetModules();
    process.env.PROJECT_ROOT = root;
    return import("../brief-files.js");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-brief-files-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
  });

  test("findBriefFile prefers yaml, then yml, then json, and skips non-files", async () => {
    const { findBriefFile, BRIEF_SOURCE_EXTS, BRIEF_YAML_EXTS } = await filesFor(dir);
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "both.yaml"), "id: both\n");
    writeFileSync(join(dir, "briefs", "both.yml"), "id: both\n");
    expect(await findBriefFile("both", BRIEF_SOURCE_EXTS)).toBe(join(dir, "briefs", "both.yaml"));

    mkdirSync(join(dir, "briefs", "only-dir.yaml"), { recursive: true }); // not a file → skipped
    writeFileSync(join(dir, "briefs", "only-dir.yml"), "id: only-dir\n");
    expect(await findBriefFile("only-dir", BRIEF_YAML_EXTS)).toBe(join(dir, "briefs", "only-dir.yml"));

    writeFileSync(join(dir, "briefs", "json-only.json"), "{}");
    expect(await findBriefFile("json-only")).toBe(join(dir, "briefs", "json-only.json"));
    expect(await findBriefFile("missing", BRIEF_SOURCE_EXTS)).toBeUndefined();
  });

  test("pathExists is true for any inode and false when missing", async () => {
    const { pathExists, writeBriefFile, briefYamlPath } = await filesFor(dir);
    const path = briefYamlPath("camp");
    expect(await pathExists(path)).toBe(false);
    await writeBriefFile(path, minimal);
    expect(await pathExists(path)).toBe(true);
  });

  test("briefYamlPath stays under briefs/ and rejects a traversing id segment", async () => {
    const { briefYamlPath } = await filesFor(dir);
    expect(briefYamlPath("camp")).toBe(join(dir, "briefs", "camp.yaml"));
    expect(() => briefYamlPath("../escape")).toThrow(/Path escapes the allowed directory/);
  });
});
