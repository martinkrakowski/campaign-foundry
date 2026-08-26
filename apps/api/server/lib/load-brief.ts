import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import * as yaml from "js-yaml";
import {
  HEADLINE_POOL_REF,
  LAYOUT_VALUES,
  MOTION_KINDS,
  SAFE_ID_PATTERN,
  TONE_VALUES,
  type CampaignBrief,
  type RegenerationTarget,
} from "@campaignfoundry/CampaignOrchestration";
import { isPlatformVisible, platformProfile } from "@campaignfoundry/Distribution";
import { getCapabilities, type Capabilities } from "./capabilities.js";

const REQUIRED_FIELDS = ["id", "targetRegion", "targetAudience", "campaignMessage", "products"] as const;

/** Throw unless `value` is a path-safe slug. `label` names the field in the error. */
export function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a path-safe slug (lowercase letters, digits, hyphens; max 64 chars); got ${JSON.stringify(value)}.`,
    );
  }
}

/** Supported variation axes — always accepted (`headline` only as `pool://copy`). */
export const SUPPORTED_AXES = ["layout", "tone", "background", "paletteShift", "headline"] as const;

/** Motion axes — accepted only while the ffmpeg capability is on (D8). */
export const MOTION_AXES = ["motion", "duration"] as const;

/** P0 output formats — always accepted. */
export const SUPPORTED_FORMATS = ["static"] as const;

/** Output format accepted only while the ffmpeg capability is on (D8). */
export const MOTION_FORMAT = "motion";

/** Clip length bounds in whole seconds. */
const MIN_DURATION_SEC = 2;
const MAX_DURATION_SEC = 30;

