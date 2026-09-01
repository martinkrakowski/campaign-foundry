import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { parse as parseYaml } from "yaml";
import {
  HEADLINE_POOL_REF,
  LAYOUT_VALUES,
  MAX_BEATS,
  MAX_WEIGHT,
  MOTION_KINDS,
  RATIO_VALUES,
  SAFE_ID_PATTERN,
  TONE_VALUES,
  isPaletteShift,
  timelineProblem,
  type CampaignBrief,
  type CopyTimeline,
  type RegenerationTarget,
} from "@campaignfoundry/CampaignOrchestration";
import { isPlatformVisible, platformProfile, type PlatformProfile } from "@campaignfoundry/Distribution";
import { getCapabilities, type Capabilities } from "./capabilities.js";

const REQUIRED_FIELDS = ["id", "targetRegion", "targetAudience", "campaignMessage", "products"] as const;

/**
 * Explicit cap on YAML alias expansion (a billion-laughs bomb is a brief with
 * a few anchors and a deep list). The `yaml` package defaults to 100; pinning
 * it here keeps the load path and the Document write path (`brief-files.ts`)
 * on the same cap. The load path's schema is the `yaml` package default, YAML
 * 1.2 — the same schema `dumpBrief` writes with, so load and dump agree.
 */
export const YAML_ALIAS_CAP = 100;

/** Throw unless `value` is a path-safe slug. `label` names the field in the error. */
export function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a path-safe slug (lowercase letters, digits, hyphens; max 64 chars); got ${JSON.stringify(value)}.`,
    );
  }
}

/** Supported variation axes — always accepted (`headline` only as `pool://copy`). */
export const SUPPORTED_AXES = ["layout", "tone", "ratio", "background", "paletteShift", "headline"] as const;

/** Motion axes — accepted only while the ffmpeg capability is on (D8). */
export const MOTION_AXES = ["motion", "duration"] as const;

/** P0 output formats — always accepted. */
export const SUPPORTED_FORMATS = ["static"] as const;

/** Output format accepted only while the ffmpeg capability is on (D8). */
export const MOTION_FORMAT = "motion";

/** Transitions supported between motion copy beats (D9). */
export const TIMELINE_TRANSITIONS = ["cut", "fade"] as const;

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
    // A shift is a hue rotation in TURNS, so 1 is a whole circle and means exactly what 0
    // means. Accepting anything outside [0, 1) would let a brief ask for a full rotation, or
    // for -0.1, and quietly receive something else — 1 renders as no shift at all, and a
    // negative used to render differently from the colour the editor previewed. Refuse it
    // and say what the range is, rather than wrapping it behind the author's back.
    if (!isPaletteShift(entry)) {
      throw new Error(
        `Campaign brief field "variation.axes.paletteShift" must contain turns in [0, 1) — ` +
          `1 is a whole circle and means the same as 0; got ${JSON.stringify(entry)}.`,
      );
    }
  }
}

/**
 * `ratio` requests a subset of the three canvases: a non-empty, de-duplicated
 * array of supported ratios. Absent means every ratio, so a brief without the
 * key parses exactly as before. A structural rule, not a capability one — the
 * motion narrowing is applied by the planner, not the parser.
 */
function validateRatioAxis(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('Campaign brief field "variation.axes.ratio" must be an array.');
  }
  if (value.length === 0) {
    throw new Error(
      'Campaign brief field "variation.axes.ratio" must select at least one aspect ratio (omit it for all).',
    );
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !(RATIO_VALUES as readonly string[]).includes(entry)) {
      throw new Error(`Campaign brief field "variation.axes.ratio" has unsupported value ${JSON.stringify(entry)}.`);
    }
    if (seen.has(entry)) {
      // The planner de-duplicates this axis, so a repeat would draw nothing.
      throw new Error(
        `Campaign brief field "variation.axes.ratio" repeats ${JSON.stringify(entry)} — list each ratio once.`,
      );
    }
    seen.add(entry);
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
  if (value.ratio !== undefined) {
    validateRatioAxis(value.ratio);
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
function validatePlatforms(value: unknown, capabilities: Capabilities): PlatformProfile[] {
  const profiles: PlatformProfile[] = [];
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
    profiles.push(profile);
  }
  return profiles;
}

/**
 * Formats and platforms must agree: every requested format needs a platform that
 * packages it, and every platform needs a requested format it packages — otherwise
 * the run renders creatives nothing can ship (`formats: [static]` + `instagram-reel`)
 * or lists a platform that would package nothing (`formats: [motion]` + `instagram-feed`).
 * `formats` defaults to `[static]`, as the planner does.
 */
