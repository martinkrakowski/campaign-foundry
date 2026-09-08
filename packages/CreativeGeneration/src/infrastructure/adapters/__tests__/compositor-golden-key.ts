/**
 * PNG goldens are keyed by `${platform}-${arch}` because Skia prebuilds
 * rasterize differently across OS and CPU architecture.
 */
import { writeFileSync } from "node:fs";

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

/** Write `cells` under `key` and print the key and cell count. */
export function recordGoldenMap(
  path: string,
  existing: GoldenFixture,
  key: string,
  cells: GoldenMap,
): void {
  writeGoldenFixture(path, mergeGoldenFixture(existing, key, cells));
  process.stdout.write(
    `recorded compositor goldens for ${key}: ${Object.keys(cells).length} cells\n`,
  );
}