const BACKGROUND_SOURCES = ["procedural", "asset-pool", "genai"] as const;
const BRIEF_MODES = ["brief", "variation"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertFiniteIntegerAtLeast(value: unknown, field: string, min: number): void {
  if (!isFiniteInteger(value) || value < min) {
    throw new Error(`Campaign brief field "${field}" must be a finite integer >= ${min}.`);
  }
}

function assertAllowedStringArray(value: unknown, field: string, allowed: readonly string[]): void {
  if (!Array.isArray(value)) {
    throw new Error(`Campaign brief field "${field}" must be an array.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.includes(entry)) {
      throw new Error(`Campaign brief field "${field}" has unsupported value ${JSON.stringify(entry)}.`);
    }
  }
}

function validateMode(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !(BRIEF_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `Campaign brief field "mode" must be "brief" or "variation"; got ${JSON.stringify(value)}.`,
    );
  }
}

function validateCoverage(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new Error('Campaign brief field "variation.coverage" must be an object.');
  }
  if (value.perProduct !== undefined) {
    assertFiniteIntegerAtLeast(value.perProduct, "variation.coverage.perProduct", 0);
  }
  if (value.perRatio !== undefined) {
    assertFiniteIntegerAtLeast(value.perRatio, "variation.coverage.perRatio", 0);
  }
}

function validateBackground(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new Error('Campaign brief field "variation.axes.background" must be an object.');
  }
  if (value.source !== undefined) {
    assertAllowedStringArray(value.source, "variation.axes.background.source", BACKGROUND_SOURCES);
  }
}

function validatePaletteShift(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('Campaign brief field "variation.axes.paletteShift" must be an array.');
  }
  for (const entry of value) {
    if (!isFiniteNumber(entry)) {
      throw new Error('Campaign brief field "variation.axes.paletteShift" must contain finite numbers.');
    }
  }
}

/** Why motion is unavailable, for the parser's message; the probe's reason when it gave one. */
function motionUnavailable(capabilities: Capabilities): string {
  return `motion output is unavailable (${capabilities.reason ?? "ffmpeg capability is off"})`;
}

/**
 * `motion` (⊆ MOTION_KINDS) and `duration` (integers in [2, 30] s) — accepted only
 * while the ffmpeg probe reports motion; otherwise rejected with the probe's reason.
 */
function validateMotionAxes(value: Record<string, unknown>, capabilities: Capabilities): void {
  const present = MOTION_AXES.filter((axis) => axis in value);
  if (present.length === 0) return;
  if (!capabilities.motion) {
    throw new Error(`Unsupported variation axis "${present[0]}": ${motionUnavailable(capabilities)}.`);
  }
  if (value.motion !== undefined) {
    assertAllowedStringArray(value.motion, "variation.axes.motion", MOTION_KINDS);
  }
  if (value.duration !== undefined) {
    if (!Array.isArray(value.duration)) {
      throw new Error('Campaign brief field "variation.axes.duration" must be an array.');
    }
    for (const entry of value.duration) {
      if (!isFiniteInteger(entry) || entry < MIN_DURATION_SEC || entry > MAX_DURATION_SEC) {
        throw new Error(
          `Campaign brief field "variation.axes.duration" must contain integers between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC} seconds.`,
        );
      }
    }
  }
}

/**
 * `headline` is a pool reference, not a value list: the only supported pool is
 * the brief's approved copy pool (`pool://copy`). Anything else names the value.
 */
function validateHeadlineAxis(value: unknown): void {
  if (value === undefined) return;
  if (value !== HEADLINE_POOL_REF) {
    throw new Error(
      `Campaign brief field "variation.axes.headline" must be "${HEADLINE_POOL_REF}"; got ${JSON.stringify(value)}.`,
    );
  }
}

function validateAxes(value: unknown, capabilities: Capabilities): void {
  if (!isPlainObject(value)) {
    throw new Error('Campaign brief field "variation.axes" must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (
      !(SUPPORTED_AXES as readonly string[]).includes(key) &&
      !(MOTION_AXES as readonly string[]).includes(key)
    ) {
      throw new Error(`Unsupported variation axis "${key}".`);
    }
  }
  validateMotionAxes(value, capabilities);
  validateHeadlineAxis(value.headline);
  if (value.layout !== undefined) {
    assertAllowedStringArray(value.layout, "variation.axes.layout", LAYOUT_VALUES);
  }
  if (value.tone !== undefined) {
    assertAllowedStringArray(value.tone, "variation.axes.tone", TONE_VALUES);
  }
  if (value.background !== undefined) {
    validateBackground(value.background);
  }
  if (value.paletteShift !== undefined) {
    validatePaletteShift(value.paletteShift);
  }
}

function validateVariation(value: unknown, capabilities: Capabilities): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error('Campaign brief field "variation" must be an object.');
  }
  if (value.count !== undefined) {
    assertFiniteIntegerAtLeast(value.count, "variation.count", 1);
  }
  if (value.seed !== undefined) {
    if (!isFiniteNumber(value.seed)) {
      throw new Error('Campaign brief field "variation.seed" must be a finite number.');
    }
  }
  if (value.minDistance !== undefined) {
    assertFiniteIntegerAtLeast(value.minDistance, "variation.minDistance", 0);
  }
  if (value.coverage !== undefined) {
    validateCoverage(value.coverage);
  }
  if (value.axes !== undefined) {
    validateAxes(value.axes, capabilities);
  }
}

/** `static` always; `motion` only while the ffmpeg capability is on (D8). */
function validateFormats(value: unknown, capabilities: Capabilities): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Campaign brief field "output.formats" must be a non-empty array.');
  }
  for (const entry of value) {
    if (entry === MOTION_FORMAT) {
      if (!capabilities.motion) {
        throw new Error(`Unsupported output format "${MOTION_FORMAT}": ${motionUnavailable(capabilities)}.`);
      }
      continue;
    }
    if (typeof entry !== "string" || !(SUPPORTED_FORMATS as readonly string[]).includes(entry)) {
      throw new Error(`Unsupported output format ${JSON.stringify(entry)}.`);
    }
  }
}

/** Every PLATFORM_PROFILES id whose formats this host can produce (motion ones need the capability). */
function validatePlatforms(value: unknown, capabilities: Capabilities): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      'Campaign brief field "output.platforms" must be a non-empty array of non-empty strings.',
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        'Campaign brief field "output.platforms" must be a non-empty array of non-empty strings.',
      );
    }
    const profile = platformProfile(entry);
    if (!profile) {
      throw new Error(`Unknown output platform ${JSON.stringify(entry)}.`);
    }
    if (!isPlatformVisible(profile, capabilities)) {
      throw new Error(`Unsupported output platform "${entry}": ${motionUnavailable(capabilities)}.`);
    }
  }
}

function validateOutput(value: unknown, capabilities: Capabilities): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error('Campaign brief field "output" must be an object.');
  }
  if (value.formats !== undefined) {
    validateFormats(value.formats, capabilities);
  }
  if (value.platforms !== undefined) {
    validatePlatforms(value.platforms, capabilities);
  }
}

