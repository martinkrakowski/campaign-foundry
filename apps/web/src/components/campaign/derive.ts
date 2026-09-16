import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import {
  DISPLAY_SIZE_VALUES,
  type DisplaySize,
} from "@campaignfoundry/CampaignOrchestration/display-sizes";
import {
  PLATFORM_PROFILES,
  formatsFor,
  type PlatformProfile,
} from "@campaignfoundry/Distribution/platform-profiles";
import {
  assembleHtml,
  isBrandColor,
} from "@campaignfoundry/CampaignOrchestration/markup-assembler";
import {
  CREATIVE_TYPE_RULES,
  type CreativeType,
  type OcclusionFinding,
} from "@campaignfoundry/CampaignOrchestration/creative-types";
// The domain's own delta, imported for the enabled-subset wrapper below and
// re-exported unchanged at the foot of this file.
import { findOcclusionDelta } from "@campaignfoundry/CampaignOrchestration/creative-types";
import type { CreativeTemplateLayer } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import type { Style } from "@campaignfoundry/CampaignOrchestration/creative-style";
import type { HtmlElement } from "@campaignfoundry/CampaignOrchestration/html-element";
import { satisfiesOrderConstraints } from "@campaignfoundry/CampaignOrchestration/brief-template";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
// Type-only, like `editor-state.ts`'s own `Treatment` import: erased at compile
// time, so it carries none of the root barrel's runtime (node builtin) weight
// into the bundle — only `./creative-style`-style leaf imports may do that.
import type { Treatment } from "@campaignfoundry/CampaignOrchestration";
import type { EditorState } from "./editor-state";

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
  return (
    products * (RATIO_VALUES.length + sizes) * Math.max(1, treatments ?? 1)
  );
}

/** Kind → layer count for a template's layer list — the arithmetic both
 * cardinality derivations and the boundary agree on (D124). */
function countKinds(
  layers: readonly { readonly kind: LayerKind }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const layer of layers) {
    counts.set(layer.kind, (counts.get(layer.kind) ?? 0) + 1);
  }
  return counts;
}

/** Kind → enabled layer count for a template's layer list (D129, MP-D4).
 * Absent `enabled` means enabled (`enabled !== false`). */
function countEnabledKinds(
  layers: readonly { readonly kind: LayerKind; readonly enabled?: boolean }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const layer of layers) {
    counts.set(
      layer.kind,
      (counts.get(layer.kind) ?? 0) + (layer.enabled !== false ? 1 : 0),
    );
  }
  return counts;
}

/**
 * Finds the highest legal index (from `layers.length` down to 0) where a new layer
 * of `kind` can be inserted into `layers` while satisfying all ordering constraints
 * for `creativeType` (D128).
 *
 * Array position is z-order, bottom first (D128):
 * - Topmost (`layers.length`) is preferred so new layers are topmost whenever legal.
 * - If topmost violates an order constraint (e.g. adding `shade` when `logo` is on top),
 *   the highest index that satisfies constraints is derived deterministically.
 * - Returns `undefined` if no legal insertion position exists.
 */
export function findLegalInsertionIndex(
  creativeType: CreativeType,
  layers: readonly { readonly kind: LayerKind }[],
  kind: LayerKind,
): number | undefined {
  for (let i = layers.length; i >= 0; i--) {
    const candidate = [...layers.slice(0, i), { kind }, ...layers.slice(i)];
    if (satisfiesOrderConstraints(creativeType, candidate)) {
      return i;
    }
  }
  return undefined;
}

/**
 * What the editor may still add to the pinned template (D124, D128), derived from the
 * domain's compatibility table — the same `CREATIVE_TYPE_RULES` the boundary
 * validates against, so the two cannot drift (D121). A kind is addable while one
 * more layer of it would still parse: under its own `maxOf` cap (absent means
 * unbounded), under every shared budget it belongs to (image-text's
 * `static-text`/`animated-text` draw one headline block, so either alone fills
 * the budget of one — the other must not be offered), and where a legal order
 * placement exists. Canonical `accepts` order, so the UI lists the table's order.
 */
