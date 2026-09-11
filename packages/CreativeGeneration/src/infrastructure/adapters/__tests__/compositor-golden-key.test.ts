import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_GOLDEN_CELL_COUNT,
  DISPLAY_GOLDEN_CELL_COUNT,
  DISPLAY_INSET_GOLDEN_CELL_COUNT,
  INSET_GOLDEN_CELL_COUNT,
  assertRecordedMap,
  compositorGoldenKey,
  goldenMapsEqual,
  goldenPlatformKeys,
  goldenRun,
  isGoldenPlatformKey,
  isRecordingGoldens,
  mergeGoldenFixture,
  missingGoldenMapMessage,
  readGoldenFixture,
  recordGoldenMap,
  resolveGoldenMap,
  serializeGoldenFixture,
  writeGoldenFixture,
  type GoldenFixture,
} from "./compositor-golden-key.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const GOLDENS_PATH = join(FIXTURES, "compositor-goldens.json");

describe("golden cell counts", () => {
  test("display matrix is 2 layouts × 2 tones × 5 sizes, inset is one cell", () => {
    expect(DISPLAY_GOLDEN_CELL_COUNT).toBe(20);
    expect(DISPLAY_INSET_GOLDEN_CELL_COUNT).toBe(1);
    expect(BASE_GOLDEN_CELL_COUNT).toBe(12);
    expect(INSET_GOLDEN_CELL_COUNT).toBe(1);
  });
});

