import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dumpBrief, hashFile, hashBytes, isErrno, isExistsError, serializeBrief, SYMLINK_WRITE_ERROR } from "../brief-files.js";
import { parseBriefText } from "../load-brief.js";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";

const origRoot = process.env.PROJECT_ROOT;

const minimal: CampaignBrief = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "x.png" }],
};

const validYaml =
  "id: camp\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n  - id: beta\n";

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

  test("emits unknown keys after the sample order", () => {
    const dumped = dumpBrief({ ...minimal, notes: "keep-me" } as CampaignBrief);
    expect([...dumped.matchAll(/^([a-zA-Z]+):/gm)].map((m) => m[1])).toEqual([
      "id",
      "targetRegion",
      "targetAudience",
      "campaignMessage",
      "products",
      "notes",
    ]);
  });
});

describe("serializeBrief", () => {
  test("dumps yaml for yaml/yml and JSON for json (by extension, case-insensitive)", () => {
    expect(serializeBrief("camp.yaml", minimal)).toBe(dumpBrief(minimal));
    expect(serializeBrief("camp.YML", minimal)).toBe(dumpBrief(minimal));
    expect(serializeBrief("camp.json", minimal)).toBe(JSON.stringify(minimal, null, 2));
  });
});

describe("isErrno", () => {
  test("detects a matching code and rejects anything else", () => {
    expect(isExistsError({ code: "EEXIST" })).toBe(true);
    expect(isErrno({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(isExistsError({ code: "ENOENT" })).toBe(false);
    expect(isExistsError(null)).toBe(false);
    expect(isExistsError("EEXIST")).toBe(false);
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
    const { findBriefFile, BRIEF_SOURCE_EXTS } = await filesFor(dir);
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "both.yaml"), "id: both\n");
    writeFileSync(join(dir, "briefs", "both.yml"), "id: both\n");
    expect(await findBriefFile("both", BRIEF_SOURCE_EXTS)).toBe(join(dir, "briefs", "both.yaml"));

    mkdirSync(join(dir, "briefs", "only-dir.yaml"), { recursive: true }); // not a file → skipped
    writeFileSync(join(dir, "briefs", "only-dir.yml"), "id: only-dir\n");
    expect(await findBriefFile("only-dir", [".yaml", ".yml"])).toBe(
      join(dir, "briefs", "only-dir.yml"),
    );

    writeFileSync(join(dir, "briefs", "json-only.json"), "{}");
    expect(await findBriefFile("json-only")).toBe(join(dir, "briefs", "json-only.json"));
    expect(await findBriefFile("missing", BRIEF_SOURCE_EXTS)).toBeUndefined();
  });

  test("findBriefFileById matches brief.id, not filename, and skips junk", async () => {
    const { findBriefFileById, findBriefById, isBriefSourceName } = await filesFor(dir);
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "sample-campaign.yaml"), validYaml);
    writeFileSync(join(dir, "briefs", "bad.yaml"), "id: 1\nproducts: not-an-array\n");
    writeFileSync(join(dir, "briefs", "ignore.txt"), "not a brief");
    writeFileSync(join(dir, "briefs", "winter.json"), JSON.stringify({ ...minimal, id: "winter" }));
    const outside = join(dir, "outside.yaml");
    writeFileSync(outside, validYaml.replace("id: camp", "id: linked"));
    symlinkSync(outside, join(dir, "briefs", "linked.yaml"));

    expect(isBriefSourceName("sample-campaign.YAML")).toBe(true);
    expect(isBriefSourceName("ignore.txt")).toBe(false);
    expect(await findBriefFileById("camp")).toBe(join(dir, "briefs", "sample-campaign.yaml"));
    expect(await findBriefFileById("winter")).toBe(join(dir, "briefs", "winter.json"));
    expect(await findBriefFileById("linked")).toBeUndefined(); // symlink, not a regular file
    expect(await findBriefFileById("missing")).toBeUndefined();
    expect(await findBriefById("camp")).toMatchObject({
      path: join(dir, "briefs", "sample-campaign.yaml"),
      brief: { id: "camp" },
    });
  });

  test("findBriefFileById returns undefined when briefs/ is missing", async () => {
    const { findBriefFileById } = await filesFor(dir);
    expect(await findBriefFileById("camp")).toBeUndefined();
  });

  test("pathExists is true for any inode and false when missing", async () => {
    const { pathExists, createBriefFile, briefYamlPath } = await filesFor(dir);
    const path = briefYamlPath("camp");
    expect(await pathExists(path)).toBe(false);
    await createBriefFile(path, minimal);
    expect(await pathExists(path)).toBe(true);
  });

  test("createBriefFile is exclusive — a second write does not overwrite", async () => {
    const { createBriefFile, briefYamlPath } = await filesFor(dir);
    const path = briefYamlPath("camp");
    await createBriefFile(path, minimal);
    const original = readFileSync(path);
    await expect(createBriefFile(path, { ...minimal, campaignMessage: "Nope" })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(readFileSync(path)).toEqual(original);
  });

  test("rewriteBriefFile refuses a symlink and leaves the target unchanged", async () => {
    const { rewriteBriefFile } = await filesFor(dir);
    mkdirSync(join(dir, "briefs"), { recursive: true });
    const outside = join(dir, "outside.yaml");
    writeFileSync(outside, "ORIGINAL");
    const link = join(dir, "briefs", "camp.yaml");
    symlinkSync(outside, link);
    await expect(rewriteBriefFile(link, minimal)).rejects.toThrow(SYMLINK_WRITE_ERROR);
    expect(readFileSync(outside, "utf8")).toBe("ORIGINAL");
  });

  test("replaceBriefFile creates when missing and rewrites a regular file", async () => {
    const { replaceBriefFile, briefYamlPath } = await filesFor(dir);
    const path = briefYamlPath("camp");
    await replaceBriefFile(path, minimal);
    expect(readFileSync(path, "utf8")).toContain("id: camp");
    await replaceBriefFile(path, { ...minimal, campaignMessage: "Updated" });
    expect(readFileSync(path, "utf8")).toContain("campaignMessage: Updated");
  });

  test("rewriteBriefFile writes JSON when the path is .json", async () => {
    const { rewriteBriefFile } = await filesFor(dir);
    mkdirSync(join(dir, "briefs"), { recursive: true });
    const path = join(dir, "briefs", "camp.json");
    writeFileSync(path, JSON.stringify(minimal));
    await rewriteBriefFile(path, { ...minimal, campaignMessage: "JSON" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ campaignMessage: "JSON" });
  });

  test("briefYamlPath stays under briefs/ and rejects a traversing id segment", async () => {
    const { briefYamlPath } = await filesFor(dir);
    expect(briefYamlPath("camp")).toBe(join(dir, "briefs", "camp.yaml"));
    expect(() => briefYamlPath("../escape")).toThrow(/Path escapes the allowed directory/);
  });
});