export function addableKinds(state: EditorState): readonly LayerKind[] {
  const rules = CREATIVE_TYPE_RULES[state.template.creativeType];
  const counts = countKinds(state.template.layers);
  return rules.accepts.filter((kind) => {
    if ((counts.get(kind) ?? 0) >= (rules.maxOf[kind] ?? Infinity))
      return false;
    for (const budget of rules.sharedBudgets) {
      if (!budget.kinds.includes(kind)) continue;
      const used = budget.kinds.reduce(
        (sum, budgeted) => sum + (counts.get(budgeted) ?? 0),
        0,
      );
      if (used >= budget.max) return false;
    }
    if (
      findLegalInsertionIndex(
        state.template.creativeType,
        state.template.layers,
        kind,
      ) === undefined
    ) {
      return false;
    }
    return true;
  });
}

/**
 * The one rule a remove and a switch-off share (D129, MP-D4): taking this layer
 * out of the enabled set must leave at least one enabled instance of every kind
 * the creative type requires. A layer that is already off contributes nothing to
 * the enabled count either way — which is why removing it changes no count (and
 * so stays allowed) while switching it off is not an offer at all.
 */
function leavesARequiredKind(
  rules: (typeof CREATIVE_TYPE_RULES)[CreativeType],
  layer: CreativeTemplateLayer,
  enabledCounts: Map<string, number>,
): boolean {
  if (!rules.required.includes(layer.kind)) return true;
  // `as number`: `enabledCounts` is built from this same list, so every layer's kind
  // is present — the lookup cannot miss.
  const enabled = enabledCounts.get(layer.kind) as number;
  const remaining = layer.enabled !== false ? enabled - 1 : enabled;
  return remaining >= 1;
}

/**
 * Which layers of the pinned template the editor may remove (D124), derived from
 * the same table: a layer is removable when its kind is not required — or when
 * removing it would still leave at least one enabled instance of that kind (D129,
 * MP-D4), so removing one cannot strip the template of a required kind the boundary
 * refuses to parse without. Template order (array position is z-order, D128), so the
 * UI can walk the list it renders.
 */
export function removableLayerIds(state: EditorState): readonly string[] {
  const rules = CREATIVE_TYPE_RULES[state.template.creativeType];
  const enabledCounts = countEnabledKinds(state.template.layers);
  return state.template.layers
    .filter((layer) => leavesARequiredKind(rules, layer, enabledCounts))
    .map((layer) => layer.id);
}

/**
 * Which layers the editor may switch OFF (D129, MP-D4) — the same rule
 * `removableLayerIds` applies to a remove, through the same helper, so the two
 * cannot drift: the last enabled instance of a required kind is not offered, and
 * a layer that is already off has nothing to switch off.
 */
export function disableableLayerIds(state: EditorState): readonly string[] {
  const rules = CREATIVE_TYPE_RULES[state.template.creativeType];
  const enabledCounts = countEnabledKinds(state.template.layers);
  return state.template.layers
    .filter(
      (layer) =>
        layer.enabled !== false &&
        leavesARequiredKind(rules, layer, enabledCounts),
    )
    .map((layer) => layer.id);
}

/**
 * Which layers carry a toggle at all (D129): every layer that may be switched
 * off, plus every disabled layer — switching one back on can only add to the
 * enabled set, so it is never refused. Template order, so the UI can walk the
 * list it renders.
 */
export function toggleableLayerIds(state: EditorState): readonly string[] {
  const disableable = disableableLayerIds(state);
  return state.template.layers
    .filter(
      (layer) => layer.enabled === false || disableable.includes(layer.id),
    )
    .map((layer) => layer.id);
}

/**
 * The occlusion delta over the layers that draw (MP-D3): a disabled layer
 * occludes nothing, so it is dropped from both sides before the domain's own
 * delta runs. Order constraints still see the whole array — a disabled layer
 * keeps its slot — and the finding the domain returns names kinds only, so
 * nothing downstream can tell which side was filtered.
 */
