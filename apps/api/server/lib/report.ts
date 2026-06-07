import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GeneratedAsset, PipelineResult } from "@campaignfoundry/CampaignOrchestration";
import { outputRoot } from "./config.js";

/** Persisted asset = the entity plus the derived `brandCompliant` view field. */
type ReportAsset = GeneratedAsset & { brandCompliant: boolean };

/** Asset identity within the campaign matrix (matches the review UI's key). */
const keyOf = (a: GeneratedAsset): string => `${a.productId}/${a.aspectRatio}/${a.treatment}`;

/** A persisted entry we can safely key for merging — guards against a corrupt report.json. */
function isKeyable(a: unknown): a is ReportAsset {
  return (
    typeof a === "object" &&
    a !== null &&
    typeof (a as ReportAsset).productId === "string" &&
    typeof (a as ReportAsset).aspectRatio === "string" &&
    typeof (a as ReportAsset).treatment === "string"
  );
}

/**
 * Read the persisted report's assets, or [] if there's no readable report yet.
 * Entries that can't be safely keyed (a hand-edited / corrupt report.json with
 * null/primitive rows) are filtered out so the merge can't throw on `keyOf`.
 */
async function readPersistedAssets(path: string): Promise<ReportAsset[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const assets = (parsed as { assets?: unknown })?.assets;
    if (!Array.isArray(assets)) return [];
    const keyable = assets.filter(isKeyable);
    if (keyable.length !== assets.length) {
      console.warn(
        `[report] dropped ${assets.length - keyable.length} unkeyable asset(s) from report.json during merge`,
      );
    }
    return keyable;
  } catch {
    return [];
  }
}

/**
 * Persist a run's report.json under the output root; returns its path.
 *
 * With `merge` (a selective/HITL re-roll), the run's assets are overlaid onto the
 * previously persisted set by identity — replacing the regenerated cells and keeping
 * everything else — so a full report survives a partial run (and a page reload).
 */
export async function writeReport(
  result: PipelineResult,
  { merge = false }: { merge?: boolean } = {},
): Promise<string> {
  const root = outputRoot();
  await mkdir(root, { recursive: true });
  const path = resolve(root, "report.json");
  // `brandCompliant` is a derived view field (density gate AND logo present); the
  // entity keeps the two raw signals as the source of truth.
  const fresh: ReportAsset[] = result.assets.map((a) => ({
    ...a,
    brandCompliant: a.passedCompliance && a.logoApplied,
  }));

  let assets = fresh;
  if (merge) {
    // Map preserves existing order; re-keying an existing entry updates it in place,
    // and any genuinely new cell is appended.
    const byKey = new Map(
      (await readPersistedAssets(path)).map((a) => [keyOf(a), a] as const),
    );
    for (const a of fresh) byKey.set(keyOf(a), a);
    assets = [...byKey.values()];
  }

  await writeFile(
    path,
    JSON.stringify({ halted: result.halted, assets, log: result.log }, null, 2),
  );
  return path;
}
