import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import {
  PLATFORM_PROFILES,
  formatsFor,
} from "@campaignfoundry/Distribution/platform-profiles";
import type { EditorState } from "./editor-state";
import { axisProductSize } from "./editor-state";

/**
 * Derives default formats from a list of platform IDs.
 * Preserves canonical order ("static", "motion").
 */
export function platformsToFormats(platforms: readonly string[]): string[] {
  const formats = formatsFor(platforms);
  return formats.length > 0 ? [...formats] : ["static"];
}

/**
 * Derives canvas ratios from a list of platform IDs.
 * Preserves canonical RATIO_VALUES order ("1:1", "9:16", "16:9").
 */
export function platformsToRatios(platforms: readonly string[]): string[] {
  const ratios = new Set<string>();
  for (const id of platforms) {
    const profile = PLATFORM_PROFILES[id];
    if (profile) {
      ratios.add(profile.ratio);
    }
  }
  return RATIO_VALUES.filter((r) => ratios.has(r));
}

/**
 * Pure helper to clamp policy count against the axis product size ceiling.
 */
export function clampPolicy(state: EditorState): EditorState {
  const axisMax = axisProductSize(state);
  const count = Number.parseInt(state.variation.count, 10) || 0;
  if (count > axisMax) {
    return {
      ...state,
      variation: { ...state.variation, count: String(axisMax) },
      countNotice: axisMax,
    };
  }
  return state.countNotice === null ? state : { ...state, countNotice: null };
}

/**
 * How many creatives a classic brief yields: products × every aspect ratio ×
 * treatments. Classic draws one set per ratio (W1: it never narrows to the selected
 * platforms), so every ratio in the canonical set counts. `treatments` is optional on
 * a stored brief, so the absent-or-empty distinction is the caller's: pass the length
 * when the key exists, `undefined` when a brief simply has no treatments block.
 *
 * This is the estimate's local truth for a classic draft (D31): the planner refuses
 * classic briefs, so the editor derives the deliverables count instead of asking.
 */
export function classicAdCount(products: number, treatments: number | undefined): number {
  // A brief with no treatments still renders one creative per cell: the use case
  // substitutes DEFAULT_TREATMENT when the list is absent *or* empty
  // (GenerateCampaignUseCase.use-case.ts:163). `?? 1` only catches undefined, so an
  // empty array would otherwise multiply the whole estimate to zero.
  return products * RATIO_VALUES.length * Math.max(1, treatments ?? 1);
}
