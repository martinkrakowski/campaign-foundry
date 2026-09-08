import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compositorGoldenKey,
  goldenRun,
  isRecordingGoldens,
  mergeGoldenFixture,
  missingGoldenMapMessage,
  recordGoldenMap,
  resolveGoldenMap,
  serializeGoldenFixture,
  writeGoldenFixture,
  type GoldenFixture,
} from "./compositor-golden-key.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const GOLDENS_PATH = join(FIXTURES, "compositor-goldens.json");

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
    const dir = mkdtempSync(join(tmpdir(), "cf-goldens-"));
    const dest = join(dir, "compositor-goldens.json");
    try {
      writeFileSync(dest, committed);
      recordGoldenMap(dest, JSON.parse(readFileSync(dest, "utf8")) as GoldenFixture, "darwin-arm64", darwin);
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
});