describe("hashFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-hash-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns SHA-256 hex digest of file bytes", async () => {
    const path = join(dir, "test.txt");
    writeFileSync(path, "hello");
    const expected = createHash("sha256").update("hello").digest("hex");
    expect(await hashFile(path)).toBe(expected);
  });

  test("different content produces different hashes", async () => {
    const pathA = join(dir, "a.txt");
    const pathB = join(dir, "b.txt");
    writeFileSync(pathA, "hello");
    writeFileSync(pathB, "world");
    expect(await hashFile(pathA)).not.toBe(await hashFile(pathB));
  });

  test("hash changes when file content changes", async () => {
    const path = join(dir, "mutable.txt");
    writeFileSync(path, "v1");
    const v1Hash = await hashFile(path);
    writeFileSync(path, "v2");
    const v2Hash = await hashFile(path);
    expect(v1Hash).not.toBe(v2Hash);
  });

  test("hash matches raw bytes, not parsed content", async () => {
    const path = join(dir, "brief.yaml");
    writeFileSync(path, "id: camp\ncampaignMessage: Hi\n");
    const hashWithoutSpace = await hashFile(path);
    writeFileSync(path, "id: camp\ncampaignMessage: Hi  \n");
    const hashWithSpace = await hashFile(path);
    expect(hashWithoutSpace).not.toBe(hashWithSpace);
  });

  test("throws ENOENT error for missing file", async () => {
    await expect(hashFile(join(dir, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("hashBytes", () => {
  test("returns SHA-256 hex digest of buffer", () => {
    const buffer = Buffer.from("hello");
    const expected = createHash("sha256").update("hello").digest("hex");
    expect(hashBytes(buffer)).toBe(expected);
  });

  test("different buffers produce different hashes", () => {
    expect(hashBytes(Buffer.from("hello"))).not.toBe(hashBytes(Buffer.from("world")));
  });

  test("matches hashFile for the same content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-hash-bytes-"));
    try {
      const path = join(dir, "test.txt");
      const content = "test-content";
      writeFileSync(path, content);
      const fromFile = await hashFile(path);
      const fromBytes = hashBytes(Buffer.from(content, "utf8"));
      expect(fromFile).toBe(fromBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseBriefText", () => {
  test("parses yaml format based on .yaml extension", () => {
    const yaml = "id: camp\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n  - id: beta\n";
    const brief = parseBriefText("camp.yaml", yaml);
    expect(brief.id).toBe("camp");
    expect(brief.campaignMessage).toBe("Hi");
  });

  test("parses yaml format based on .yml extension", () => {
    const yaml = "id: camp\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n";
    const brief = parseBriefText("camp.yml", yaml);
    expect(brief.id).toBe("camp");
  });

  test("parses JSON format based on .json extension", () => {
    const json = JSON.stringify(minimal);
    const brief = parseBriefText("camp.json", json);
    expect(brief.id).toBe("camp");
  });

  test("rejects invalid yaml with a clear error", () => {
    expect(() => parseBriefText("camp.yaml", "id: 1\nproducts: not-an-array\n")).toThrow(/campaign brief|required field/i);
  });

  test("rejects invalid JSON with a clear error", () => {
    expect(() => parseBriefText("camp.json", "{not-json}")).toThrow(/JSON|property name/i);
  });
});

describe("withBriefLock", () => {
  const filesFor = async (root: string) => {
    vi.resetModules();
    process.env.PROJECT_ROOT = root;
    return import("../brief-files.js");
  };

  test("runs sections for one brief in order and does not block other briefs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-lock-"));
    try {
      process.env.PROJECT_ROOT = dir;
      const { withBriefLock } = await filesFor(dir);
      const order: string[] = [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = withBriefLock("camp", async () => {
        await gate;
        order.push("first");
        return 1;
      });
      const second = withBriefLock("camp", async () => {
        order.push("second");
        return 2;
      });
      const other = withBriefLock("other", async () => {
        order.push("other");
        return 3;
      });
      expect(await other).toBe(3);
      expect(order).toEqual(["other"]);
      release();
      expect(await Promise.all([first, second])).toEqual([1, 2]);
      expect(order).toEqual(["other", "first", "second"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (origRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origRoot;
    }
  });

  test("keeps serving a brief after a section rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-lock-err-"));
    try {
      process.env.PROJECT_ROOT = dir;
      const { withBriefLock } = await filesFor(dir);
      await expect(
        withBriefLock("camp", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await withBriefLock("camp", async () => "ok")).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (origRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origRoot;
    }
  });
});

describe("concurrent write scenario", () => {
  test("two conditional writes issued with the same revision, exactly one succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-concurrent-"));
    try {
      vi.resetModules();
      process.env.PROJECT_ROOT = dir;
      const { createBriefFile, withBriefLock, hashFile, rewriteBriefFile, briefYamlPath } = await import("../brief-files.js");
      mkdirSync(join(dir, "briefs"), { recursive: true });

      const path = briefYamlPath("camp");
      await createBriefFile(path, minimal);
      const revision = await hashFile(path);

      let result1: boolean | undefined;
      let result2: boolean | undefined;

      const write1 = withBriefLock("camp", async () => {
        const current = await hashFile(path);
        if (current === revision) {
          await rewriteBriefFile(path, { ...minimal, campaignMessage: "First" });
          result1 = true;
        } else {
          result1 = false;
        }
      });

      const write2 = withBriefLock("camp", async () => {
        const current = await hashFile(path);
        if (current === revision) {
          await rewriteBriefFile(path, { ...minimal, campaignMessage: "Second" });
          result2 = true;
        } else {
          result2 = false;
        }
      });

      await Promise.all([write1, write2]);

      // One should succeed, one should fail (because file changed)
      expect([result1, result2]).toContain(true);
      expect([result1, result2]).toContain(false);

      // The file should contain one of the two messages
      const content = readFileSync(path, "utf8");
      expect(content).toMatch(/campaignMessage: (First|Second)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (origRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origRoot;
    }
  });
});
