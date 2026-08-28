import { MAX_DURATION_SEC, MIN_DURATION_SEC } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import type { EditorState } from "./editor-state";
import {
  LAYOUT_OPTIONS,
  TONE_OPTIONS,
  approvedHeadlines,
  axisProductSize,
  drawableRatios,
  motionPackagedRatios,
} from "./editor-state";

// The draw-size helpers moved to `editor-state.ts` (the reducer's clamp needs them, and
// the two modules were importing each other); re-exported here for their old callers.
export { axisProductSize, drawableRatios, motionPackagedRatios } from "./editor-state";
import { PLATFORM_PROFILES, type PlatformProfile } from "@campaignfoundry/Distribution/platform-profiles";
import * as messages from "./messages";
import { formatDisplayName, platformDisplayName, ratioDisplayName } from "./display-names";

export const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
/** Whole-second clip durations the API accepts (load-brief's MIN/MAX_DURATION_SEC). */
export { MIN_DURATION_SEC, MAX_DURATION_SEC } from "@campaignfoundry/CampaignOrchestration/variation-defaults";

export type FieldErrors = Record<string, string>;

const UINT32_MAX = 0xffffffff;
const BASE_DISTANCE_AXES = 6;









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
    errors.briefId = messages.briefId;
  }
  // Region and audience are rendered by the Identity section, so their errors belong to
  // it — filed under Copy they would never reach their inputs, and the error strip would
  // scroll past the fields actually blocking Save.
  if (state.targetRegion.trim() === "") errors.targetRegion = messages.targetRegion;
  if (state.targetAudience.trim() === "") errors.targetAudience = messages.targetAudience;
  if (existingIds) {
    const conflictingId = state.briefId;
    if (state.source.kind === "new") {
      if (existingIds.includes(conflictingId)) {
        errors.briefId = messages.briefIdDuplicate(conflictingId);
      }
    } else {
      // state.source.kind === "file"
      const source = state.source;
      if (source.loadedId !== state.briefId) {
        const otherIds = existingIds.filter((id) => id !== source.loadedId);
        if (otherIds.includes(conflictingId)) {
          errors.briefId = messages.briefIdDuplicate(conflictingId);
        }
      }
    }
  }
  return errors;
}

export function validateCopy(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.campaignMessage.trim() === "") errors.campaignMessage = messages.campaignMessage;
  return errors;
}

export function validateProducts(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  const min = state.mode === "variation" ? 1 : 2;
  const ids = state.products.map((product) => product.id);
  const unique = new Set(ids.filter((id) => id.length > 0));
  if (unique.size < min) {
    errors.products = messages.products(min, state.mode === "variation" ? "Randomized" : "Classic");
  }
  const seen = new Set<string>();
  state.products.forEach((product, index) => {
    if (!SAFE_ID_PATTERN.test(product.id)) {
      errors[`product-${index}-id`] = messages.productId;
    } else if (seen.has(product.id)) {
      errors[`product-${index}-id`] = messages.productIdDuplicate(product.id);
    } else {
      seen.add(product.id);
    }
    if (product.name.trim() === "") errors[`product-${index}-name`] = messages.productName;
    if (!HEX_COLOR_PATTERN.test(product.primaryColor)) {
      errors[`product-${index}-color`] = messages.productColor;
    }
    if (product.logoPath.trim() === "") {
      errors[`product-${index}-logo`] = messages.productLogo;
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
      errors[`treatment-${index}-id`] = messages.treatmentId;
    } else if (seen.has(treatment.id)) {
      errors[`treatment-${index}-id`] = messages.treatmentIdDuplicate(treatment.id);
    } else {
      seen.add(treatment.id);
    }
    if (!LAYOUT_OPTIONS.includes(treatment.layout as never)) {
      errors[`treatment-${index}-layout`] = messages.treatmentLayout;
    }
    if (!TONE_OPTIONS.includes(treatment.tone as never)) {
      errors[`treatment-${index}-tone`] = messages.treatmentTone;
    }
  });
  return errors;
}