export function findOcclusionDeltaOverEnabled(
  before: readonly CreativeTemplateLayer[],
  after: readonly CreativeTemplateLayer[],
): OcclusionFinding | null {
  const draws = (layers: readonly CreativeTemplateLayer[]) =>
    layers.filter((layer) => layer.enabled !== false);
  return findOcclusionDelta(draws(before), draws(after));
}

export type MoveDirection = "up" | "down";

/**
 * Which directions a layer at `index` may move within the pinned template's
 * layer list (D128), derived from the domain's compatibility table
 * (`CREATIVE_TYPE_RULES`).
 *
 * Array position is z-order, bottom first (D128):
 * - Index 0 is the bottom-most layer (offers no "down" toward the bottom).
 * - Index layers.length - 1 is the topmost layer (offers no "up" past the top).
 * - "up" moves toward the top of the stack (from index i to i + 1).
 * - "down" moves toward the bottom of the stack (from index i to i - 1).
 *
 * A layer that cannot legally move in a direction has no control for that
 * direction (D128, DESIGN.md §1.5) — bounds and compatibility constraints
 * (e.g. "logo above image", "shade directly above image") are enforced here so
 * the UI never offers what the boundary refuses.
 */
export function layerMoveDirections(
  state: EditorState,
  index: number,
): readonly MoveDirection[] {
  const layers = state.template.layers;
  if (index < 0 || index >= layers.length) return [];

  const directions: MoveDirection[] = [];

  // Down: toward bottom (index - 1)
  if (index > 0) {
    const candidate = [...layers];
    const [moved] = candidate.splice(index, 1);
    candidate.splice(index - 1, 0, moved);
    if (satisfiesOrderConstraints(state.template.creativeType, candidate)) {
      directions.push("down");
    }
  }

  // Up: toward top (index + 1)
  if (index < layers.length - 1) {
    const candidate = [...layers];
    const [moved] = candidate.splice(index, 1);
    candidate.splice(index + 1, 0, moved);
    if (satisfiesOrderConstraints(state.template.creativeType, candidate)) {
      directions.push("up");
    }
  }

  return directions;
}

/**
 * True when the layer at `index` can legally move in `direction`.
 */
export function canMoveLayer(
  state: EditorState,
  index: number,
  direction: MoveDirection,
): boolean {
  return layerMoveDirections(state, index).includes(direction);
}

/**
 * The weight reading the meter shows (HL5c, HL-D6): the draft's assembled
 * markup measured against one placement's budget.
 */
export interface HtmlWeightReading {
  /** Assembled `index.html` bytes — the largest across the selected html sizes. */
  readonly bytes: number;
  /** The budgeting profile's `maxBytes`, read from the same table packaging enforces against. */
  readonly maxBytes: number;
  /** The budgeting profile's display label, so the meter names which placement it speaks for. */
  readonly profileLabel: string;
  /** Bytes over the budget; zero when the measured markup fits. */
  readonly overBy: number;
}

/**
 * The html placement budget for a platform selection (HL-D6): the **smallest**
 * `maxBytes` among the selected platforms whose `formats` include `html` —
 * the tightest placement is the one that refuses first, so it is the number
 * the builder must see. Returns the profile itself (label included), or
 * `undefined` when no selected platform ships html. Never a second constant:
 * packaging's `packageHtml` enforces exactly this table.
 *
 * `profiles` is injectable for tests (a two-profile selection with distinct
 * budgets needs table entries the production profiles do not carry — the real
 * html profiles share one figure); every call site passes only the platforms
 * and reads the shipped table.
 */
export function htmlByteBudget(
  platforms: readonly string[],
  profiles: Readonly<Record<string, PlatformProfile>> = PLATFORM_PROFILES,
): PlatformProfile | undefined {
  let tightest: PlatformProfile | undefined;
  for (const id of platforms) {
    const profile = profiles[id];
    if (profile === undefined || !profile.formats.includes("html")) continue;
    if (tightest === undefined || profile.maxBytes < tightest.maxBytes) {
      tightest = profile;
    }
  }
  return tightest;
}

