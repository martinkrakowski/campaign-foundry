import { assetIdentity, isAudioRights } from "@campaignfoundry/CampaignOrchestration";
import type {
  AudioRights,
  GeneratedAsset,
  PipelineResult,
} from "@campaignfoundry/CampaignOrchestration";
import { retireDecisions, withDecisionLock } from "./decisions.js";
import { getJobStore, getReportStore, type ReportStorePort } from "./ports/index.js";
import { JobLeaseLostError } from "./ports/job-store.port.js";
import type { StorageScope } from "./run-environment.js";

/** Persisted asset = the entity plus the derived `brandCompliant` view field. */
type ReportAsset = GeneratedAsset & { brandCompliant: boolean };

/** Asset identity within the campaign matrix (matches the review UI's key). */
const keyOf = (a: GeneratedAsset): string => assetIdentity(a);

/**
 * Read a campaign's persisted report, or `undefined` when the id is unsafe or
 * the report is missing / unreadable. A report that parses as JSON `null`
 * returns `null` (distinct from missing). Does not merge or write.
 */
export async function readReport(scope: StorageScope, campaignId: string): Promise<unknown> {
  return getReportStore(scope).readReport(campaignId);
}

/**
 * The revision of a campaign's persisted report, or undefined when the id is
 * unsafe or nothing is stored — the value a caller passes back as
 * `writeReport`'s `expectedRevision`. Mirrors `BriefStorePort.getRevision`.
 */
export async function reportRevision(
  scope: StorageScope,
  campaignId: string,
): Promise<string | undefined> {
  return getReportStore(scope).getRevision(campaignId);
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
  /** Music rights record (VE-D8) — motion rows only, following `clickDestination`'s chain. */
  audioRights?: AudioRights;
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

const isNonNegInt = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

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
  if (rec.clickDestination !== undefined && typeof rec.clickDestination !== "string") return false;
  // A malformed rights record is a cosmetic defect like a bad descriptor, but
  // packaging reads `expiresOn` off it directly (unlike `descriptor`), so it is
  // validated here rather than left as `unknown` — a row that fails is skipped
  // and counted, same as a motion row without a readable video path.
  if (rec.audioRights !== undefined) {
    if (!isAudioRights(rec.audioRights)) return false;
    // VE-D8 fix2 #5: music rights describe a motion clip's audio bed — a
    // static or html row cannot carry one. Without this, a licence attached
    // to the wrong row (or a copy-paste onto a static row) can expire and
    // reject a whole package for a row that was never audio.
    if (rec.format !== "motion") return false;
  }
  // `format` is absent on classic rows, else static | motion | html. An unknown format is
  // skipped (and counted) rather than packaged as a still; a motion row without a
  // readable mp4 path or a finite clip length can't be packaged or duration-checked;
  // an html row without bundle and fallback paths can't be packaged (D122).
  if (
    rec.format !== undefined &&
    rec.format !== "static" &&
    rec.format !== "motion" &&
    rec.format !== "html"
  )
    return false;
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
async function readPersistedAssets(
  store: ReportStorePort,
  campaignId: string,
): Promise<ReportAsset[]> {
  // The store answers `undefined` for a missing or unreadable report, so there is
  // no parse failure to catch here. A store that throws fails the write instead:
  // merging over an empty base would overwrite the report it could not read.
  const parsed: unknown = await store.readReport(campaignId);
  const assets = (parsed as { assets?: unknown })?.assets;
  if (!Array.isArray(assets)) return [];
  const persisted = assets.filter(isPersistedAsset) as ReportAsset[];
  if (persisted.length !== assets.length) {
    console.warn(
      `[report] dropped ${assets.length - persisted.length} invalid persisted asset(s) from the campaign's report during merge`,
    );
  }
  return persisted;
}

/**
 * Persist a run's report through the report store; returns the store's locator.
 *
 * Reports are keyed by campaign id so every brief's run survives independently —
 * switching briefs in the UI reloads the right one instead of always seeing the most
 * recent run. There is no "latest" copy (PT-0a): a run without a campaign id has
 * nowhere to go and is refused.
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
  scope: StorageScope,
  result: PipelineResult,
  {
    merge = false,
    expectedRevision,
    fence,
  }: {
    merge?: boolean;
    expectedRevision?: string | null;
    fence?: { runId: string };
  } = {},
): Promise<string> {
  // The campaign id is the report's identity: the use case always stamps the brief id,
  // and a run without one has no report to write (the "latest" pointer is gone).
  const campaignId = result.log?.campaignId;
  if (!campaignId) throw new Error("A run report needs a campaign id; this run has none.");
  const store = getReportStore(scope);

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
    // started against no report says `null`, which the store reports as `undefined`.
    // Carrying `undefined` here would mean "do not check", and a report created while
    // that run was in flight would be overwritten by a merge that never saw it.
    const expected = expectedRevision ?? undefined;
    const current = await store.getRevision(campaignId);
    if (current !== expected) {
      const conflict = new Error(
        `Report for campaign "${campaignId}" was modified by another run.`,
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
      (await readPersistedAssets(store, campaignId)).map((a) => [keyOf(a), a] as const),
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
      ...(result.copyHash !== undefined ? { copyHash: result.copyHash } : {}),
      ...(result.seed !== undefined ? { seed: result.seed } : {}),
    },
    null,
    2,
  );
  // The creatives this run replaces go back to review (D173): the ones it
  // regenerated after a merge, every one after a full run. Under the campaign's
  // decision lock, so no verdict can be saved between the retirement and the
  // report it makes way for, and before the write, so a failed retirement
  // publishes nothing and a failed write only returns creatives to review.
  return withDecisionLock(scope, campaignId, async (decisions) => {
    if (fence !== undefined) {
      // Before the store write, refuse unless the job store entry for runId is running.
      // This is not atomic, which is acceptable on the single-process fs backend;
      // PgReportStore / PgDecisionStore check the fence atomically inside their write transactions.
      const entry = await getJobStore(scope).getStoredJob(fence.runId);
      if (entry?.job.status !== "running") {
        throw new JobLeaseLostError(fence.runId);
      }
    }
    await retireDecisions(
      decisions,
      campaignId,
      merge ? new Set(fresh.map(keyOf)) : undefined,
      fence,
      scope,
    );
    // The store repeats the compare-and-swap in its own atomic step (PT-3c), so
    // the cross-process race this guard only narrows (D79 on files) is closed
    // too. `expectedRevision` is passed through exactly — never `?? undefined`,
    // which would turn `null` ("nothing stored yet") into "do not check".
    return store.writeReport(campaignId, payload, expectedRevision, fence);
  });
}
