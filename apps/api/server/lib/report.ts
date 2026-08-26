import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assetIdentity, SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import type { GeneratedAsset, PipelineResult } from "@campaignfoundry/CampaignOrchestration";
import { outputRoot } from "./config.js";

/** Persisted asset = the entity plus the derived `brandCompliant` view field. */
type ReportAsset = GeneratedAsset & { brandCompliant: boolean };

/** Asset identity within the campaign matrix (matches the review UI's key). */
const keyOf = (a: GeneratedAsset): string => assetIdentity(a);

/**
 * Resolve the per-campaign report path under `<output>/reports/<campaignId>.json`,
 * or null when the id can't be a safe single path segment. The id originates from a
 * brief (validated against the same pattern) but also flows in from the untrusted
 * `?campaignId=` query — so reuse SAFE_ID_PATTERN, the canonical brief/product/treatment
 * slug. It allows only lowercase letters, digits and hyphens, which inherently rules out
 * separators, `.`/`..` traversal, and anything else that isn't one safe path segment.
 */
export function campaignReportPath(root: string, campaignId: string): string | null {
  if (!SAFE_ID_PATTERN.test(campaignId)) return null;
  return resolve(root, "reports", `${campaignId}.json`);
}

/**
 * Read a campaign's persisted report, or `undefined` when the id is unsafe or
 * the file is missing / unreadable. A file that parses as JSON `null` returns
 * `null` (distinct from missing). Does not merge or write.
 */
export async function readReport(root: string, campaignId: string): Promise<unknown> {
  const path = campaignReportPath(root, campaignId);
  if (!path) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The "latest run" pointer — read by GET /campaigns/result when no campaignId is given. */
export const latestReportPath = (root: string): string => resolve(root, "report.json");

/**
 * A persisted report row that can be keyed. Every row — classic or variation —
 * has the four strings. Variation rows additionally carry integer variantIndex
 * and attempt (>= 0).
 */
export type PersistedAsset = {
  productId: string;
  aspectRatio: string;
  treatment: string;
  outputPath: string;
  variantIndex?: number;
  attempt?: number;
};

const isNonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * Guard for a persisted report row — used by both the merge path and packaging.
 * Rows missing identity + path are skipped (never thrown on).
 */
export function isPersistedAsset(a: unknown): a is PersistedAsset {
  if (typeof a !== "object" || a === null) return false;
  const rec = a as Record<string, unknown>;
  if (typeof rec.productId !== "string") return false;
  if (typeof rec.aspectRatio !== "string") return false;
  if (typeof rec.treatment !== "string") return false;
  if (typeof rec.outputPath !== "string") return false;
  if (rec.variantIndex === undefined) return true;
  return isNonNegInt(rec.variantIndex) && isNonNegInt(rec.attempt);
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
    const persisted = assets.filter(isPersistedAsset) as ReportAsset[];
    if (persisted.length !== assets.length) {
      console.warn(
        `[report] dropped ${assets.length - persisted.length} invalid persisted asset(s) from report.json during merge`,
      );
    }
    return persisted;
  } catch {
    return [];
  }
}

/**
 * Persist a run's report under the output root; returns the per-campaign path it wrote.
 *
 * Reports are keyed by campaign id (`<output>/reports/<campaignId>.json`) so every
 * brief's run survives independently — switching briefs in the UI reloads the right
 * one instead of always seeing the most recent run. A copy is also written to the
 * `<output>/report.json` "latest" pointer for callers that don't pass a campaign id.
 *
 * With `merge` (a selective/HITL re-roll), the run's assets are overlaid onto this
 * campaign's previously persisted set by identity — replacing the regenerated cells
 * and keeping everything else — so a full report survives a partial run (and a reload).
 */
export async function writeReport(
  result: PipelineResult,
  { merge = false }: { merge?: boolean } = {},
): Promise<string> {
  const root = outputRoot();
  const latest = latestReportPath(root);
  // The campaign id is the report's identity. Fall back to the latest-only pointer if a
  // run somehow lacks one (defensive — the use case always stamps the brief id).
  const perCampaign = result.log?.campaignId ? campaignReportPath(root, result.log.campaignId) : null;

  await mkdir(root, { recursive: true });
  if (perCampaign) await mkdir(resolve(root, "reports"), { recursive: true });

  // `brandCompliant` is a derived view field (density gate AND logo present); the
  // entity keeps the two raw signals as the source of truth.
  const fresh: ReportAsset[] = result.assets.map((a) => ({
    ...a,
    brandCompliant: a.passedCompliance && a.logoApplied,
  }));

  let assets = fresh;
  if (merge) {
    // Merge against this campaign's own prior report (not the global latest), so a
    // re-roll of one brief never folds in another brief's creatives. Map preserves
    // existing order; re-keying an existing entry updates it in place, new cells append.
    const base = perCampaign ?? latest;
    const byKey = new Map(
      (await readPersistedAssets(base)).map((a) => [keyOf(a), a] as const),
    );
    for (const a of fresh) byKey.set(keyOf(a), a);
    assets = [...byKey.values()];
  }

  const payload = JSON.stringify(
    {
      halted: result.halted,
      assets,
      log: result.log,
      ...(result.policyHash !== undefined ? { policyHash: result.policyHash } : {}),
      ...(result.seed !== undefined ? { seed: result.seed } : {}),
    },
    null,
    2,
  );
  if (perCampaign) await writeFile(perCampaign, payload);
  await writeFile(latest, payload);
  return perCampaign ?? latest;
}
