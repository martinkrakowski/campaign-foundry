import type { WizardState, WizardStepId } from "./wizard-state";

// Mirrors CampaignOrchestration SAFE_ID_PATTERN (see BriefPicker / brief page).
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

export type FieldErrors = Record<string, string>;

const UINT32_MAX = 0xffffffff;
/**
 * Hamming axes that are always active (productId, aspectRatio, layout, tone,
 * backgroundSource, paletteShift). Optional axes add one each when on — mirrors
 * VariationPolicy's active-axis count in CampaignOrchestration.
 */
const BASE_DISTANCE_AXES = 6;

/** Upper bound for `minDistance`: the number of Hamming axes this brief activates. */
export function maxMinDistance(state: WizardState): number {
  return BASE_DISTANCE_AXES + (state.variation.headline ? 1 : 0);
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

export function validateType(state: WizardState): FieldErrors {
  const errors: FieldErrors = {};
  if (!SAFE_ID_PATTERN.test(state.briefId)) {
    errors.briefId = "Lowercase letters, digits and hyphens only (max 64) — used as the reload key.";
  }
  return errors;
}

export function validateProducts(state: WizardState): FieldErrors {
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

export function validateCopy(state: WizardState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.targetRegion.trim() === "") errors.targetRegion = "Target region is required.";
  if (state.targetAudience.trim() === "") errors.targetAudience = "Target audience is required.";
  if (state.campaignMessage.trim() === "") errors.campaignMessage = "Campaign message is required.";
  return errors;
}

export function validatePolicy(state: WizardState): FieldErrors {
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

export function validateOutput(state: WizardState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.platforms.length === 0) {
    errors.platforms = "Select at least one platform.";
  }
  return errors;
}

export function validateStep(step: WizardStepId, state: WizardState): FieldErrors {
  switch (step) {
    case "type":
      return validateType(state);
    case "products":
      return validateProducts(state);
    case "copy":
      return validateCopy(state);
    case "policy":
      return validatePolicy(state);
    case "output":
      return validateOutput(state);
    case "review":
      return {};
  }
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
