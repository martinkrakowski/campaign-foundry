import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assetIdentity, SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import type { GeneratedAsset, PipelineResult } from "@campaignfoundry/CampaignOrchestration";
import { hashBytes, isErrno } from "./brief-files.js";
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
 * The revision of the report stored at `path` — the SHA-256 digest of the stored
 * bytes, never a field on the document (D80): a report is hand-editable, and a
 * revision it could name would not be the digest `writeReport`'s guard hashes.
 * Undefined when nothing is stored there.
 */
async function revisionAt(path: string): Promise<string | undefined> {
  try {
    return hashBytes(await readFile(path));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * The revision of a campaign's persisted report, or undefined when the id is
 * unsafe or nothing is stored — the value a caller passes back as
 * `writeReport`'s `expectedRevision`. Mirrors `BriefStorePort.getRevision`.
 */
export async function reportRevision(root: string, campaignId: string): Promise<string | undefined> {
  const path = campaignReportPath(root, campaignId);
  if (!path) return undefined;
  return revisionAt(path);
}

/**
 * A persisted report row that can be keyed. Every row — classic or variation —
 * has the four identity/path strings, where the canvas is a social `aspectRatio`
 * or a display `size` (D113) — exactly one of the two. Variation rows additionally
 * carry integer variantIndex and attempt (>= 0); motion rows carry the mp4 path
 * and clip length. Planned-axis descriptor is carried additively on variation rows.
 */
export type PersistedAsset = {
  productId: string;
  aspectRatio?: string;
  /** The display family's canvas (the `728x90` form); present only when `aspectRatio` is not. */
  size?: string;
  treatment: string;
  outputPath: string;
  variantIndex?: number;
  attempt?: number;
  format?: "static" | "motion" | "html";
  videoPath?: string;
  /** The HTML bundle — html rows only. */
  htmlBundlePath?: string;
  /** The required raster fallback rendition (D122) — html rows only. */
  htmlFallbackPath?: string;
  /** The click destination URL (HL2, HL-D3). */
  clickDestination?: string;
  durationSec?: number;
  /**
   * Planned-axis provenance, on variation rows only — `writeReport` spreads the whole
   * `GeneratedAsset`, so whatever the entity carried is here. Declared because the type
   * described a persisted row and said nothing about it.
   *
   * `unknown`, not `VariantDescriptor`, and that is the whole point. `isPersistedAsset` is
   * a type PREDICATE: whatever this type claims, callers believe after the guard returns
   * true. The guard deliberately does not validate the descriptor — it decides whether a
   * row is a usable ASSET, and a row whose provenance is malformed is still a perfectly
   * good creative, so rejecting it would lose work to a cosmetic defect. Typing it
   * `VariantDescriptor` while not checking it would make the predicate assert something it
   * never verified.
   *
   * So the type says exactly what the guard guarantees: something may be here, of no
   * promised shape. Nothing in the API reads it; a consumer that wants it must narrow it
   * itself, which is what the web already does field by field.
   */
  descriptor?: unknown;
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
  // The canvas is a social ratio or a display size (D113) — exactly one; a row
  // with neither (or both) cannot be keyed or packaged, so it is skipped.
  const hasRatio = typeof rec.aspectRatio === "string";
  const hasSize = typeof rec.size === "string";
  if (hasRatio === hasSize) return false;
  if (typeof rec.treatment !== "string") return false;
  if (typeof rec.outputPath !== "string") return false;
  // `format` is absent on classic rows, else static | motion | html. An unknown format is
  // skipped (and counted) rather than packaged as a still; a motion row without a
  // readable mp4 path or a finite clip length can't be packaged or duration-checked;
  // an html row without bundle and fallback paths can't be packaged (D122).
  if (rec.format !== undefined && rec.format !== "static" && rec.format !== "motion" && rec.format !== "html") return false;
  if (rec.format === "motion") {
    if (typeof rec.videoPath !== "string") return false;
    if (typeof rec.durationSec !== "number" || !Number.isFinite(rec.durationSec)) return false;
  }
  if (rec.format === "html") {
    if (typeof rec.htmlBundlePath !== "string") return false;
    if (typeof rec.htmlFallbackPath !== "string") return false;
  }
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
 *
 * A merge is a read-modify-write, so with `expectedRevision` it is a conditional
 * write, exactly as `writePool` and `rewriteBrief` are: the bytes the merge is
 * against must still be the bytes stored, and otherwise it throws an error with
 * code `ECONFLICT` carrying the fresh revision — a run whose report has moved
 * under it is refused instead of silently overwriting the run that moved it
 * (which is what two overlapping merges do: both answer 200 and one is gone).
 * Without `expectedRevision` the write is unconditional, as both stores are: the
 * compare and the write are not fused on a filesystem (D79), so this narrows the
 * race rather than closing it.
 *
 * `expectedRevision` is `null` — never `undefined` — when the run started against no
 * stored report. `reportRevision` hands back `undefined` for a missing report, and
 * `undefined` is also how every caller says "do not check", so the absent case needs a
 * value of its own: a run that began with no report must be refused when one appeared
 * while it ran, not waved through as an unconditional write that replaces it.
 */
export async function writeReport(
  result: PipelineResult,
  { merge = false, expectedRevision }: { merge?: boolean; expectedRevision?: string | null } = {},
): Promise<string> {
  const root = outputRoot();
  const latest = latestReportPath(root);
  // The campaign id is the report's identity. Fall back to the latest-only pointer if a
  // run somehow lacks one (defensive — the use case always stamps the brief id).
  const perCampaign = result.log?.campaignId ? campaignReportPath(root, result.log.campaignId) : null;
  // The file a merge reads and the one its revision guards: this campaign's own report.
  const base = perCampaign ?? latest;

  await mkdir(root, { recursive: true });
  if (perCampaign) await mkdir(resolve(root, "reports"), { recursive: true });

  // `brandCompliant` is a derived view field (density gate AND logo present); the
  // entity keeps the two raw signals as the source of truth.
  const fresh: ReportAsset[] = result.assets.map((a) => ({
    ...a,
    brandCompliant: a.passedCompliance && a.logoApplied,
  }));

  // Before any of the merge's work, so a run that will be refused does no
  // read-modify-write at all — and the base it is refused over is the one it named.
  if (expectedRevision !== undefined) {
    // Absence is an expectation a caller can name, not a hole in the guard: a run that
    // started against no report says `null`, which `revisionAt` reports as `undefined`.
    // Carrying `undefined` here would mean "do not check", and a report created while
    // that run was in flight would be overwritten by a merge that never saw it.
    const expected = expectedRevision ?? undefined;
    const current = await revisionAt(base);
    if (current !== expected) {
      const campaignId = result.log?.campaignId;
      const conflict = new Error(
        campaignId
          ? `Report for campaign "${campaignId}" was modified by another run.`
          : "Report was modified by another run.",
      );
      (conflict as { code?: string }).code = "ECONFLICT";
      (conflict as { revision?: string }).revision = current;
      throw conflict;
    }
  }

  let assets = fresh;
  if (merge) {
    // Merge against this campaign's own prior report (not the global latest), so a
    // re-roll of one brief never folds in another brief's creatives. Map preserves
    // existing order; re-keying an existing entry updates it in place, new cells append.
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
