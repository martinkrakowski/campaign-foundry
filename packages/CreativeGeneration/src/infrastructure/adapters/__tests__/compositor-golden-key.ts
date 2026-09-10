/**
 * PNG goldens are keyed by `${platform}-${arch}` because Skia prebuilds
 * rasterize differently across OS and CPU architecture.
 */
import { readFileSync, writeFileSync } from "node:fs";

/** 2 layouts × 2 tones × 3 ratios — the base still matrix. */
export const BASE_GOLDEN_CELL_COUNT = 12;
/** The inset suite records one cell (`headline-top/bold/9:16`). */
export const INSET_GOLDEN_CELL_COUNT = 1;
/** 2 layouts × 2 tones × 5 display sizes. */
export const DISPLAY_GOLDEN_CELL_COUNT = 20;
/** One display inset cell (`headline-top/bold/300x250`). */
export const DISPLAY_INSET_GOLDEN_CELL_COUNT = 1;
/**
 * 2 layouts × 4 MOTION_KINDS × (5 clip-shape `t` samples + 1 poster-shape
 * cell) — the motion path's only byte proof (C1/R-D6). See
 * NodeCanvasCompositor.motion-goldens.test.ts.
 */
export const MOTION_GOLDEN_CELL_COUNT = 48;

export function compositorGoldenKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const override = process.env.COMPOSITOR_GOLDEN_KEY_OVERRIDE;
  if (override !== undefined && override !== "") return override;
  return `${platform}-${arch}`;
}

export type GoldenMap = Record<string, string>;
export type GoldenFixture = Record<string, GoldenMap>;

/** The map for `key`, or `undefined` when missing or empty (caller should fail). */
export function resolveGoldenMap(fixture: GoldenFixture, key: string): GoldenMap | undefined {
  const map = fixture[key];
  if (map === undefined || Object.keys(map).length === 0) return undefined;
  return map;
}

export function missingGoldenMapMessage(
  key: string,
  recordedKeys: readonly string[],
  options?: { readonly fixtureFile?: string; readonly cellsHint?: string },
): string {
  const recorded = recordedKeys.length > 0 ? recordedKeys.join(", ") : "none";
  const fixtureFile = options?.fixtureFile ?? "compositor-goldens.json";
  const cellsHint =
    options?.cellsHint ?? "12 sha256 cells (both layouts × both tones × three ratios)";
  return (
    `No compositor PNG goldens for "${key}" (recorded: ${recorded}). ` +
    `Record ${cellsHint} into fixtures/${fixtureFile}["${key}"]. ` +
    `Run .github/workflows/record-goldens.yml (workflow_dispatch) or set RECORD_COMPOSITOR_GOLDENS=1 on the target platform.`
  );
}

export function isRecordingGoldens(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RECORD_COMPOSITOR_GOLDENS === "1";
}

export type GoldenRun = { readonly kind: "record" } | { readonly kind: "assert"; readonly map: GoldenMap };

/**
 * Suite decision for a resolved map: record, assert, or throw.
 * A missing map is a failure, never a skip — a golden that does not run on
 * the platform CI uses is a vacuous tripwire (D85 / D115).
 */
export function goldenRun(
  map: GoldenMap | undefined,
  recording: boolean,
  message: string,
): GoldenRun {
  if (recording) return { kind: "record" };
  if (map === undefined) {
    throw new Error(message);
  }
  return { kind: "assert", map };
}

/** Merge `cells` under `key`, keeping other keys. Platform keys are sorted. */
export function mergeGoldenFixture(
  existing: GoldenFixture,
  key: string,
  cells: GoldenMap,
): GoldenFixture {
  const merged: GoldenFixture = { ...existing, [key]: cells };
  const ordered: GoldenFixture = {};
  for (const k of Object.keys(merged).sort()) {
    ordered[k] = merged[k];
  }
  return ordered;
}

export function serializeGoldenFixture(fixture: GoldenFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** The one impure line: write the serialized fixture. */
export function writeGoldenFixture(path: string, fixture: GoldenFixture): void {
  writeFileSync(path, serializeGoldenFixture(fixture));
}

export function readGoldenFixture(path: string): GoldenFixture {
  return JSON.parse(readFileSync(path, "utf8")) as GoldenFixture;
}

export function goldenMapsEqual(a: GoldenMap | undefined, b: GoldenMap): boolean {
  if (a === undefined) return false;
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/**
 * After a record write: the on-disk map has `expectedCellCount` cells and
 * round-trips to `cells`. Count is a caller constant (12 base / 1 inset), not
 * `Object.keys(cells).length`, so a writer that drops a cell cannot pass.
 */
export function assertRecordedMap(
  written: GoldenMap | undefined,
  cells: GoldenMap,
  expectedCellCount: number,
  key: string,
): void {
  const count = written === undefined ? 0 : Object.keys(written).length;
  if (count !== expectedCellCount) {
    throw new Error(
      `recorded compositor goldens for ${key}: expected ${expectedCellCount} cells, wrote ${count}`,
    );
  }
  if (!goldenMapsEqual(written, cells)) {
    throw new Error(
      `recorded compositor goldens for ${key}: re-read map does not match the map written`,
    );
  }
}

/**
 * Write `cells` under `key`. Always re-reads the fixture from disk before
 * merging so a second recording in the same file cannot clobber a sibling key
 * via a stale module-scoped parse.
 */
export function recordGoldenMap(
  path: string,
  key: string,
  cells: GoldenMap,
  expectedCellCount: number,
): void {
  const existing = readGoldenFixture(path);
  writeGoldenFixture(path, mergeGoldenFixture(existing, key, cells));
  const reread = readGoldenFixture(path);
  assertRecordedMap(reread[key], cells, expectedCellCount, key);
  process.stdout.write(
    `recorded compositor goldens for ${key}: ${Object.keys(cells).length} cells\n`,
  );
}
