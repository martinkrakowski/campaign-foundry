import { describe, test, expect } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOLDEN_PROVENANCE_KEY,
  goldenPlatformKeys,
  goldenProvenanceProblems,
  readGoldenFixture,
  resolveGoldenMap,
  type GoldenFixture,
  type GoldenProvenanceMap,
  type GoldenReproof,
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

const provenanceOf = (fixture: GoldenFixture): GoldenProvenanceMap =>
  fixture[GOLDEN_PROVENANCE_KEY] ?? {};

/**
 * The platform keys every golden family commits, and who re-proves each.
 *
 * Named as literals on purpose. Deriving them from the fixture — the obvious
 * `goldenPlatformKeys(fixture)` — makes the assertion unfalsifiable: delete
 * `darwin-arm64` from a family and both sides shrink together, so the one key
 * whose weak provenance this suite exists to document can vanish unobserved.
 */
const REQUIRED_PLATFORMS: readonly {
  readonly key: string;
  readonly reprovedBy: GoldenReproof;
}[] = [
  { key: "darwin-arm64", reprovedBy: "nothing" },
  { key: "linux-x64", reprovedBy: "ci" },
];

/** What to do when a fixtures file is not, in fact, a golden family. */
const NOT_A_FAMILY_HINT =
  `has no "<platform>-<arch>" key, so the family scan cannot see it and it ships without ` +
  `a caveat. If it is genuinely not a golden family, move it out of fixtures/; if it is, ` +
  `give it a platform-arch map and a "${GOLDEN_PROVENANCE_KEY}" entry.`;

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
    // Same fact, said as a diagnosis: name the file and what to do about it.
    const notAFamily = fixtureFiles()
      .filter((file) => !scanned.includes(file))
      .map((file) => `${file}: ${NOT_A_FAMILY_HINT}`);
    expect(notAFamily).toEqual([]);
  });

  test("every family carries both committed platform maps, each with the reproof it declares", () => {
    const wanted = fixtureFiles().flatMap((file) =>
      REQUIRED_PLATFORMS.map(
        ({ key, reprovedBy }) => `${file} ${key}: map present, reprovedBy=${reprovedBy}`,
      ),
    );
    const actual = families().flatMap(({ file, fixture }) => {
      const provenance = provenanceOf(fixture);
      return REQUIRED_PLATFORMS.map(
        ({ key }) =>
          `${file} ${key}: map ` +
          `${resolveGoldenMap(fixture, key) === undefined ? "ABSENT" : "present"}, ` +
          `reprovedBy=${provenance[key]?.reprovedBy ?? "ABSENT"}`,
      );
    });
    expect(actual).toEqual(wanted);
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
