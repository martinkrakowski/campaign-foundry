/**
 * PNG goldens are keyed by `${platform}-${arch}` because Skia prebuilds
 * rasterize differently across OS and CPU architecture.
 */
export function compositorGoldenKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

export type GoldenMap = Record<string, string>;
export type GoldenFixture = Record<string, GoldenMap>;

/** The map for `key`, or `undefined` when missing or empty (caller should skip). */
export function resolveGoldenMap(fixture: GoldenFixture, key: string): GoldenMap | undefined {
  const map = fixture[key];
  if (map === undefined || Object.keys(map).length === 0) return undefined;
  return map;
}

export function missingGoldenMapMessage(key: string, recordedKeys: readonly string[]): string {
  const recorded = recordedKeys.length > 0 ? recordedKeys.join(", ") : "none";
  return (
    `No compositor PNG goldens for "${key}" (recorded: ${recorded}). ` +
    `Record 12 sha256 cells (both layouts × both tones × three ratios) into ` +
    `fixtures/compositor-goldens.json["${key}"].`
  );
}