function validateFormatPlatformCompatibility(formats: readonly string[], platforms: readonly PlatformProfile[]): void {
  const list = (values: readonly string[]): string => `[${values.join(", ")}]`;
  for (const { id, formats: packaged } of platforms) {
    if (!packaged.some((format) => formats.includes(format))) {
      throw new Error(
        `Output platform "${id}" packages only ${list(packaged)}, which output.formats ${list(formats)} does not request.`,
      );
    }
  }
  for (const format of formats) {
    if (!platforms.some((profile) => (profile.formats as readonly string[]).includes(format))) {
      throw new Error(
        `Output format "${format}" is requested but none of output.platforms ${list(platforms.map((p) => p.id))} can package it.`,
      );
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
    const profiles = validatePlatforms(value.platforms, capabilities);
    validateFormatPlatformCompatibility(
      (value.formats as readonly string[] | undefined) ?? [...SUPPORTED_FORMATS],
      profiles,
    );
  }
}

/**
 * `formats: motion` with an explicitly empty motion axis is a contradiction: the
 * brief asks for clips but forbids every kind. An absent axis means all kinds.
 */
function validateMotionAxisRequested(record: Record<string, unknown>): void {
  const formats = (record.output as Record<string, unknown> | undefined)?.formats;
  if (!Array.isArray(formats) || !formats.includes(MOTION_FORMAT)) return;
  const axes = (record.variation as Record<string, unknown> | undefined)?.axes as Record<string, unknown> | undefined;
  if (Array.isArray(axes?.motion) && axes.motion.length === 0) {
    throw new Error(
      `Campaign brief field "variation.axes.motion" must select at least one motion kind when output.formats includes "${MOTION_FORMAT}".`,
    );
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
 * Structurally validate `copy.timeline` (D1).
 *
 * In authoring mode (`enforceCapabilities: false`), only structural rules and D5's mutual
 * exclusions are enforced — dwell floor (D3) and motion capability checks are deferred to
 * the running paths so invalid/unrunnable timelines remain persistable and fixable in the
 * editor (D11/D15).
 */
function validateCopy(record: Record<string, unknown>, enforceCapabilities: boolean): void {
  if (record.copy === undefined) return;
  if (!isPlainObject(record.copy)) {
    throw new Error('Campaign brief field "copy" must be an object.');
  }
  const timeline = record.copy.timeline;
  if (timeline === undefined) return;
  if (!isPlainObject(timeline)) {
    throw new Error('Campaign brief field "copy.timeline" must be an object.');
  }

  if (
    timeline.transition !== undefined &&
    (typeof timeline.transition !== "string" ||
      !(TIMELINE_TRANSITIONS as readonly string[]).includes(timeline.transition))
  ) {
    throw new Error(
      `Campaign brief field "copy.timeline.transition" must be "cut" or "fade"; got ${JSON.stringify(timeline.transition)}.`,
    );
  }

  if (!Array.isArray(timeline.beats)) {
    throw new Error('Campaign brief field "copy.timeline.beats" must be an array.');
  }
  if (timeline.beats.length === 0) {
    throw new Error("copy.timeline.beats must not be empty.");
  }
  if (timeline.beats.length > MAX_BEATS) {
    throw new Error(`copy.timeline.beats holds more than ${MAX_BEATS} beats (max ${MAX_BEATS}).`);
  }

  for (let i = 0; i < timeline.beats.length; i += 1) {
    const beat = timeline.beats[i];
    if (!isPlainObject(beat)) {
      throw new Error(`Campaign brief field "copy.timeline.beats[${i}]" must be an object.`);
    }
    if (typeof beat.text !== "string") {
      throw new Error(`Campaign brief field "copy.timeline.beats[${i}].text" must be a string.`);
    }
    const weight = beat.weight;
    if (!isFiniteInteger(weight) || weight < 1 || weight > MAX_WEIGHT) {
      throw new Error(`copy.timeline.beats[${i}].weight must be an integer in [1, ${MAX_WEIGHT}].`);
    }
  }

  if (timeline.keyBeat !== undefined) {
    if (
      !isFiniteInteger(timeline.keyBeat) ||
      timeline.keyBeat < 1 ||
      timeline.keyBeat > timeline.beats.length
    ) {
      throw new Error(
        `copy.timeline.keyBeat must be an integer in [1, ${timeline.beats.length}].`,
      );
    }
  }

  // D5: copy.timeline together with axes.headline: pool://copy is invalid.
  const axes = (record.variation as Record<string, unknown> | undefined)?.axes as
    | Record<string, unknown>
    | undefined;
  if (axes?.headline !== undefined) {
    throw new Error(
      'Campaign brief cannot combine "copy.timeline" with "variation.axes.headline" — motion copy sequences are fixed across variants.',
    );
  }

  // D5: copy.timeline on any brief that cannot render motion (classic mode or formats without motion).
  const formats = (record.output as Record<string, unknown> | undefined)?.formats;
  const canRenderMotion =
    record.mode === "variation" && Array.isArray(formats) && formats.includes(MOTION_FORMAT);
  if (!canRenderMotion) {
    throw new Error(
      `Campaign brief field "copy.timeline" requires motion output (mode "variation" and output.formats including "${MOTION_FORMAT}").`,
    );
  }

  // Write the defaults onto the record, not onto a temporary. `parseBrief` returns this
  // same record as a CampaignBrief, and CopyTimeline declares `transition` and `keyBeat`
  // required — defaulting them only for the check below hands every caller a value the
  // domain says cannot exist, and `timelineProblem` rejects it on the round trip.
  timeline.transition = (timeline.transition as "cut" | "fade" | undefined) ?? "fade";
  timeline.keyBeat = (timeline.keyBeat as number | undefined) ?? 1;

  if (enforceCapabilities) {
    const durations = (axes?.duration as readonly number[] | undefined) ?? [];
    const problem = timelineProblem(timeline as unknown as CopyTimeline, durations);
    if (problem) {
      throw new Error(problem);
    }
  }
}

/**
 * Structurally validate an untrusted value into a CampaignBrief. Business rules
 * live in the use case. `capabilities` gates the motion allowlist (D8); it defaults
 * to the boot probe's snapshot and is injectable so tests can flip it.
 */
/** How a brief is validated: authoring accepts what this host cannot run (D7/D12/D15). */
export interface ParseBriefOptions {
  /** Probe snapshot to validate against; defaults to the boot probe. */
  capabilities?: Capabilities;
  /** Enforce the motion capability. Authoring (listing, persistence) leaves this false. */
  enforceCapabilities?: boolean;
}

/**
 * Structurally validate an untrusted value into a CampaignBrief. Business rules live in
 * the use case.
 *
 * `enforceCapabilities` defaults to **false**: a brief that names motion is structurally
 * valid everywhere, so it can be listed and saved on a host with no ffmpeg (D7/D12/D15).
 * The run paths — plan and generate — pass `true` and refuse what this host cannot make.
 */
export function parseBrief(data: unknown, opts: ParseBriefOptions = {}): CampaignBrief {
  const capabilities = opts.capabilities ?? getCapabilities();
  const enforceCapabilities = opts.enforceCapabilities ?? false;

  // When not enforcing capabilities, pretend motion is available to skip capability checks
  const effectiveCapabilities: Capabilities = enforceCapabilities ? capabilities : { motion: true };

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
  validateVariation(record.variation, effectiveCapabilities);
  validateOutput(record.output, effectiveCapabilities);
  validateMotionAxisRequested(record);
  validateCopy(record, enforceCapabilities);
  // Motion is a variation axis: only the planner draws clips, and the classic
  // product × ratio × treatment matrix has no motion path, so a classic brief that
  // requests `formats: motion` would silently render stills. Refuse it on the run
  // paths. Authoring mode still accepts it so the file stays listed and can be fixed
  // in the editor rather than vanishing from the picker (the D15 split, applied here).
  if (enforceCapabilities && record.mode !== "variation") {
    const formats = (record.output as Record<string, unknown> | undefined)?.formats;
    if (Array.isArray(formats) && formats.includes(MOTION_FORMAT)) {
      throw new Error(
        `Output format "${MOTION_FORMAT}" requires mode "variation" — a classic campaign renders stills only.`,
      );
    }
  }
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

/**
 * Parse a brief from bytes already read; `path` only selects the format
 * (.json vs .yaml/.yml). Validation follows `opts` — authoring by default.
 */

export function parseBriefText(path: string, raw: string, opts: ParseBriefOptions = {}): CampaignBrief {
  const data =
    extname(path).toLowerCase() === ".json"
      ? JSON.parse(raw)
      : parseYaml(raw, { maxAliasCount: YAML_ALIAS_CAP });
  return parseBrief(data, opts);
}

/** Load and parse a brief from a .yaml / .yml / .json file. */
export async function loadBrief(path: string, opts: ParseBriefOptions = {}): Promise<CampaignBrief> {
  const filePath = isAbsolute(path) ? path : resolve(projectRoot(), path);
  const raw = await readFile(filePath, "utf8");
  return parseBriefText(filePath, raw, opts);
}