/**
 * The single-entry memo behind `htmlWeightReading` (HL5c). One entry, not a map:
 * the meter and the warning read the same draft in the same tick, so the value
 * the first caller assembles is exactly the value the second wants — and a
 * keystroke invalidates it wholesale. A wider cache would hold superseded
 * readings for nothing.
 */
let weightReadingCache:
  | { readonly key: string; readonly reading: HtmlWeightReading }
  | undefined;

/**
 * A stable serialisation of exactly the inputs the reading is a function of —
 * the gathered html elements, the ship sizes, the brand colour, the style, the
 * click destination, and the budget (label and figure ride the reading) — so an
 * unchanged draft reweighs nothing and any change to a weighed input reweighs.
 * The platforms and profiles the budget was drawn from need no separate slot: a
 * change to either is a change to the budget's label or `maxBytes` here, and to
 * the assembled `bytes` through `sizes`/`elements`.
 */
function htmlWeightKey(
  sizes: readonly string[],
  elements: readonly HtmlElement[],
  brandColor: string,
  style: Style,
  destination: string,
  budget: PlatformProfile,
  // HL5f: the reading now depends on tone (the assembler's default weight),
  // so a change to the SET of tones the draft will generate must invalidate
  // the single-entry cache below too. Sorted so a re-derivation of the same
  // set in a different order (e.g. a treatment reorder) is still a cache hit.
  tones: readonly (Treatment["tone"] | undefined)[],
): string {
  return JSON.stringify({
    brandColor,
    destination,
    style,
    sizes,
    tones: [...tones].sort(),
    maxBytes: budget.maxBytes,
    profileLabel: budget.label,
    elements: elements.map((el) => [
      el.kind,
      el.text ?? "",
      // HL5e fix round: the element's style reaches the assembled bytes
      // through `htmlElementFont`, so it weighs here too. Flattened to the
      // two fields in `ELEMENT_STYLE_FIELDS` declaration order (stable): the
      // assembler resolves an absent block, an empty `{}`, and a block of
      // undefined fields IDENTICALLY (`style?.fontWeight !== undefined` /
      // `??` in `htmlElementFont` — `elementStyleProblem` deliberately admits
      // `{}` for exactly that reason), so all three key the same string and
      // the no-op edit costs no reweigh. Serialising the block whole would
      // have keyed `{}` apart from absent — a stricter vocabulary than the
      // domain's own.
      el.style?.fontWeight ?? "",
      el.style?.fontFamily ?? "",
      el.frame,
    ]),
  });
}

/**
 * Every distinct tone the draft will actually write an html bundle for
 * (Qodo finding, HL5f fix round): generation writes one html unit per
 * generated variant, and each variant carries its OWN tone —
 * `GenerateCampaignUseCase` passes `treatment.tone` per treatment in brief
 * mode and `variant.tone` per variant in variation mode. Reading only the
 * first treatment's tone (the pre-fix reading) missed every OTHER
 * treatment's bundle — now that weight follows tone (`toneFontWeight`), a
 * later bold treatment can outweigh an earlier subtle one and the meter
 * would silently under-report the real over-budget unit.
 *
 * Brief mode: `state.treatments[].tone` — a raw editor string, validated
 * only at save (`toTreatment`), so anything other than "subtle" collapses to
 * bold exactly as the compositor's own tone check does. Variation mode:
 * `state.variation.tone`, the tone AXIS — every value selected there is a
 * tone some generated variant will carry (the axis is not narrowed further
 * here; sampling which combinations actually render is the generator's
 * job, and every axis value remains reachable). No treatments drafted, or
 * an empty tone axis, → `[undefined]`, so a draft with nothing tone-specific
 * to say gets exactly the assembler's own "bold" default — the one-tone
 * reading this replaces.
 */
function draftTones(state: EditorState): readonly (Treatment["tone"] | undefined)[] {
  const raw =
    state.mode === "variation"
      ? state.variation.tone
      : state.treatments.map((treatment) => treatment.tone);
  const distinct = [...new Set(raw)] as readonly Treatment["tone"][];
  return distinct.length > 0 ? distinct : [undefined];
}