describe("compositorGoldenKey", () => {
  test("joins platform and arch", () => {
    expect(compositorGoldenKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(compositorGoldenKey("linux", "x64")).toBe("linux-x64");
  });

  test("defaults to process.platform and process.arch", () => {
    const prev = process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE;
    delete process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE;
    try {
      expect(compositorGoldenKey()).toBe(`${process.platform}-${process.arch}`);
    } finally {
      if (prev === undefined) delete process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE;
      else process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE = prev;
    }
  });

  test("COMPOSITOR_GOLDEN_KEY_OVERRIDE replaces the platform-arch key", () => {
    const prev = process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE;
    process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE = "nowhere-none";
    try {
      expect(compositorGoldenKey("linux", "x64")).toBe("nowhere-none");
    } finally {
      if (prev === undefined) delete process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE;
      else process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE = prev;
    }
  });

  test("an empty override is ignored", () => {
    const prev = process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE;
    process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE = "";
    try {
      expect(compositorGoldenKey("linux", "x64")).toBe("linux-x64");
    } finally {
      if (prev === undefined) delete process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE;
      else process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE = prev;
    }
  });
});

describe("resolveGoldenMap", () => {
  const map = { "headline-bottom/bold/1:1": "abc" };

  test("returns the map when the key is present and non-empty", () => {
    expect(resolveGoldenMap({ "darwin-arm64": map }, "darwin-arm64")).toEqual(map);
  });

  test("returns undefined when the key is missing", () => {
    expect(resolveGoldenMap({ "darwin-arm64": map }, "linux-x64")).toBeUndefined();
  });

  test("returns undefined when the map is empty", () => {
    expect(resolveGoldenMap({ "win32-x64": {} }, "win32-x64")).toBeUndefined();
  });
});

describe("goldenPlatformKeys", () => {
  test("returns only the platform-arch keys, never the caveat key", () => {
    const fixture = {
      "darwin-arm64": { cell: "a" },
      "linux-x64": { cell: "b" },
      platformProvenance: { "linux-x64": { reprovedBy: "ci", note: "asserted by CI" } },
    };
    expect(goldenPlatformKeys(fixture)).toEqual(["darwin-arm64", "linux-x64"]);
  });

  test("is empty for a fixture file that is not a golden family", () => {
    expect(goldenPlatformKeys({ cases: [] })).toEqual([]);
  });

  test("isGoldenPlatformKey accepts platform-arch and rejects anything else", () => {
    expect(isGoldenPlatformKey("darwin-arm64")).toBe(true);
    expect(isGoldenPlatformKey("win32-x64")).toBe(true);
    expect(isGoldenPlatformKey("platformProvenance")).toBe(false);
    expect(isGoldenPlatformKey("cases")).toBe(false);
  });
});

describe("missingGoldenMapMessage", () => {
  test("names the missing key and how to record it", () => {
    const message = missingGoldenMapMessage("win32-x64", ["darwin-arm64", "linux-x64"]);
    expect(message).toContain('"win32-x64"');
    expect(message).toContain("darwin-arm64, linux-x64");
    expect(message).toContain('fixtures/compositor-goldens.json["win32-x64"]');
    expect(message).toContain("record-goldens.yml");
    expect(message).toContain("RECORD_COMPOSITOR_GOLDENS=1");
  });

  test("says none when no maps are recorded", () => {
    expect(missingGoldenMapMessage("linux-arm64", [])).toContain("recorded: none");
  });

  test("names a non-default fixture file and cell hint", () => {
    const message = missingGoldenMapMessage("linux-x64", ["darwin-arm64"], {
      fixtureFile: "compositor-goldens-insets.json",
      cellsHint: "the headline-top/bold/9:16 cell",
    });
    expect(message).toContain('fixtures/compositor-goldens-insets.json["linux-x64"]');
    expect(message).toContain("the headline-top/bold/9:16 cell");
  });
});

describe("isRecordingGoldens", () => {
  test("is true only when RECORD_COMPOSITOR_GOLDENS is 1", () => {
    expect(isRecordingGoldens({})).toBe(false);
    expect(isRecordingGoldens({ RECORD_COMPOSITOR_GOLDENS: "true" })).toBe(false);
    expect(isRecordingGoldens({ RECORD_COMPOSITOR_GOLDENS: "1" })).toBe(true);
  });
});

describe("goldenRun", () => {
  const map = { "headline-bottom/bold/1:1": "abc" };
  const message = missingGoldenMapMessage("nowhere-none", ["darwin-arm64"]);

  test("assert when the map is present and not recording", () => {
    expect(goldenRun(map, false, message)).toEqual({ kind: "assert", map });
  });

  test("record even when the map is missing", () => {
    expect(goldenRun(undefined, true, message)).toEqual({ kind: "record" });
  });

  test("resolveGoldenMap undefined yields a thrown assertion, not a skip", () => {
    const resolved = resolveGoldenMap({ "darwin-arm64": map }, "nowhere-none");
    expect(resolved).toBeUndefined();
    expect(() => goldenRun(resolved, false, message)).toThrow(message);
    expect(() => goldenRun(resolved, false, message)).not.toThrow(/skip/i);
  });
});

describe("mergeGoldenFixture", () => {
  test("replaces the written key and keeps sibling keys in stable order", () => {
    const existing: GoldenFixture = {
      "linux-x64": { cell: "linux" },
      "darwin-arm64": { cell: "old" },
    };
    const merged = mergeGoldenFixture(existing, "darwin-arm64", { cell: "new" });
    expect(Object.keys(merged)).toEqual(["darwin-arm64", "linux-x64"]);
    expect(merged["darwin-arm64"]).toEqual({ cell: "new" });
    expect(merged["linux-x64"]).toEqual({ cell: "linux" });
  });

  test("adds a new platform key without dropping the others", () => {
    const existing: GoldenFixture = { "darwin-arm64": { cell: "darwin" } };
    const merged = mergeGoldenFixture(existing, "linux-x64", { cell: "linux" });
    expect(Object.keys(merged)).toEqual(["darwin-arm64", "linux-x64"]);
    expect(merged["darwin-arm64"]).toEqual({ cell: "darwin" });
  });
});

describe("serializeGoldenFixture", () => {
  test("is 2-space JSON with a trailing newline", () => {
    expect(serializeGoldenFixture({ a: { b: "c" } })).toBe('{\n  "a": {\n    "b": "c"\n  }\n}\n');
  });

  test("round-trips the committed base fixture byte for byte when rewriting darwin-arm64", () => {
    const committed = readFileSync(GOLDENS_PATH, "utf8");
    const parsed = JSON.parse(committed) as GoldenFixture;
    const darwin = parsed["darwin-arm64"];
    if (darwin === undefined) throw new Error("committed fixture missing darwin-arm64");
    const merged = mergeGoldenFixture(parsed, "darwin-arm64", darwin);
    expect(serializeGoldenFixture(merged)).toBe(committed);
    expect(merged["linux-x64"]).toEqual(parsed["linux-x64"]);
  });
});

describe("writeGoldenFixture / recordGoldenMap", () => {
  test("records darwin-arm64 byte-identically into a temp copy and keeps linux-x64", () => {
    const committed = readFileSync(GOLDENS_PATH, "utf8");
    const parsed = JSON.parse(committed) as GoldenFixture;
    const darwin = parsed["darwin-arm64"];
    if (darwin === undefined) throw new Error("committed fixture missing darwin-arm64");
    expect(Object.keys(darwin).length).toBe(BASE_GOLDEN_CELL_COUNT);
    const dir = mkdtempSync(join(tmpdir(), "cf-goldens-"));
    const dest = join(dir, "compositor-goldens.json");
    try {
      writeFileSync(dest, committed);
      recordGoldenMap(dest, "darwin-arm64", darwin, BASE_GOLDEN_CELL_COUNT);
      const written = readFileSync(dest, "utf8");
      expect(written).toBe(committed);
      const writtenParsed = JSON.parse(written) as GoldenFixture;
      expect(writtenParsed["linux-x64"]).toEqual(parsed["linux-x64"]);
      expect(Buffer.from(JSON.stringify(writtenParsed["darwin-arm64"]))).toEqual(
        Buffer.from(JSON.stringify(darwin)),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeGoldenFixture is the bytes serializeGoldenFixture produces", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-goldens-write-"));
    const dest = join(dir, "out.json");
    const fixture: GoldenFixture = { "darwin-arm64": { cell: "abc" } };
    try {
      writeGoldenFixture(dest, fixture);
      expect(readFileSync(dest, "utf8")).toBe(serializeGoldenFixture(fixture));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two sequential records into a temp fixture keep both keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-goldens-two-"));
    const dest = join(dir, "out.json");
    try {
      writeGoldenFixture(dest, {});
      recordGoldenMap(dest, "darwin-arm64", { cell: "a" }, INSET_GOLDEN_CELL_COUNT);
      recordGoldenMap(dest, "linux-x64", { cell: "b" }, INSET_GOLDEN_CELL_COUNT);
      const parsed = readGoldenFixture(dest);
      expect(parsed["darwin-arm64"]).toEqual({ cell: "a" });
      expect(parsed["linux-x64"]).toEqual({ cell: "b" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-reading the fixture after recordGoldenMap returns the map written at the expected cell count", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-goldens-reread-"));
    const dest = join(dir, "out.json");
    const cells = { "headline-top/bold/9:16": "abc" };
    try {
      writeGoldenFixture(dest, {});
      recordGoldenMap(dest, "linux-x64", cells, INSET_GOLDEN_CELL_COUNT);
      const reread = readGoldenFixture(dest)["linux-x64"];
      expect(reread).toEqual(cells);
      expect(Object.keys(reread ?? {}).length).toBe(INSET_GOLDEN_CELL_COUNT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertRecordedMap", () => {
  const cells = { a: "1", b: "2" };

  test("passes when the written map matches cells at the expected count", () => {
    expect(() => assertRecordedMap(cells, cells, 2, "linux-x64")).not.toThrow();
  });

  test("throws when the written map has the wrong cell count", () => {
    expect(() => assertRecordedMap({ a: "1" }, cells, 2, "linux-x64")).toThrow(
      /expected 2 cells, wrote 1/,
    );
  });

  test("throws when a missing map is counted as zero cells", () => {
    expect(() => assertRecordedMap(undefined, cells, 2, "linux-x64")).toThrow(
      /expected 2 cells, wrote 0/,
    );
  });

  test("throws when the re-read map does not match the map written", () => {
    expect(() => assertRecordedMap({ a: "1", b: "other" }, cells, 2, "linux-x64")).toThrow(
      /re-read map does not match the map written/,
    );
  });
});

describe("goldenMapsEqual", () => {
  test("is false for undefined and for a length or value mismatch", () => {
    expect(goldenMapsEqual(undefined, { a: "1" })).toBe(false);
    expect(goldenMapsEqual({ a: "1" }, { a: "1", b: "2" })).toBe(false);
    expect(goldenMapsEqual({ a: "1" }, { a: "2" })).toBe(false);
    expect(goldenMapsEqual({ a: "1" }, { a: "1" })).toBe(true);
  });
});
