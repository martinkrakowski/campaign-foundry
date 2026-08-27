import type { EditorState } from "./editor-state";
import { LAYOUT_OPTIONS, TONE_OPTIONS, RATIO_OPTIONS, approvedHeadlines } from "./editor-state";
import { PLATFORM_PROFILES, type PlatformProfile } from "@campaignfoundry/Distribution/platform-profiles";

export const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
/** Whole-second clip durations the API accepts (load-brief's MIN/MAX_DURATION_SEC). */
export const MIN_DURATION_SEC = 2;
export const MAX_DURATION_SEC = 30;

export type FieldErrors = Record<string, string>;

const UINT32_MAX = 0xffffffff;
const BASE_DISTANCE_AXES = 6;

/** Ratios the requested platforms package motion at — the motion filter's allowlist. */
export function motionPackagedRatios(state: EditorState): Set<string> {
  return new Set(
    state.platforms
      .map((id) => PLATFORM_PROFILES[id])
      .filter((profile): profile is PlatformProfile => profile !== undefined)
      .filter((profile) => (profile.formats as readonly string[]).includes("motion"))
      .map((profile) => profile.ratio),
  );
}

/** True while the motion narrowing applies: a motion-only brief has no still slot to fall back to. */
function motionOnly(state: EditorState): boolean {
  return state.formats.includes("motion") && !state.formats.includes("static");
}

/**
 * Ratios a slot can be drawn at, mirroring VariationPolicy: the requested
 * subset, narrowed by the motion filter for a motion-only brief (the ratios its
 * motion platforms package). Empty when every selected ratio is excluded.
 */
export function drawableRatios(state: EditorState): string[] {
  const requested = state.variation.ratio;
  if (!motionOnly(state)) return [...requested];
  const packaged = motionPackagedRatios(state);
  return requested.filter((ratio) => packaged.has(ratio));
}

/**
 * The projected per-ratio deal of `count`: dealt round-robin across the
 * drawable ratios in panel order — the same round-robin the planner's coverage
 * pass uses, so every drawable ratio's share stays ≥ the floor while the
 * numbers differ per panel. Ratios not drawn (unselected or excluded) get 0.
 */
export function ratioAllocation(state: EditorState): Record<string, number> {
  const drawable = drawableRatios(state);
  const allocation: Record<string, number> = {};
  for (const ratio of RATIO_OPTIONS) allocation[ratio] = 0;
  const count = Math.max(0, Number.parseInt(state.variation.count, 10) || 0);
  if (drawable.length === 0) return allocation;
  const base = Math.floor(count / drawable.length);
  let remainder = count % drawable.length;
  for (const ratio of drawable) {
    allocation[ratio] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return allocation;
}

/**
 * How many distinct variants this brief's axes can produce — the planner's hard
 * ceiling on `count`, mirroring `VariationPolicy.axisProductSize`. Drives the count
 * slider's bound, so the editor cannot author a count the planner will refuse.
 */
export function axisProductSize(state: EditorState): number {
  const motionEnabled = state.formats.includes("motion") && state.motion.length > 0;
  const mixStatic = motionEnabled && state.formats.includes("static");
  return (
    Math.max(1, state.products.filter((product) => product.id.length > 0).length) *
    Math.max(1, drawableRatios(state).length) *
    Math.max(1, state.variation.layout.length) *
    Math.max(1, state.variation.tone.length) *
    Math.max(1, state.variation.background.length) *
    Math.max(1, state.variation.paletteShift.length) *
    Math.max(1, state.variation.headline ? approvedHeadlines(state.pool) : 1) *
    (motionEnabled ? state.motion.length * Math.max(1, state.duration.length) + (mixStatic ? 1 : 0) : 1)
  );
}

export function maxMinDistance(state: EditorState): number {
  let axes = BASE_DISTANCE_AXES;
  if (state.variation.headline) axes += 1;
  // Mirror VariationPolicy.vo's `motionEnabled = wantsMotion && motion.length > 0`.
  // Counting retained kinds while `motion` is not a requested format would let a
  // static draft pass with a minDistance the planner then rejects — `durationSec`
  // is drawn only on motion slots, so it follows `motion`.
  if (state.formats.includes("motion") && state.motion.length > 0) axes += 2;
  return axes;
}

function isIntegerAtLeast(value: string, min: number): boolean {
  if (value.trim() === "") return false;
  const num = Number(value);
  return Number.isInteger(num) && num >= min;
}

function isIntegerInRange(value: string, min: number, max: number): boolean {
  const num = Number(value);
  return Number.isInteger(num) && num >= min && num <= max;
}

function isOptionalIntegerAtLeast(value: string, min: number): boolean {
  if (value.trim() === "") return true;
  return isIntegerAtLeast(value, min);
}

function isOptionalIntegerInRange(value: string, min: number, max: number): boolean {
  if (value.trim() === "") return true;
  return isIntegerInRange(value, min, max);
}

export function validateIdentity(state: EditorState, existingIds?: string[]): FieldErrors {
  const errors: FieldErrors = {};
  if (!SAFE_ID_PATTERN.test(state.briefId)) {
    errors.briefId = "Lowercase letters, digits and hyphens only (max 64) — used as the reload key.";
  }
  // Region and audience are rendered by the Identity section, so their errors belong to
  // it — filed under Copy they would never reach their inputs, and the error strip would
  // scroll past the fields actually blocking Save.
  if (state.targetRegion.trim() === "") errors.targetRegion = "Target region is required.";
  if (state.targetAudience.trim() === "") errors.targetAudience = "Target audience is required.";
  if (existingIds) {
    const conflictingId = state.briefId;
    if (state.source.kind === "new") {
      if (existingIds.includes(conflictingId)) {
        errors.briefId = `A brief with id "${conflictingId}" already exists.`;
      }
    } else {
      // state.source.kind === "file"
      const source = state.source;
      if (source.loadedId !== state.briefId) {
        const otherIds = existingIds.filter((id) => id !== source.loadedId);
        if (otherIds.includes(conflictingId)) {
          errors.briefId = `A brief with id "${conflictingId}" already exists.`;
        }
      }
    }
  }
  return errors;
}

export function validateCopy(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.campaignMessage.trim() === "") errors.campaignMessage = "Campaign message is required.";
  return errors;
}

