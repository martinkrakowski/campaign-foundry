/**
 * Where a stored report keeps its render paths (PT-8d0, D226): on each object row
 * of `assets[]`, the five fields `writeReport` stores (`report.ts`) and
 * `withAssetUrls` signs (`signed-urls.ts`). This file is the import's ONE list of
 * those fields and its ONE walk over the rows: `plan` uses it to say which
 * renders it would import, and the render step uses it to import them, so the
 * two cannot disagree. It imports nothing, so any import file may import it.
 */
const REPORT_PATH_FIELDS = [
  "outputPath",
  "videoPath",
  "htmlFallbackPath",
  "proofPath",
  "htmlBundlePath",
] as const;

/** The five render path fields, as a type, so a refusal can name its field structurally. */
export type ReportPathField = (typeof REPORT_PATH_FIELDS)[number];

/** One render a report row names: the field it was found under, and its path as written. */
export interface ReportRenderPath {
  readonly field: ReportPathField;
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The render paths of a parsed report: every non-empty string under one of the
 * five fields on an OBJECT row of `assets[]`, each distinct field-and-path pair
 * once, in first-seen order. A path on the report object itself is NOT read: no
 * reader of a report asks for it. Nothing is checked here (not the file, not the
 * extension, not the campaign): the caller judges each path.
 */
export function reportRenderPaths(report: unknown): ReportRenderPath[] {
  if (!isRecord(report)) return [];
  const assets = report["assets"];
  if (!Array.isArray(assets)) return [];
  const seen = new Set<string>();
  const found: ReportRenderPath[] = [];
  for (const row of assets) {
    if (!isRecord(row)) continue;
    for (const field of REPORT_PATH_FIELDS) {
      const path = row[field];
      if (typeof path !== "string" || path === "") continue;
      const key = `${field}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ field, path });
    }
  }
  return found;
}