/**
 * The draft's html unit, weighed (HL5c, HL-D6): the enabled `html` layers'
 * elements — gathered exactly as the generation path gathers them — assembled
 * through the same `assembleHtml` HL4 ships, against the placement budget.
 * Pure: the assembler is a string builder, so no network and no DOM (HL-D7 —
 * the markup exists only to count its bytes; nothing here returns it).
 *
 * The figure is the **largest** assembly across the sizes the selection will
 * render html at: each size is packaged as its own unit against the same
 * budget, and the markup embeds canvas-derived numbers, so a bigger canvas can
 * cost more bytes. A meter that read one size and passed while another failed
 * would be two budgets disagreeing — the defect HL-D6 exists to remove.
 *
 * The reading deliberately assembles WITHOUT the profile: `assembleHtml`
 * refuses over-budget markup, and the meter must show the overage, not throw
 * it away. Over budget is a warning (`overBy`), because the raster fallback
 * joins the same budget at packaging and only packaging's count of the
 * finished unit enforces it — the editor's figure is a lower bound.
 *
 * `undefined` when there is nothing to weigh: no html placement, no selected
 * size that placement carries, or a brand colour the assembler's documented hex
 * shape refuses (the Products section raises that as its own error; there is no
 * markup to measure until it is a hex colour). The colour is checked against the
 * assembler's own `isBrandColor` before it is ever asked to build, so the one
 * failure this derivation expects never becomes a thrown error — any *other*
 * error the assembler raises is a real defect and is allowed to propagate rather
 * than being swallowed into a missing meter.
 *
 * The reading is memoised through a module-level single-entry cache keyed by the
 * inputs it reads (below), so the two consumers that share this seam — the meter
 * in `TemplateSection` and the overage in `validateTemplateWarnings` — assemble
 * the unit once per change rather than once per keystroke each.
 */
export function htmlWeightReading(
  state: EditorState,
  profiles: Readonly<Record<string, PlatformProfile>> = PLATFORM_PROFILES,
): HtmlWeightReading | undefined {
  const budget = htmlByteBudget(state.platforms, profiles);
  if (budget === undefined) return undefined;
  const shipSizes = new Set(
    (budget.sizes ?? []).map((slot) => slot.size as string),
  );
  const sizes = state.sizes.filter((size) => shipSizes.has(size));
  if (sizes.length === 0) return undefined;
  // The same gather GenerateCampaignUseCase runs for its html rows (HL4).
  const elements = state.template.layers
    .filter((layer) => layer.kind === "html" && layer.enabled !== false)
    .flatMap((layer) => layer.elements ?? []);
  const destination = state.clickDestination.trim();
  const brandColor = state.products[0]?.primaryColor ?? "";
  // The expected failure, checked up front so the assembler is never asked to
  // throw it: a missing product (`?? ""`) or a colour outside the hex shape has
  // no weighable markup, and the Products section already says so.
  if (!isBrandColor(brandColor)) return undefined;
  const tones = draftTones(state);

  const key = htmlWeightKey(
    sizes,
    elements,
    brandColor,
    state.style,
    destination,
    budget,
    tones,
  );
  const cached = weightReadingCache;
  if (cached !== undefined && cached.key === key) return cached.reading;
  let bytes = 0;
  for (const size of sizes) {
    for (const tone of tones) {
      const assembled = assembleHtml({
        elements,
        canvas: { size },
        brandColor,
        style: state.style,
        tone,
        clickDestination: destination === "" ? undefined : destination,
      });
      bytes = Math.max(bytes, assembled.byteLength);
    }
  }
  const reading: HtmlWeightReading = {
    bytes,
    maxBytes: budget.maxBytes,
    profileLabel: budget.label,
    overBy: Math.max(0, bytes - budget.maxBytes),
  };
  weightReadingCache = { key, reading };
  return reading;
}

// Re-export occlusion table and checks (D135, D136)
export {
  OCCLUSION_TABLE,
  checkPairOcclusion,
  checkRepositionOcclusion,
  findOcclusionDelta,
  type OcclusionBehavior,
  type OcclusionFinding,
  type OcclusionRule,
} from "@campaignfoundry/CampaignOrchestration/creative-types";