export function validatePolicy(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.mode !== "variation") return errors;
  if (!isIntegerAtLeast(state.variation.count, 1)) {
    errors.count = messages.count;
  }
  if (!isOptionalIntegerInRange(state.variation.seed, 0, UINT32_MAX)) {
    errors.seed = messages.seed;
  }
  const maxDistance = maxMinDistance(state);
  if (!isOptionalIntegerInRange(state.variation.minDistance, 0, maxDistance)) {
    errors.minDistance = messages.minDistance(maxDistance);
  }
  if (!isOptionalIntegerAtLeast(state.variation.perProduct, 0)) {
    errors.perProduct = messages.perProduct;
  }
  if (!isOptionalIntegerAtLeast(state.variation.perRatio, 0)) {
    errors.perRatio = messages.perRatio;
  }
  if (state.variation.ratio.length === 0) {
    errors.ratio = messages.ratio;
  }
  // The planner refuses a plan whose ratio floor cannot fit the count
  // (perRatio × the ratios it will draw > count); the editor says so before
  // the run instead of surfacing the shortfall as a plan error.
  const floor = Number.parseInt(state.variation.perRatio, 10) || 0;
  const drawable = drawableRatios(state);
  const drawableCount = drawable.length;
  // A selection the motion narrowing empties parses cleanly and saves, then
  // VariationPolicy.fromBrief refuses it at plan time. D7 keeps Save open for a
  // structurally valid brief, but the editor must still say the brief cannot run
  // — otherwise the only feedback is a failed run.
  if (state.variation.ratio.length > 0 && drawableCount === 0) {
    const packaged = [...motionPackagedRatios(state)];
    errors.ratio =
      packaged.length > 0
        ? messages.ratioNoneDrawablePackaged(packaged.map(ratioDisplayName))
        : messages.ratioNoneDrawableNone();
  }
  const count = Number.parseInt(state.variation.count, 10) || 0;
  if (floor > 0 && floor * drawableCount > count) {
    errors.perRatio = messages.perRatioExceeds(drawableCount, floor, count);
  }
  if (state.variation.layout.length === 0) errors.layout = messages.layout;
  if (state.variation.tone.length === 0) errors.tone = messages.tone;
  if (state.variation.background.length === 0) {
    errors.background = messages.background;
  }
  if (state.variation.paletteShift.length === 0) {
    errors.paletteShift = messages.paletteShift;
  }
  return errors;
}

/**
 * D7: a capability being off makes a motion brief *unrunnable* on this host, not
 * invalid — this string is a status message, never the sole reason Save is blocked.
 * It no longer quotes the probe's raw reason — Appendix A keeps that for a tooltip; this is the sentence a user reads.
 */
export function motionUnavailableReason(state: EditorState): string | undefined {
  if (state.capabilities?.motion !== false || !state.formats.includes("motion")) return undefined;
  return messages.formatsMotionUnavailable;
}

export function validateOutput(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.formats.length === 0) {
    errors.formats = messages.formats;
  }
  if (state.platforms.length === 0) {
    errors.platforms = messages.platforms;
  }
  // Client mirror of the API's validateFormatPlatformCompatibility: both directions
  // matter — a platform with nothing to package, and a format nothing can ship.
  const profiles = state.platforms
    .map((id) => PLATFORM_PROFILES[id])
    .filter((profile): profile is PlatformProfile => profile !== undefined);
  for (const profile of profiles) {
    if (!profile.formats.some((format) => state.formats.includes(format))) {
      // The API states the rejection; the editor has to say what to do about it.
      errors.platforms = messages.platformsIncompatible(platformDisplayName(profile.id), (profile.formats as string[]).map(formatDisplayName));
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
      errors.formats = messages.formatsUnsupported(formatDisplayName(format), candidates.map(platformDisplayName));
      break;
    }
  }
  const unavailable = motionUnavailableReason(state);
  if (unavailable) errors.formats = messages.formatsMotionUnavailable;
  // Motion is drawn by the variation planner only; the classic matrix renders stills.
  // This is structural, not a capability, so it blocks Save — the remedy is a mode
  // switch, and it outranks the capability message because it is the root cause.
  if (state.mode !== "variation" && state.formats.includes("motion")) {
    errors.formats = messages.formatsMotionNeedsRandomized;
  }
  return errors;
}

export function validateMotion(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (!state.formats.includes("motion")) return errors;
  if (state.motion.length === 0) {
    errors.motion = messages.motion;
  }
  if (state.duration.length === 0) {
    errors.duration = messages.duration;
  } else if (
    state.duration.some(
      (seconds) => !Number.isInteger(seconds) || seconds < MIN_DURATION_SEC || seconds > MAX_DURATION_SEC,
    )
  ) {
    errors.duration = messages.durationRange(MIN_DURATION_SEC, MAX_DURATION_SEC);
  } else if (new Set(state.duration).size !== state.duration.length) {
    // The planner de-duplicates this axis, so a repeat draws nothing — say so rather
    // than letting it look like an extra clip length.
    errors.duration = messages.durationDuplicate;
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