export function validateProducts(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  const min = state.mode === "variation" ? 1 : 2;
  const ids = state.products.map((product) => product.id);
  const unique = new Set(ids.filter((id) => id.length > 0));
  if (unique.size < min) {
    errors.products = `A ${state.mode === "variation" ? "randomized" : "classic"} campaign requires at least ${min} unique product${min === 1 ? "" : "s"}.`;
  }
  const seen = new Set<string>();
  state.products.forEach((product, index) => {
    if (!SAFE_ID_PATTERN.test(product.id)) {
      errors[`product-${index}-id`] =
        "Product id must be a path-safe slug (lowercase letters, digits, hyphens; max 64).";
    } else if (seen.has(product.id)) {
      errors[`product-${index}-id`] = `Duplicate product id "${product.id}".`;
    } else {
      seen.add(product.id);
    }
    if (product.name.trim() === "") errors[`product-${index}-name`] = "Name is required.";
    if (!HEX_COLOR_PATTERN.test(product.primaryColor)) {
      errors[`product-${index}-color`] = "Colour must be a 6-digit hex value (e.g. #1473E6).";
    }
    if (product.logoPath.trim() === "") {
      errors[`product-${index}-logo`] = "Logo path is required (upload or enter a path).";
    }
  });
  return errors;
}

export function validateTreatments(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.mode !== "brief" || state.treatments.length === 0) return errors;
  const seen = new Set<string>();
  state.treatments.forEach((treatment, index) => {
    if (!SAFE_ID_PATTERN.test(treatment.id)) {
      errors[`treatment-${index}-id`] =
        "Treatment id must be a path-safe slug (lowercase letters, digits, hyphens; max 64).";
    } else if (seen.has(treatment.id)) {
      errors[`treatment-${index}-id`] = `Duplicate treatment id "${treatment.id}".`;
    } else {
      seen.add(treatment.id);
    }
    if (!LAYOUT_OPTIONS.includes(treatment.layout as never)) {
      errors[`treatment-${index}-layout`] = `Invalid layout. Choose from: ${LAYOUT_OPTIONS.join(", ")}.`;
    }
    if (!TONE_OPTIONS.includes(treatment.tone as never)) {
      errors[`treatment-${index}-tone`] = `Invalid tone. Choose from: ${TONE_OPTIONS.join(", ")}.`;
    }
  });
  return errors;
}

export function validatePolicy(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.mode !== "variation") return errors;
  if (!isIntegerAtLeast(state.variation.count, 1)) {
    errors.count = "variation.count must be an integer >= 1.";
  }
  if (!isOptionalIntegerInRange(state.variation.seed, 0, UINT32_MAX)) {
    errors.seed = "variation.seed must be an integer in [0, 2^32).";
  }
  const maxDistance = maxMinDistance(state);
  if (!isOptionalIntegerInRange(state.variation.minDistance, 0, maxDistance)) {
    errors.minDistance = `variation.minDistance must be an integer in [0, ${maxDistance}] (the active axes).`;
  }
  if (!isOptionalIntegerAtLeast(state.variation.perProduct, 0)) {
    errors.perProduct = "coverage.perProduct must be an integer >= 0.";
  }
  if (!isOptionalIntegerAtLeast(state.variation.perRatio, 0)) {
    errors.perRatio = "coverage.perRatio must be an integer >= 0.";
  }
  if (state.variation.ratio.length === 0) {
    errors.ratio = "Select at least one aspect ratio.";
  }
  // The planner refuses a plan whose ratio floor cannot fit the count
  // (perRatio × the ratios it will draw > count); the editor says so before
  // the run instead of surfacing the shortfall as a plan error.
  const floor = Number.parseInt(state.variation.perRatio, 10) || 0;
  const drawableCount = drawableRatios(state).length;
  const count = Number.parseInt(state.variation.count, 10) || 0;
  if (floor > 0 && floor * drawableCount > count) {
    errors.perRatio = `coverage.perRatio ${floor} × ${drawableCount} selected ratios exceeds count ${count} — lower the floor, raise the count, or select fewer ratios.`;
  }
  if (state.variation.layout.length === 0) errors.layout = "Select at least one layout.";
  if (state.variation.tone.length === 0) errors.tone = "Select at least one tone.";
  if (state.variation.background.length === 0) {
    errors.background = "Select at least one background source.";
  }
  if (state.variation.paletteShift.length === 0) {
    errors.paletteShift = "Select at least one palette shift.";
  }
  return errors;
}