/** Structurally validate the optional `treatments` array, when present. */
function validateTreatments(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error('Campaign brief field "treatments" must be an array.');
  }
  const seen = new Set<string>();
  for (const t of value) {
    const rec = t as Record<string, unknown>;
    assertSafeId(rec?.id, "Treatment id");
    if (seen.has(rec.id)) {
      throw new Error(`Duplicate treatment id "${rec.id}" — ids must be unique within a brief.`);
    }
    seen.add(rec.id);
    if (!LAYOUT_VALUES.includes(rec.layout as (typeof LAYOUT_VALUES)[number])) {
      throw new Error(`Treatment "${rec.id}" has invalid layout (expected one of ${LAYOUT_VALUES.join(", ")}).`);
    }
    if (!TONE_VALUES.includes(rec.tone as (typeof TONE_VALUES)[number])) {
      throw new Error(`Treatment "${rec.id}" has invalid tone (expected one of ${TONE_VALUES.join(", ")}).`);
    }
  }
}

/**
 * Structurally validate an untrusted value into a CampaignBrief. Business rules
 * live in the use case. `capabilities` gates the motion allowlist (D8); it defaults
 * to the boot probe's snapshot and is injectable so tests can flip it.
 */
export function parseBrief(data: unknown, capabilities: Capabilities = getCapabilities()): CampaignBrief {
  if (typeof data !== "object" || data === null) {
    throw new Error("Campaign brief must be an object.");
  }
  const record = data as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      throw new Error(`Campaign brief is missing required field: "${field}".`);
    }
  }
  // The brief id is the campaign's persisted-report filename (per-campaign reload), so
  // enforce the same path-safe slug as product/treatment ids — an unsafe id would run
  // but never persist/reload per-campaign.
  assertSafeId(record.id, "Campaign id");
  if (!Array.isArray(record.products)) {
    throw new Error('Campaign brief field "products" must be an array.');
  }
  for (const p of record.products) {
    assertSafeId((p as Record<string, unknown>)?.id, "Product id");
  }
  validateTreatments(record.treatments);
  validateMode(record.mode);
  validateVariation(record.variation, capabilities);
  validateOutput(record.output, capabilities);
  // A randomized campaign has no meaning without a total: `count` is the planner's
  // one required input (plan D13), so demand it up front rather than at run time.
  if (record.mode === "variation") {
    const variation = record.variation as Record<string, unknown> | undefined;
    if (variation?.count === undefined) {
      throw new Error('Campaign brief field "variation.count" is required when mode is "variation".');
    }
  }
  return record as unknown as CampaignBrief;
}

/**
 * Structurally validate an untrusted `regenerateOnly` list (the HITL re-roll targets).
 * Returns undefined when absent (a full run). These strings only ever drive set
 * membership in the use case — never path construction — but we validate shape so a
 * malformed payload fails fast with a clear 400 instead of a runtime error.
 */
export function parseRegenerateOnly(value: unknown): RegenerationTarget[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('"regenerateOnly" must be an array of { productId, aspectRatio, treatment }.');
  }
  // An empty list would enable selective mode yet target nothing — a silent no-op
  // run. Reject it so the contract fails fast instead (omit the field for a full run).
  if (value.length === 0) {
    throw new Error('"regenerateOnly" must contain at least one target (omit it for a full run).');
  }
  return value.map((entry) => {
    const rec =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    if (rec.variantIndex !== undefined) {
      if (typeof rec.productId !== "string") {
        throw new Error(
          '"regenerateOnly" variation entries require string productId and integer variantIndex >= 0.',
        );
      }
      if (!isFiniteInteger(rec.variantIndex) || rec.variantIndex < 0) {
        throw new Error('"regenerateOnly" variantIndex must be an integer >= 0.');
      }
      if (rec.attempt !== undefined && (!isFiniteInteger(rec.attempt) || rec.attempt < 0)) {
        throw new Error('"regenerateOnly" attempt must be an integer >= 0.');
      }
      return rec.attempt === undefined
        ? { productId: rec.productId, variantIndex: rec.variantIndex }
        : { productId: rec.productId, variantIndex: rec.variantIndex, attempt: rec.attempt };
    }
    if (
      typeof rec.productId !== "string" ||
      typeof rec.aspectRatio !== "string" ||
      typeof rec.treatment !== "string"
    ) {
      throw new Error(
        '"regenerateOnly" entries require string productId, aspectRatio, and treatment.',
      );
    }
    return { productId: rec.productId, aspectRatio: rec.aspectRatio, treatment: rec.treatment };
  });
}

/** Load and parse a brief from a .yaml / .yml / .json file. */
export async function loadBrief(path: string, capabilities?: Capabilities): Promise<CampaignBrief> {
  const raw = await readFile(path, "utf8");
  const data = extname(path).toLowerCase() === ".json" ? JSON.parse(raw) : yaml.load(raw);
  return parseBrief(data, capabilities);
}
