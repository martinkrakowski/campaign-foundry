// SHIM: Standalone validate functions for WizardState compatibility.
// The /new wizard will be removed in E3; until then, this shim keeps it working.
import type { WizardState, WizardStepId } from "./wizard-state";
import {
  maxMinDistance as campaignMaxMinDistance,
  validatePolicy as campaignValidatePolicy,
} from "@/components/campaign/validate";
import { RATIO_OPTIONS, nextKeyAfter , initialEditorState } from "@/components/campaign/editor-state";
import type { EditorState } from "@/components/campaign/editor-state";
import * as messages from "@/components/campaign/messages";

const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

export type FieldErrors = Record<string, string>;

// Convert WizardState to EditorState for campaign validate functions
function toEditorState(state: WizardState): EditorState {
  // This is a simplified conversion - in reality, we'd need a proper conversion
  // For now, return a minimal EditorState
  return {
    ...initialEditorState(state.mode),
    source: { kind: "new", tempId: "temp" },
    mode: state.mode,
    briefId: state.briefId,
    targetRegion: state.targetRegion,
    targetAudience: state.targetAudience,
    campaignMessage: state.campaignMessage,
    localizedMessage: "",
    products: [],
    nextProductKey: nextKeyAfter(state.products as unknown as import("@/components/campaign/editor-state").ProductDraft[]),
    treatments: [],
    variation: {
      count: state.variation.count,
      seed: state.variation.seed,
      minDistance: state.variation.minDistance,
      perProduct: state.variation.perProduct,
      perRatio: state.variation.perRatio,
      layout: state.variation.layout,
      tone: state.variation.tone,
      // The wizard has no ratio controls (E3 removes it): every ratio stays on.
      ratio: [...RATIO_OPTIONS],
      background: state.variation.background,
      paletteShift: state.variation.paletteShift,
      headline: state.variation.headline,
    },
    motion: [],
    duration: [],
    formats: ["static"],
    platforms: state.platforms,
    outputExplicit: true,
    pool: state.pool,
    headlineAxisDropped: false,
    appliedSnapshot: null,
    capabilities: null,
  } as EditorState;
}

export function maxMinDistance(state: WizardState): number {
  return campaignMaxMinDistance(toEditorState(state));
}

export function validateType(state: WizardState): FieldErrors {
  const errors: FieldErrors = {};
  if (!SAFE_ID_PATTERN.test(state.briefId)) {
    errors.briefId = messages.briefId;
  }
  return errors;
}

export function validateProducts(state: WizardState): FieldErrors {
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
      errors[`product-${index}-id`] =
        messages.productId;
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

export function validateCopy(state: WizardState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.targetRegion.trim() === "") errors.targetRegion = messages.targetRegion;
  if (state.targetAudience.trim() === "") errors.targetAudience = messages.targetAudience;
  if (state.campaignMessage.trim() === "") errors.campaignMessage = messages.campaignMessage;
  return errors;
}

export function validatePolicy(state: WizardState): FieldErrors {
  // Delegate rather than reimplement: the wizard must keep validating seed, minDistance,
  // coverage and the axis lists exactly as the editor does until E3 removes this screen.
  return campaignValidatePolicy(toEditorState(state));
}

export function validateOutput(state: WizardState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.platforms.length === 0) {
    errors.platforms = messages.platforms;
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