/**
 * D7: a capability being off makes a motion brief *unrunnable* on this host, not
 * invalid — this string is a status message, never the sole reason Save is blocked.
 * It quotes the probe's reason, which is the same text the API's 400 would carry.
 */
export function motionUnavailableReason(state: EditorState): string | undefined {
  if (state.capabilities?.motion !== false || !state.formats.includes("motion")) return undefined;
  return `Motion format is not available: ${state.capabilities.reason ?? "capability off"}.`;
}

export function validateOutput(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.formats.length === 0) {
    errors.formats = "Select at least one format.";
  }
  if (state.platforms.length === 0) {
    errors.platforms = "Select at least one platform.";
  }
  // Client mirror of the API's validateFormatPlatformCompatibility: both directions
  // matter — a platform with nothing to package, and a format nothing can ship.
  const profiles = state.platforms
    .map((id) => PLATFORM_PROFILES[id])
    .filter((profile): profile is PlatformProfile => profile !== undefined);
  for (const profile of profiles) {
    if (!profile.formats.some((format) => state.formats.includes(format))) {
      // The API states the rejection; the editor has to say what to do about it.
      errors.platforms = `"${profile.id}" only packages ${profile.formats.join(" or ")} — request that format, or remove the platform.`;
      break;
    }
  }
  for (const format of state.formats) {
    if (!profiles.some((profile) => (profile.formats as readonly string[]).includes(format))) {
      // Name the platforms that would satisfy it rather than only the ones that do not:
      // selecting a format makes its platforms appear, and the message should point there.
      const candidates = Object.values(PLATFORM_PROFILES)
        .filter((profile) => (profile.formats as readonly string[]).includes(format))
        .map((profile) => profile.id);
      errors.formats = `No selected platform packages "${format}" — add one of: ${candidates.join(", ")}.`;
      break;
    }
  }
  const unavailable = motionUnavailableReason(state);
  if (unavailable) errors.formats = unavailable;
  // Motion is drawn by the variation planner only; the classic matrix renders stills.
  // This is structural, not a capability, so it blocks Save — the remedy is a mode
  // switch, and it outranks the capability message because it is the root cause.
  if (state.mode !== "variation" && state.formats.includes("motion")) {
    errors.formats = "Motion output requires a randomized campaign — switch the mode to Randomized.";
  }
  return errors;
}

export function validateMotion(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (!state.formats.includes("motion")) return errors;
  if (state.motion.length === 0) {
    errors.motion = "Select at least one motion kind.";
  }
  if (state.duration.length === 0) {
    errors.duration = "Add at least one duration.";
  } else if (
    state.duration.some(
      (seconds) => !Number.isInteger(seconds) || seconds < MIN_DURATION_SEC || seconds > MAX_DURATION_SEC,
    )
  ) {
    errors.duration = `Durations must be whole seconds between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC}.`;
  } else if (new Set(state.duration).size !== state.duration.length) {
    // The planner de-duplicates this axis, so a repeat draws nothing — say so rather
    // than letting it look like an extra clip length.
    errors.duration = "Each duration must be distinct — the planner draws each length once.";
  }
  return errors;
}

export function validateState(state: EditorState, existingIds?: string[]): Record<string, FieldErrors> {
  return {
    identity: validateIdentity(state, existingIds),
    copy: validateCopy(state),
    products: validateProducts(state),
    treatments: validateTreatments(state),
    policy: validatePolicy(state),
    output: validateOutput(state),
    motion: validateMotion(state),
  };
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function hasSectionErrors(sectionErrors: Record<string, FieldErrors>, section: string): boolean {
  return hasErrors(sectionErrors[section] ?? {});
}

export function getTotalErrorCount(sectionErrors: Record<string, FieldErrors>): number {
  return Object.values(sectionErrors).reduce((count, errors) => count + Object.keys(errors).length, 0);
}
