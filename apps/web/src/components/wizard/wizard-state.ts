// SHIM: Re-exports from components/campaign/wizard-compat for backward compatibility.
// The /new wizard will be removed in E3; until then, this shim keeps it working.
export {
  WIZARD_STEPS,
  CLASSIC_STEPS,
  VARIATION_STEPS,
  type WizardStepId,
  LAYOUT_OPTIONS,
  TONE_OPTIONS,
  BACKGROUND_OPTIONS,
  PALETTE_SHIFT_OPTIONS,
  HEADLINE_POOL_REF,
  STATIC_PLATFORMS,
  type CampaignMode,
  type ProductDraft,
  type WizardState,
  type WizardAction,
  initialWizardState,
  stepsFor,
  wizardReducer,
  approvedHeadlines,
  toBrief,
  PLAN_DEBOUNCE_MS,
  canPlan,
} from "@/components/campaign/wizard-compat";

export { slugify, assetFileName, fileToBase64, emptyProduct } from "@/components/campaign/editor-state";
