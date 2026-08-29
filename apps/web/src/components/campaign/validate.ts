import { MAX_DURATION_SEC, MIN_DURATION_SEC } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import type { EditorState } from "./editor-state";
import {
  LAYOUT_OPTIONS,
  TONE_OPTIONS,
  MAX_BEATS,
  MAX_WEIGHT,
  MIN_DWELL_SEC,
  drawableRatios,
  motionPackagedRatios,
  timelineDurations,
} from "./editor-state";

// The float slack on the dwell floor is IMPORTED, not restated: 3 × 1.2 is
// 3.5999999999999996, and an editor with its own copy of the tolerance would eventually
// disagree with `timelineProblem` about the boundary case. Same reasoning as the one
// DEFAULT_DURATION_SEC constant (L1).
import { DWELL_TOLERANCE } from "@campaignfoundry/CampaignOrchestration/copy-timeline";

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

export const MAX_HEADLINE_LENGTH = 60;

export function validateCopy(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.campaignMessage.trim() === "") {
    errors.campaignMessage = messages.campaignMessage;
  } else if (state.campaignMessage.length > MAX_HEADLINE_LENGTH) {
    errors.campaignMessage = messages.campaignMessageTooLong;
  }
  return { ...errors, ...validateTimeline(state) };
}

/**
 * Mirror `timelineProblem` (E5.5) — its conditions, in the editor's voice.
 *
 * Deliberately not a call to `timelineProblem` returning its string: the domain names
 * fields the way a brief file spells them (`copy.timeline.beats[0].weight`), which is right
 * for a YAML author and wrong on screen (D2, D18). The conditions are mirrored one for one
 * and a test asserts the two agree about WHICH drafts are invalid, so the wording can differ
 * without the judgement drifting.
 *
 * The reducer now refuses to create most of these; a draft restored from storage can still
 * hold them, which is why they are checked rather than assumed away — a draft is
 * persistable and flagged, not repaired behind the author's back (D7/D11).
 */
export function validateTimeline(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  const beats = state.timeline.beats;
  if (beats.length === 0) return errors;

  if (beats.length > MAX_BEATS) {
    errors["copy-timeline"] = messages.timelineTooManyBeats(MAX_BEATS);
    return errors;
  }
  beats.forEach((beat, index) => {
    if (!Number.isInteger(beat.weight) || beat.weight < 1 || beat.weight > MAX_WEIGHT) {
      errors[`copy-timeline-beat-${index}`] = messages.timelineBeatWeightOutOfRange(index + 1, MAX_WEIGHT);
    }
  });
  if (Object.keys(errors).length > 0) return errors;

  const keyBeat = state.timeline.keyBeat;
  if (!Number.isInteger(keyBeat) || keyBeat < 1 || keyBeat > beats.length) {
    errors["copy-timeline"] = messages.timelineKeyBeatMissing;
    return errors;
  }

  // The floor is measured against the SHORTEST clip, exactly as the domain measures it.
  const durations = timelineDurations(state);
  const shortest = Math.min(...durations);
  const total = beats.reduce((sum, beat) => sum + beat.weight, 0);
  beats.forEach((beat, index) => {
    const dwellSec = (shortest * beat.weight) / total;
    if (dwellSec < MIN_DWELL_SEC - DWELL_TOLERANCE) {
      errors[`copy-timeline-beat-${index}`] = messages.timelineBeatUnderFloor(
        index + 1,
        dwellSec,
        MIN_DWELL_SEC,
        shortest,
      );
    }
  });
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
  // Per-card gating is the single, non-red home for the "motion not available / needs
  // randomized mode" notices (D7: gates are never red). They are surfaced on the
  // FormatPanel gate, and the Save/apply refusal path uses `motionUnavailableReason`
  // directly as a status line — so emitting them here too would double-report them.
  // `motionUnavailableReason` remains a public helper for that refusal path.
  return errors;
}

export function validateMotion(state: EditorState): FieldErrors {
  const errors: FieldErrors = {};
  if (!state.formats.includes("motion")) return errors;
  // The FormatPanel gate stops Video being *selected* in Classic, but a brief can arrive
  // here holding it anyway: pick Video in Randomized, switch to Classic, and the format
  // stays. Nothing else catches that — the generate path branches on mode alone, so the
  // brief saves and applies cleanly and then renders stills, silently producing something
  // other than what it asks for. A refusal the user can read is the whole point (D3).
  if (state.mode !== "variation") {
    errors.formats = messages.formatsMotionNeedsRandomizedMode;
    return errors;
  }
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
