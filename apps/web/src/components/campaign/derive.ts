import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import {
  DISPLAY_SIZE_VALUES,
  type DisplaySize,
} from "@campaignfoundry/CampaignOrchestration/display-sizes";
import {
  PLATFORM_PROFILES,
  formatsFor,
} from "@campaignfoundry/Distribution/platform-profiles";
import { CREATIVE_TYPE_RULES } from "@campaignfoundry/CampaignOrchestration/creative-types";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
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
 * A display profile contributes no ratio (D116) — only its sizes.
 */
export function platformsToRatios(platforms: readonly string[]): string[] {
  const ratios = new Set<string>();
  for (const id of platforms) {
    const profile = PLATFORM_PROFILES[id];
    if (profile?.ratio !== undefined) {
      ratios.add(profile.ratio);
    }
  }
  return RATIO_VALUES.filter((r) => ratios.has(r));
}

/**
 * Derives display sizes from a list of platform IDs.
 * Preserves canonical DISPLAY_SIZE_VALUES order; a social profile contributes none.
 */
export function platformsToSizes(platforms: readonly string[]): DisplaySize[] {
  const sizes = new Set<DisplaySize>();
  for (const id of platforms) {
    const profile = PLATFORM_PROFILES[id];
    if (profile?.sizes === undefined) continue;
    for (const slot of profile.sizes) {
      sizes.add(slot.size);
    }
  }
  return DISPLAY_SIZE_VALUES.filter((size) => sizes.has(size));
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
 * How many creatives a classic brief yields: products × every canvas ×
 * treatments. Classic draws one set per canvas (W1: it never narrows to the selected
 * platforms), so every ratio in the canonical set counts — plus each requested
 * display size (`output.sizes`, D113). `treatments` is optional on
 * a stored brief, so the absent-or-empty distinction is the caller's: pass the length
 * when the key exists, `undefined` when a brief simply has no treatments block.
 *
 * This is the estimate's local truth for a classic draft (D31): the planner refuses
 * classic briefs, so the editor derives the deliverables count instead of asking.
 */
export function classicAdCount(
  products: number,
  treatments: number | undefined,
  sizes = 0,
): number {
  // A brief with no treatments still renders one creative per cell: the use case
  // substitutes DEFAULT_TREATMENT when the list is absent *or* empty
  // (GenerateCampaignUseCase.use-case.ts:163). `?? 1` only catches undefined, so an
  // empty array would otherwise multiply the whole estimate to zero.
  return products * (RATIO_VALUES.length + sizes) * Math.max(1, treatments ?? 1);
}

/** Kind → layer count for a template's layer list — the arithmetic both
 * cardinality derivations and the boundary agree on (D124). */
function countKinds(layers: readonly { readonly kind: LayerKind }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const layer of layers) {
    counts.set(layer.kind, (counts.get(layer.kind) ?? 0) + 1);
  }
  return counts;
}

/**
 * What the editor may still add to the pinned template (D124), derived from the
 * domain's compatibility table — the same `CREATIVE_TYPE_RULES` the boundary
 * validates against, so the two cannot drift (D121). A kind is addable while one
 * more layer of it would still parse: under its own `maxOf` cap (absent means
 * unbounded) and under every shared budget it belongs to (image-text's
 * `static-text`/`animated-text` draw one headline block, so either alone fills
 * the budget of one — the other must not be offered). Canonical `accepts` order,
 * so the UI lists the table's order.
 */
export function addableKinds(state: EditorState): readonly LayerKind[] {
  const rules = CREATIVE_TYPE_RULES[state.template.creativeType];
  const counts = countKinds(state.template.layers);
  return rules.accepts.filter((kind) => {
    if ((counts.get(kind) ?? 0) >= (rules.maxOf?.[kind] ?? Infinity)) return false;
    for (const budget of rules.sharedBudgets ?? []) {
      if (!budget.kinds.includes(kind)) continue;
      const used = budget.kinds.reduce((sum, budgeted) => sum + (counts.get(budgeted) ?? 0), 0);
      if (used >= budget.max) return false;
    }
    return true;
  });
}

/**
 * Which layers of the pinned template the editor may remove (D124), derived from
 * the same table: a layer is removable when its kind is not required — or when
 * the kind is required but still present more than once, so removing one cannot
 * strip the template of a kind the boundary refuses to parse without. Template
 * order (array position is z-order, D128), so the UI can walk the list it renders.
 */
export function removableLayerIds(state: EditorState): readonly string[] {
  const rules = CREATIVE_TYPE_RULES[state.template.creativeType];
  const counts = countKinds(state.template.layers);
  return state.template.layers
    // `as number`: `counts` is built from this same list, so every layer's kind
    // is present — the lookup cannot miss.
    .filter((layer) => !rules.required.includes(layer.kind) || (counts.get(layer.kind) as number) > 1)
    .map((layer) => layer.id);
}
