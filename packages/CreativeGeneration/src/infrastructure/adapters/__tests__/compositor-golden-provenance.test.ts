import { describe, test, expect } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOLDEN_PROVENANCE_KEY,
  goldenPlatformKeys,
  goldenProvenanceProblems,
  readGoldenFixture,
  type GoldenFixture,
} from "./compositor-golden-key.js";

/**
 * The fixtures as committed. Deliberately *not* `COMPOSITOR_GOLDEN_FIXTURE_DIR`,
 * which the suites honour: this guard is about what ships, so a run pointed at
 * a temp directory must not be able to satisfy it.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const fixtureFiles = (): string[] =>
  readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort();

const families = (): { readonly file: string; readonly fixture: GoldenFixture }[] =>
  fixtureFiles().map((file) => ({ file, fixture: readGoldenFixture(join(FIXTURES, file)) }));

const provenanceOf = (
  fixture: GoldenFixture,
): Record<string, { readonly reprovedBy?: string }> =>
  (fixture as Record<string, unknown>)[GOLDEN_PROVENANCE_KEY] as Record<
    string,
    { readonly reprovedBy?: string }
  >;

describe("golden families state who re-proves them (X3)", () => {
  test("every fixture carrying platform goldens carries the caveat too", () => {
    const problems = families().flatMap(({ file, fixture }) =>
      goldenProvenanceProblems(fixture, file),
    );
    expect(problems).toEqual([]);
  });

  test("the scan is not vacuous — every file in the directory is a golden family", () => {
    const scanned = families()
      .filter(({ fixture }) => goldenPlatformKeys(fixture).length > 0)
      .map(({ file }) => file);
    expect(scanned).toEqual(fixtureFiles());
    expect(scanned.length).toBeGreaterThanOrEqual(6);
  });

  test("the mac key is declared re-proved by nothing, the linux key by CI", () => {
    const declared = families().flatMap(({ file, fixture }) => {
      const provenance = provenanceOf(fixture);
      return goldenPlatformKeys(fixture).map(
        (key) => `${file} ${key} -> ${String(provenance[key]?.reprovedBy)}`,
      );
    });
    const wanted = families().flatMap(({ file, fixture }) =>
      goldenPlatformKeys(fixture).map(
        (key) => `${file} ${key} -> ${key === "linux-x64" ? "ci" : "nothing"}`,
      ),
    );
    expect(declared).toEqual(wanted);
  });

});

describe("goldenProvenanceProblems", () => {
  const file = "compositor-goldens-example.json";
  const family = { "darwin-arm64": { cell: "a" }, "linux-x64": { cell: "b" } };
  const caveat = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    [GOLDEN_PROVENANCE_KEY]: {
      "darwin-arm64": { reprovedBy: "nothing", note: "recorded once" },
      "linux-x64": { reprovedBy: "ci", note: "asserted by CI" },
      ...over,
    },
  });

  test("passes a family whose caveat is complete", () => {
    expect(goldenProvenanceProblems({ ...family, ...caveat() }, file)).toEqual([]);
  });

  test("a file with no platform key is not a golden family and is left alone", () => {
    expect(goldenProvenanceProblems({ cases: [{ a: 1 }] }, "unrelated.json")).toEqual([]);
  });

  test("reds when the caveat is removed", () => {
    expect(goldenProvenanceProblems(family, file)).toEqual([
      expect.stringContaining(`no "${GOLDEN_PROVENANCE_KEY}" object`),
    ]);
  });

  test("reds when the caveat is not an object", () => {
    expect(
      goldenProvenanceProblems(
        { ...family, [GOLDEN_PROVENANCE_KEY]: "recorded on two platforms" },
        file,
      ),
    ).toEqual([expect.stringContaining(`no "${GOLDEN_PROVENANCE_KEY}" object`)]);
  });

  test("reds when one platform key has no entry", () => {
    const problems = goldenProvenanceProblems(
      {
        ...family,
        [GOLDEN_PROVENANCE_KEY]: { "linux-x64": { reprovedBy: "ci", note: "asserted by CI" } },
      },
      file,
    );
    expect(problems).toEqual([expect.stringContaining(`has no entry for "darwin-arm64"`)]);
  });

  test("reds when reprovedBy is not one of the declared values", () => {
    const problems = goldenProvenanceProblems(
      { ...family, ...caveat({ "darwin-arm64": { reprovedBy: "sometimes", note: "x" } }) },
      file,
    );
    expect(problems).toEqual([expect.stringContaining(`must be "ci" | "nothing"`)]);
  });

  test("reds when the note is blank", () => {
    const problems = goldenProvenanceProblems(
      { ...family, ...caveat({ "linux-x64": { reprovedBy: "ci", note: "   " } }) },
      file,
    );
    expect(problems).toEqual([expect.stringContaining("note must be a non-empty string")]);
  });

  test("reds when no platform key is CI-reproven — a family no runner asserts", () => {
    const problems = goldenProvenanceProblems(
      { ...family, ...caveat({ "linux-x64": { reprovedBy: "nothing", note: "n" } }) },
      file,
    );
    expect(problems).toEqual([expect.stringContaining(`no platform key declares`)]);
  });

  test("reds on a top-level key the check cannot classify", () => {
    const problems = goldenProvenanceProblems({ ...family, ...caveat(), schemaVersion: 2 }, file);
    expect(problems).toEqual([expect.stringContaining(`key "schemaVersion" is neither`)]);
  });
});
