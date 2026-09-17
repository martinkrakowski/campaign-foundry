import type {
  CampaignBrief,
  CopyPool,
  Product,
  Treatment,
  VariationPolicy,
} from "@campaignfoundry/CampaignOrchestration";
// The leaf, never the barrel: the type vocabulary must reach the browser bundle
// without the barrel's node:fs hitchhikers (see the comment below).
import {
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_PRESETS,
  DEFAULT_CAMPAIGN_TYPE,
  type CampaignType,
} from "@campaignfoundry/CampaignOrchestration/campaign-types";
import {
  isBriefTemplate,
  templateFromCanonical,
  type BriefTemplate,
} from "@campaignfoundry/CampaignOrchestration/brief-template";
// The html layer's element vocabulary (HL1): the kinds an element may be, the
// frame it positions itself with, and the leaf's own values — never restated
// here, for the same reason every other domain value above is imported.
import {
  HTML_ELEMENT_KINDS,
  type Frame,
  type HtmlElement,
  type HtmlElementKind,
  type HtmlElementStyle,
} from "@campaignfoundry/CampaignOrchestration/html-element";
// The layer's shape, from the same module the canonical templates are declared
// in: the toggle writes the field, so it writes that module's type.
import type { CreativeTemplateLayer } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import {
  BRIEF_SCHEMA_VERSION,
  isSupportedBriefSchemaVersion,
} from "@campaignfoundry/CampaignOrchestration/brief-schema-version";
// The leaf, never the barrel: the barrel re-exports the infrastructure adapters, which
// pull node:fs/path/crypto into the browser bundle.
import {
  DEFAULT_BACKGROUND_SOURCES,
  DEFAULT_DURATION,
  DEFAULT_DURATION_SEC,
  HEADLINE_POOL_REF,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  ANCHOR_VALUES,
} from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import { MOTION_KINDS } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import {
  dwellProblem,
  MAX_BEATS,
  MAX_SCENES,
  MAX_WEIGHT,
  MIN_DWELL_SEC,
  type CopyTimeline,
} from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import {
  ALIGN_VALUES,
  FONT_FAMILY_VALUES,
  FONT_WEIGHT_VALUES,
  MAX_LETTER_SPACING,
  MAX_LINE_HEIGHT,
  MAX_SIZE_SCALE,
  MIN_LETTER_SPACING,
  MIN_LINE_HEIGHT,
  MIN_SIZE_SCALE,
  styleDiverges,
  styleProblem,
  TEXT_EFFECT_VALUES,
  type FontFamilyKind,
  type FontWeightKind,
  type Style,
} from "@campaignfoundry/CampaignOrchestration/creative-style";

// Re-exported, not restated: every one of these is the domain's own value, and the
// editor's copies of them were exactly the drift the leaf exists to prevent (D18).
export {
  DEFAULT_DURATION_SEC,
  HEADLINE_POOL_REF,
  HTML_ELEMENT_KINDS,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  MOTION_KINDS,
  MAX_BEATS,
  MAX_SCENES,
  MAX_WEIGHT,
  MIN_DWELL_SEC,
};
export type { Frame, HtmlElement, HtmlElementKind, HtmlElementStyle };
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import {
  DISPLAY_SIZE_VALUES,
  type DisplaySize,
} from "@campaignfoundry/CampaignOrchestration/display-sizes";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
// The domain's own audio-rights contract (VE-D8 fix3): the editor's retention
// rule for a stored or loaded `audio` block reuses this rather than a second
// copy of the rules parseBrief already enforces.
import { isAudio } from "@campaignfoundry/CampaignOrchestration/audio-rights";
import {
  PLATFORM_PROFILES,
  isRatioProfile,
  type PlatformProfile,
} from "@campaignfoundry/Distribution/platform-profiles";
import {
  addableKinds,
  disableableLayerIds,
  findLegalInsertionIndex,
  findOcclusionDeltaOverEnabled,
  platformsToFormats,
  platformsToRatios,
  platformsToSizes,
  removableLayerIds,
  type OcclusionFinding,
} from "./derive";
import { layerKindDisplayName } from "./display-names";
import * as messages from "./messages";

export const LAYOUT_OPTIONS = ["headline-top", "headline-bottom"] as const;
export const TONE_OPTIONS = ["bold", "subtle"] as const;
/** The anchor axis' vocabulary (T4) — the domain's ANCHOR_VALUES, in its order. */
export const ANCHOR_OPTIONS: readonly string[] = ANCHOR_VALUES;
/**
 * What the ABSENT anchor axis already produces: the compositor derives the
 * placement from `layout` (`headline-top` → `top`, else `bottom`), so the
 * pre-axis behaviour spans exactly top and bottom. A selection equal to this
 * says nothing the absent key does not, so `toBrief` omits the key and the
 * brief's `policyHash` stays byte-identical (D57) — the same convention the
 * `ratio` axis follows in the same `axes` object. Selecting Middle (or any
 * other divergence) is what makes the axis real.
 */
export const DERIVED_ANCHOR_OPTIONS: readonly string[] = ["top", "bottom"];
export const BACKGROUND_OPTIONS = ["procedural", "asset-pool", "genai"] as const;
export const PALETTE_SHIFT_OPTIONS = [0, 0.1, 0.2] as const;
/** The two campaign modes in panel order (D4) — `brief` (Classic) first. */
export const MODE_OPTIONS: readonly CampaignMode[] = ["brief", "variation"];
/** The canvas ratios the pipeline renders — the domain's RATIO_VALUES, in its order. */
export const RATIO_OPTIONS: readonly string[] = RATIO_VALUES;
export const STATIC_PLATFORMS = ["instagram-feed", "linkedin", "x"] as const;
/** Every distribution platform id in profile order — the toggle order for Output. */
export const PLATFORM_ORDER: readonly string[] = Object.keys(PLATFORM_PROFILES);

export type CampaignMode = "brief" | "variation";

export interface ProductDraft {
  /** Stable identity for React keys and async upload dispatch (not the product id). */
  key: number;
  id: string;
  name: string;
  primaryColor: string;
  logoPath: string;
  inputAsset: string;
  idTouched: boolean;
}

import { SWATCH_PALETTE } from "../ui/swatch-picker";
export { SWATCH_PALETTE };

export function emptyProduct(key: number, primaryColor = "#1473E6"): ProductDraft {
  return {
    key,
    id: "",
    name: "",
    primaryColor,
    logoPath: "",
    inputAsset: "",
    idTouched: false,
  };
}

export function nextKeyAfter(products: ProductDraft[]): number {
  const numericKeys = products
    .map((p) => p.key)
    .filter((k): k is number => typeof k === "number" && k > 0);
  return numericKeys.length > 0 ? Math.max(...numericKeys) + 1 : 1;
}

/**
 * Returns the next unused swatch in SWATCH_PALETTE for a new product, or wraps around.
 */
export function nextUnusedSwatch(products: readonly ProductDraft[]): string {
  const used = new Set(products.map((p) => p.primaryColor.toUpperCase()));
  return (
    SWATCH_PALETTE.find((c) => !used.has(c.toUpperCase())) ??
    SWATCH_PALETTE[products.length % SWATCH_PALETTE.length]
  );
}

/**
 * The one allocation path for a new product: append a draft keyed `nextKey` with
 * the next unused swatch and burn the counter.
 */
export function allocateProduct(
  products: ProductDraft[],
  nextKey: number,
): { products: ProductDraft[]; nextProductKey: number } {
  const nextColor = nextUnusedSwatch(products);
  return {
    products: [...products, emptyProduct(nextKey, nextColor)],
    nextProductKey: nextKey + 1,
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export function assetFileName(fileName: string, productId: string): string {
  const lower = fileName.toLowerCase();
  const match = lower.match(/\.(png|jpg|jpeg)$/);
  const ext = match?.[1] ?? "png";
  const stem = slugify(lower.replace(/\.[^.]+$/, "")) || "logo";
  const prefix = slugify(productId) || "product";
  const combined = `${prefix}-${stem}`.slice(0, 64).replace(/-+$/, "");
  return `${combined}.${ext}`;
}

export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export interface TreatmentDraft {
  id: string;
  layout: string;
  tone: string;
}

export interface TimelineBeatDraft {
  /**
   * Stable identity for React keys — the same device `ProductDraft.key` uses, and for the
   * same reason with an extra edge: these rows REORDER. Keyed by array position, moving a
   * beat hands its DOM node to a different beat, so focus stays on the position and a
   * second press of the same move button moves the wrong beat. Never serialised.
   */
  key: number;
  text: string;
  /** An integer in [1, MAX_WEIGHT] — the Stepper bounds it, timelineProblem holds it. */
  weight: number;
  /**
   * The beat's own background (VE5a) — an asset path; absent means the creative's.
   * Persisted: `toBrief` writes it back, so a loaded brief never loses its scenes
   * on save (D11). At most MAX_SCENES distinct values per timeline (VE-D10).
   */
  background?: string;
}

export interface TimelineDraft {
  beats: TimelineBeatDraft[];
  transition: "cut" | "fade";
  /**
   * 1-based index of the beat the poster shows (D7). Persisted, and deliberately an
   * index — the reducer re-points it across reorder/remove so the selected text stays
   * stable. Invariant: in [1, beats.length] whenever the timeline is not empty; the
   * reducer clamps and no serialisation path can emit an out-of-range value.
   */
  keyBeat: number;
}

export type EditorSource =
  | { kind: "new"; tempId: string }
  | {
      kind: "file";
      file: string;
      loadedId: string;
      savedSnapshot: CampaignBrief | null;
      revision: string | undefined;
    };

export interface EditorState {
  schemaVersion: number;
  source: EditorSource;
  mode: CampaignMode;
  /**
   * The campaign type (D108): which preset seeded this brief. Recorded so
   * surfaces can read it; nothing enforces it — the user may change platforms,
   * formats and mode afterwards and the type does not fight back (D109).
   * Absent on a brief means `social-post` (D112), exactly as absent mode means
   * classic, so `toBrief` emits it under the same rule `mode` uses.
   */
  type: CampaignType;
  /**
   * The brief's pinned creative template (D120/D123): the canonical reference and
   * the materialised layer list, held verbatim so a save never drops or re-derives
   * it (L3a). `fromBrief` reads it, `toBrief` writes it back; the canonical
   * template for `type` seeds a fresh draft and an applied preset.
   */
  template: BriefTemplate;
  campaignName: string;
  briefId: string;
  targetRegion: string;
  targetAudience: string;
  campaignMessage: string;
  localizedMessage: string;
  /**
   * The brief's click destination URL (HL2, HL-D3).
   * Carried through editor state so saving never destroys it.
   */
  clickDestination: string;
  /**
   * The brief's optional music bed (VE-D8), held verbatim. This lane authors no
   * control for it, but a load → save must not drop the licence record (D11):
   * `fromBrief` copies it in, `toBrief` writes it back only when present, and
   * the draft normaliser keeps it only when it is a usable `{ path, rights }`.
   */
  audio?: CampaignBrief["audio"];
  products: ProductDraft[];
  nextProductKey: number;
  /** The next free `TimelineBeatDraft.key`. Monotonic; never reused within a session. */
  nextBeatKey: number;
  treatments: TreatmentDraft[];
  /**
   * Sequenced copy for motion clips (E5): ordered beats, never seconds (D1). Empty
   * until a beat is added — an empty timeline is "no timeline" and is never
   * serialised, so a loaded brief without a `copy` block does not grow one. The
   * beats survive a retraction (Video off or a switch to classic) inside this draft;
   * only the serialisation is gated, so toggling back restores the work.
   */
  timeline: TimelineDraft;
  /** True only when the loaded brief declared a `copy` block (D11). A declared-but-empty
   * block (`copy: {}`) is legal — the parser accepts it — and must survive a load→save
   * the same way `outputExplicit` preserves a declared `output`: saving must not strip
   * what a file already wrote. The editor never authors an empty block on its own;
   * `toBrief` writes one only to keep such a file byte-identical. */
  copyExplicit: boolean;
  /**
   * True when the saved brief must carry `variation.axes.anchor` (T4): the loaded
   * brief declared the key, or the user toggled the axis this session. The absent
   * axis and an authored top+bottom selection are different variant spaces —
   * absent derives each variant's anchor from its own layout, the pair draws it
   * independently — so the flag LATCHES on toggle rather than recomputing (the
   * `ratioOverridden` discipline does not transfer: that collapse is lossless,
   * this one is lossy). Consequence: a toggle back to the derived pair leaves a
   * dirty brief that still carries the axis; only an untouched loaded brief —
   * whose flag comes from key presence in `fromBrief`, never a toggle —
   * round-trips the absent-key form byte-identically (D57).
   */
  anchorExplicit: boolean;
  /**
   * The brief-level creative style (T5), held verbatim. The authoring surface is
   * T7's Layout step, whose controls dispatch `setStyle`; the draft's remaining
   * jobs are preservation and honesty: a hand-authored YAML `style` must survive
   * load → save byte-identically (D58), and the preview must read exactly what
   * the saved brief will carry.
   */
  style: Style;
  /**
   * True only when the loaded brief declared a `style` block — the D11
   * preservation rule, the `anchorExplicit`/`copyExplicit` lesson: an
   * explicit-but-default style (`fontFamily: Inter` spelled out) says "I wrote
   * this key" and must round-trip verbatim, while the absent key serialises as
   * absent. A draft that diverges from the defaults without the flag (a
   * hand-edited restored draft) is emitted too — the divergence makes the block
   * real. `setStyle` latches the flag the way `toggleAnchor` latches its own:
   * a control touched this session has written the key, and returning a value
   * to its default does not unwrite it.
   */
  styleExplicit: boolean;
  variation: {
    count: string;
    seed: string;
    minDistance: string;
    perProduct: string;
    perRatio: string;
    layout: string[];
    tone: string[];
    /** Where the headline block sits vertically (T4) — the same axis list the other axes keep. */
    anchor: string[];
    ratio: string[];
    background: string[];
    paletteShift: number[];
    headline: boolean;
  };
  motion: string[];
  duration: number[];
  formats: string[];
  platforms: string[];
  /**
   * Authored display sizes. A brief may request a subset of a display profile's
   * sizes (`["728x90"]` on `google-display`); that subset is state, not a
   * derivation from the selected platforms. `togglePlatform` keeps it consistent
   * (union on add, drop sizes no remaining display platform offers on remove).
   * There is no `toggleSize` action this round — no UI asks for it yet.
   */
  readonly sizes: DisplaySize[];
  /**
   * Whether the output block must be written even when it equals the absent-key
   * default (static × the static platforms): true when the loaded brief declared
   * `output`. A default-valued output that was never declared serialises as the
   * absent key instead — the static platforms carry zero insets (D11), so both
   * forms render identically. Toggling a format or platform does not set this:
   * `toBrief` writes output whenever a toggle leaves it diverging from the
   * default, and omits it when a toggle returns to the default, so a load→save
   * round-trip (and a toggle-on→off cycle) is byte-identical (merge gate).
   */
  outputExplicit: boolean;
  /**
   * True only when the loaded brief wrote the default `mode: brief` explicitly.
   * `variation` needs no flag — `toBrief` always writes it, because it says
   * something the absent key does not. This flag covers the redundant-but-present
   * case, so a file that spells out its classic mode still round-trips
   * byte-for-byte. Switching *to* `brief` does not set it: returning to the
   * default must serialise like the default (the toggle-on→off rule `output`
   * already follows).
   */
  modeExplicit: boolean;
  /**
   * True only when the loaded brief wrote the default `type: social-post`
   * explicitly (D112) — the `modeExplicit` pattern one line below: a type that
   * is not the default always says something the absent key does not, an
   * untouched default must never grow the key (the corpus round-trip depends on
   * it), and an explicitly spelled default must round-trip byte-identically.
   */
  typeExplicit: boolean;
  /** True when formats were explicitly authored or loaded diverging from platform defaults (D7). */
  formatsOverridden: boolean;
  /** True when ratio was explicitly authored or loaded diverging from platform defaults (D7). */
  ratioOverridden: boolean;
  /** True when motion kinds or durations were touched by user (D9). */
  motionTouched: boolean;
  /** True when motion was seeded upon turning Video on (D9). */
  motionSeeded: boolean;
  pool: CopyPool | null;
  headlineAxisDropped: boolean;
  /**
   * The count the reducer last lowered because the axes could no longer produce it
   * (D13) — shown once beside the slider, cleared by the next count edit or by any
   * axis toggle that does not clamp. Derived UI state: never serialized.
   */
  countNotice: number | null;
  /**
   * Advisory finding when a layer reposition introduces occlusion (D135, D136).
   * Populated on `moveLayer` when the new order occludes, cleared when the order
   * no longer occludes. Derived UI state: never serialized.
   */
  occlusionNotice: string | null;
  appliedSnapshot: CampaignBrief | null;
  capabilities: { motion: boolean; reason?: string } | null;
}

export type EditorAction =
  | { type: "setMode"; mode: CampaignMode }
  | { type: "applyPreset"; campaignType: CampaignType }
  | {
      type: "patch";
      patch: Partial<
        Pick<
          EditorState,
          | "campaignName"
          | "briefId"
          | "targetRegion"
          | "targetAudience"
          | "campaignMessage"
          | "localizedMessage"
          | "clickDestination"
        >
      >;
    }
  | { type: "setProduct"; key: number; patch: Partial<ProductDraft> }
  | { type: "addProduct" }
  | { type: "removeProduct"; key: number }
  | { type: "setTreatment"; index: number; patch: Partial<TreatmentDraft> }
  | { type: "addTreatment" }
  | { type: "removeTreatment"; index: number }
  // The template's layer list (L5, D124): the offers the compatibility table
  // permits. `addLayer` carries the kind only — the id is the reducer's job —
  // and a new layer carries no props.
  | { type: "addLayer"; kind: LayerKind }
  | { type: "removeLayer"; id: string }
  // The order the list already holds is z-order (D128): a move re-points one
  // layer's position, every other layer untouched. An out-of-range end is a
  // no-op, the way `removeLayer`'s unremovable id is.
  | { type: "moveLayer"; from: number; to: number }
  // Whether a layer draws (L9, D129): `enabled` absent means enabled, so
  // switching a layer off writes `enabled: false` and switching it back on
  // removes the field — the canonical form every template already carries.
  | { type: "setLayerEnabled"; id: string; enabled: boolean }
  // The `html` layer's elements (HL5a, HL-D1): the second vocabulary, nested
  // inside the first, so every action names the layer it edits and the index
  // inside that layer's list. Each one is a no-op — the SAME state object — when
  // the layer is absent, is not of kind `html`, or the index is outside the
  // list, exactly as `removeLayer` and `moveLayer` refuse.
  | { type: "addHtmlElement"; layerId: string; kind: HtmlElementKind }
  | { type: "removeHtmlElement"; layerId: string; index: number }
  | { type: "moveHtmlElement"; layerId: string; from: number; to: number }
  | { type: "setHtmlElementText"; layerId: string; index: number; text: string }
  | {
      type: "setHtmlElementFrame";
      layerId: string;
      index: number;
      patch: Partial<Frame>;
    }
  // The element's own font override (HL5e, HL-D8): a patch field set to
  // `undefined` is the "brief default" choice — it REMOVES the key, so an
  // element whose last override is cleared carries no `style` at all, the X16
  // canonical form that keeps a set-then-clear round trip byte-identical.
  | {
      type: "setHtmlElementStyle";
      layerId: string;
      index: number;
      patch: Partial<HtmlElementStyle>;
    }
  | { type: "addBeat"; text?: string }
  | { type: "removeBeat"; index: number }
  | { type: "moveBeat"; from: number; to: number }
  | { type: "setBeatText"; index: number; text: string }
  | { type: "setBeatWeight"; index: number; weight: number }
  | { type: "setKeyBeat"; index: number }
  | { type: "setTransition"; transition: "cut" | "fade" }
  | {
      type: "setVariation";
      field: "count" | "seed" | "minDistance" | "perProduct" | "perRatio";
      value: string;
    }
  | { type: "toggleLayout"; value: string }
  | { type: "toggleTone"; value: string }
  | { type: "toggleAnchor"; value: string }
  | { type: "toggleRatio"; value: string }
  | { type: "toggleBackground"; value: string }
  | { type: "togglePalette"; value: number }
  | { type: "toggleHeadline" }
  | { type: "setStyle"; patch: Partial<Style> }
  | { type: "toggleMotion"; value: string }
  | { type: "setDuration"; index: number; value: number }
  | { type: "addDuration"; value?: number }
  | { type: "addPhotoOutput" }
  | { type: "removeDuration"; index: number }
  | { type: "toggleFormat"; value: string }
  | { type: "togglePlatform"; value: string }
  | { type: "setPool"; briefId: string; pool: CopyPool | null }
  | { type: "loadPool"; briefId: string; pool: CopyPool | null }
  | {
      type: "load";
      brief: CampaignBrief;
      entry?: { file: string; revision?: string };
    }
  | { type: "apply"; applied?: CampaignBrief }
  | {
      type: "save";
      saved?: CampaignBrief;
      entry?: { file: string; revision?: string };
    }
  | { type: "restore"; state: EditorState }
  | { type: "discard" }
  | {
      type: "setCapabilities";
      capabilities: { motion: boolean; reason?: string };
    };

/**
 * H6/D37: the one draft key an unnamed draft uses. It was a per-mount temp id, which
 * keyed the autosaved recovery copy to a value that died with the page — a reload
 * orphaned the draft it had just written. Under the route model every unnamed editor
 * is `/brief/new`, so the key is one stable string: a reload at the same route finds
 * the draft it left.
 */
function generateTempId(): string {
  return "new";
}

export function initialEditorState(mode: CampaignMode = "brief"): EditorState {
  const tempId = generateTempId();
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    source: { kind: "new", tempId },
    mode,
    type: DEFAULT_CAMPAIGN_TYPE,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    campaignName: "",
    briefId: "",
    targetRegion: "",
    targetAudience: "",
    campaignMessage: "",
    localizedMessage: "",
    clickDestination: "",
    products: [emptyProduct(1)],
    nextProductKey: 2,
    nextBeatKey: 1,
    treatments: [],
    timeline: { beats: [], transition: "fade", keyBeat: 1 },
    copyExplicit: false,
    anchorExplicit: false,
    style: {},
    styleExplicit: false,
    variation: {
      count: "12",
      seed: "",
      minDistance: "2",
      perProduct: "1",
      perRatio: "1",
      layout: [...LAYOUT_OPTIONS],
      tone: [...TONE_OPTIONS],
      anchor: [...DERIVED_ANCHOR_OPTIONS],
      ratio: [...RATIO_OPTIONS],
      background: [...DEFAULT_BACKGROUND_SOURCES],
      paletteShift: [...PALETTE_SHIFT_OPTIONS],
      headline: false,
    },
    motion: [],
    duration: [],
    formats: ["static"],
    platforms: [...STATIC_PLATFORMS],
    sizes: [],
    outputExplicit: false,
    modeExplicit: false,
    typeExplicit: false,
    formatsOverridden: false,
    ratioOverridden: false,
    motionTouched: false,
    motionSeeded: false,
    pool: null,
    headlineAxisDropped: false,
    countNotice: null,
    occlusionNotice: null,
    appliedSnapshot: null,
    capabilities: null,
  };
}

function toggleOrdered<T>(list: readonly T[], value: T, order: readonly T[]): T[] {
  const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  return order.filter((item) => next.includes(item));
}

/** The union's canonical DISPLAY_SIZE_VALUES order — the tuple is the compile-time fact, so sort by it. */
function orderedDisplaySizes(sizes: Iterable<DisplaySize>): DisplaySize[] {
  const set = new Set(sizes);
  return DISPLAY_SIZE_VALUES.filter((size) => set.has(size));
}

/** True when the selection is exactly the derived pair the absent axis produces. */
function isDerivedAnchorSelection(selection: readonly string[]): boolean {
  return (
    selection.length === DERIVED_ANCHOR_OPTIONS.length &&
    DERIVED_ANCHOR_OPTIONS.every((value, index) => selection[index] === value)
  );
}

/**
 * Whether the draft's saved brief will carry the anchor axis — the editor's
 * mirror of the domain's `anchor.length > 0`: everything downstream
 * (`axisProductSize`, the minDistance bound, the dock's derivation) must read
 * the axis exactly as `toBrief` writes it.
 */
export function anchorAxisActive(state: EditorState): boolean {
  return state.anchorExplicit || !isDerivedAnchorSelection(state.variation.anchor);
}

/*
 * How big the draw is. These three live here rather than in `validate.ts` because the
 * reducer needs them — the count clamp cannot run without knowing the ceiling — and
 * having validate own them made the two modules import each other. `validate.ts`
 * re-exports all three, so every existing caller is unaffected.
 */

/** Ratios the requested platforms package motion at — the motion filter's allowlist. */
export function motionPackagedRatios(state: EditorState | readonly string[]): Set<string> {
  const platforms: readonly string[] = Array.isArray(state)
    ? (state as readonly string[])
    : (state as EditorState).platforms;
  return new Set(
    platforms
      .map((id: string) => PLATFORM_PROFILES[id])
      .filter((profile): profile is PlatformProfile => profile !== undefined)
      .filter(isRatioProfile)
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
    // The anchor axis (T4) multiplies only when the saved brief will carry it:
    // the absent axis derives top/bottom from `layout`, adding no combination.
    (anchorAxisActive(state) ? Math.max(1, state.variation.anchor.length) : 1) *
    (motionEnabled
      ? state.motion.length * Math.max(1, state.duration.length) + (mixStatic ? 1 : 0)
      : 1)
  );
}

/**
 * D13/D6: when an axis toggle shrinks what the axes can produce below the count, the
 * count comes down with it (the planner would refuse anything higher) and the editor
 * says so once, beside the slider. Any toggle that does not clamp clears the notice —
 * it describes the latest clamp only, never history.
 */
function withCountClamp(state: EditorState): EditorState {
  const axisMax = axisProductSize(state);
  const count = parsePolicyInteger(state.variation.count) ?? 0;
  if (count > axisMax) {
    return {
      ...state,
      variation: { ...state.variation, count: String(axisMax) },
      countNotice: axisMax,
    };
  }
  // Nothing to clamp. Keep the same object when there is also no notice to take down,
  // so a refused action stays identity-equal for the callers that check.
  return state.countNotice === null ? state : { ...state, countNotice: null };
}

/**
 * Remove a beat (0-based `index`), re-pointing `keyBeat` so the poster's text does not
 * change because rows moved (D7/E5.1). A beat before the poster decrements it; removing
 * the poster itself keeps the index — the beat that shifted into the slot inherits the
 * poster, or, when it was last, the new last beat does — and a beat after it leaves it
 * alone. Emptying the list resets `keyBeat` to 1, which no path serialises because an
 * empty timeline has no `keyBeat` to write.
 */
function removeTimelineBeat(timeline: TimelineDraft, index: number): TimelineDraft {
  const beats = timeline.beats.filter((_, i) => i !== index);
  let nextKeyIndex = timeline.keyBeat - 1;
  if (index < timeline.keyBeat - 1) nextKeyIndex = timeline.keyBeat - 2;
  else if (index === timeline.keyBeat - 1)
    nextKeyIndex = Math.min(timeline.keyBeat - 1, beats.length - 1);
  return {
    beats,
    transition: timeline.transition,
    keyBeat: beats.length === 0 ? 1 : nextKeyIndex + 1,
  };
}

/**
 * Move a beat (0-based `from` → `to`), re-pointing `keyBeat` so the poster's text does
 * not change because rows moved. The poster is tracked by position, not content: when
 * the moved row IS the poster it follows to `to`; otherwise it shifts exactly as a row
 * would — left when a beat ahead of it is carried forward past it, right when a beat
 * behind it is carried back across it. The result is always in [1, beats.length].
 */
function moveTimelineBeat(timeline: TimelineDraft, from: number, to: number): TimelineDraft {
  const next = [...timeline.beats];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const keyIndex = timeline.keyBeat - 1;
  let nextKeyIndex = keyIndex;
  if (keyIndex === from) nextKeyIndex = to;
  else if (keyIndex > from) nextKeyIndex = to <= keyIndex - 1 ? keyIndex : keyIndex - 1;
  else nextKeyIndex = to <= keyIndex ? keyIndex + 1 : keyIndex;
  return {
    beats: next,
    transition: timeline.transition,
    keyBeat: nextKeyIndex + 1,
  };
}

/**
 * The clip lengths a timeline is measured against.
 *
 * An empty duration axis is not "no clips": the planner falls back to the single default,
 * and `timelineProblem` measures the readability floor against the SHORTEST length. The
 * editor has to read the axis exactly as the planner does, or it will flag a different set
 * of drafts than the run refuses.
 */
export function timelineDurations(state: EditorState): readonly number[] {
  return state.duration.length > 0 ? state.duration : DEFAULT_DURATION;
}

/** The draft's timeline as the domain sees it. */
export function asCopyTimeline(timeline: TimelineDraft): CopyTimeline {
  return {
    beats: timeline.beats,
    transition: timeline.transition,
    keyBeat: timeline.keyBeat,
  };
}

/**
 * Why *Add beat* is unavailable, or undefined when it is available.
 *
 * Data, not copy — the same discipline `countNotice` follows: this returns what is true and
 * the section turns it into a sentence, so no user-facing string lives in state.
 *
 * Answered by SIMULATION rather than arithmetic: build the timeline the click would
 * produce and ask the domain. That is the only way the editor and the parser cannot drift,
 * and because it re-derives on every render, narrowing the duration axis re-answers it with
 * no extra wiring — the case the plan names as the one a click-time check misses.
 *
 * The dwell block is decided by the FLOOR condition alone, not by `timelineProblem`. The
 * simulated beat carries no background, so adding one can never change the scene count: an
 * existing scene-cap violation (a restored draft that already names more than MAX_SCENES)
 * must not masquerade as a dwell block — validation reports it where it belongs.
 */
export type AddBeatBlock =
  | { readonly kind: "max"; readonly max: number }
  | {
      readonly kind: "floor";
      readonly shortestSec: number;
      readonly floorSec: number;
    };

export function addBeatBlockedBy(state: EditorState): AddBeatBlock | undefined {
  if (state.timeline.beats.length >= MAX_BEATS) return { kind: "max", max: MAX_BEATS };
  const durations = timelineDurations(state);
  const withOneMore: CopyTimeline = {
    beats: [...state.timeline.beats, { text: "", weight: 1 }],
    transition: state.timeline.transition,
    keyBeat: state.timeline.keyBeat,
  };
  if (dwellProblem(withOneMore, durations) === undefined) return undefined;
  return {
    kind: "floor",
    shortestSec: Math.min(...durations),
    floorSec: MIN_DWELL_SEC,
  };
}

/** A usable 0-based index into a list of `count` entries: an integer inside it. */
function isListIndex(index: number, count: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < count;
}

/** A usable 0-based beat index: an integer inside the current list. */
function isBeatIndex(index: number, beatCount: number): boolean {
  return isListIndex(index, beatCount);
}

/** A usable 0-based layer index: an integer inside the current list. */
function isLayerIndex(index: number, layerCount: number): boolean {
  return isListIndex(index, layerCount);
}

/**
 * Formats an advisory finding into the catalog's note (D135, D136, D2, D18).
 * Converts raw layer kinds to display labels and maps domain occlusion behavior
 * to the catalog's effect verb ("hide" | "mute" | "overlap").
 */
export function formatOcclusionNotice(finding: OcclusionFinding | null): string | null {
  if (!finding) return null;
  const effect: "hide" | "mute" | "overlap" =
    finding.behavior === "opaque"
      ? "hide"
      : finding.behavior === "attenuating"
        ? "mute"
        : "overlap";
  return messages.templateOcclusionNote(
    layerKindDisplayName(finding.above),
    layerKindDisplayName(finding.below),
    effect,
  );
}

/**
 * A layer with `enabled` set to `value`, in the one canonical form (D129): a layer
 * that draws carries no `enabled` key at all, so switching a layer off writes
 * `enabled: false` and switching it back on removes the field. An off→on round
 * trip therefore returns the layer to the shape it was loaded with — byte for byte
 * the shape every canonical template already carries — and a brief never grows a
 * key that only restates what absence says.
 */
function withEnabled(layer: CreativeTemplateLayer, value: boolean): CreativeTemplateLayer {
  if (!value) return { ...layer, enabled: false };
  // Removing the one optional key a copy of a readonly layer can drop: the
  // double cast is the type system's blind spot around `delete` on a record,
  // not a widening — the result is the same layer minus a field that was
  // optional to begin with.
  const next: Record<string, unknown> = { ...layer };
  delete next.enabled;
  return next as unknown as CreativeTemplateLayer;
}

/**
 * Where a new element sits (HL5a), per kind: fractions of the canvas (D130), so
 * the element the editor adds is one both renderers can already place. Keyed by
 * the kind vocabulary, so a fourth kind is a compile error rather than a frame
 * nobody chose.
 */
const NEW_ELEMENT_FRAMES: Readonly<Record<HtmlElementKind, Frame>> = {
  text: { x: 0.08, y: 0.08, w: 0.84, h: 0.18, anchor: "top" },
  button: { x: 0.35, y: 0.74, w: 0.3, h: 0.12, anchor: "bottom" },
  image: { x: 0.08, y: 0.16, w: 0.84, h: 0.56, anchor: "middle" },
};

/** A frame's own fields, in declaration order — the equality an edit asks first. */
const FRAME_FIELDS = ["x", "y", "w", "h", "anchor"] as const;
/** The numeric ones: the fields a frame patch clamps. */
const FRAME_NUMBER_FIELDS = ["x", "y", "w", "h"] as const;

/**
 * A new element (HL5a): the kind, the frame its kind starts at, and — for the
 * kinds that carry copy — the copy the catalog hands out. An `image` element
 * gets no `text` key at all, because the domain's field table refuses copy on
 * it: an element the boundary rejects is not a default, it is a defect.
 */
function newHtmlElement(kind: HtmlElementKind): HtmlElement {
  const frame = { ...NEW_ELEMENT_FRAMES[kind] };
  return kind === "image"
    ? { kind, frame }
    : { kind, text: messages.htmlElementDefaultCopy(kind), frame };
}

/**
 * The `html` layer's element list, with the index an element action needs to
 * put it back — or undefined when the action must be a no-op: no layer by that
 * id, a layer of another kind (only `html` carries elements, HL-D1), or an
 * index outside the list.
 */
interface HtmlElementEdit {
  readonly layerIndex: number;
  readonly elements: readonly HtmlElement[];
}

function htmlElementEdit(
  state: EditorState,
  layerId: string,
  index?: number,
): HtmlElementEdit | undefined {
  const layerIndex = state.template.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) return undefined;
  const layer = state.template.layers[layerIndex]!;
  if (layer.kind !== "html") return undefined;
  const elements = layer.elements ?? [];
  if (index !== undefined && !isListIndex(index, elements.length)) return undefined;
  return { layerIndex, elements };
}

/**
 * The layer carrying `elements`, in the one canonical form (HL5a): an empty
 * list IS the absent key, so removing the last element returns the layer — and
 * with it the template — to the shape it was loaded with, and an add-then-remove
 * is `valuesEqual` (the round-trip lesson from M3's review). The `elements: []`
 * a naive splice leaves behind is a brief that reads as dirty for a change the
 * user undid.
 */
function withElements(
  layer: CreativeTemplateLayer,
  elements: readonly HtmlElement[],
): CreativeTemplateLayer {
  if (elements.length > 0) return { ...layer, elements };
  // The double cast is the type system's blind spot around `delete` on a
  // record, the same one `withEnabled` names: the result is the same layer
  // minus a field that was optional to begin with.
  const next: Record<string, unknown> = { ...layer };
  delete next.elements;
  return next as unknown as CreativeTemplateLayer;
}

function withHtmlElements(
  state: EditorState,
  edit: HtmlElementEdit,
  elements: readonly HtmlElement[],
): EditorState {
  const layers = [...state.template.layers];
  layers[edit.layerIndex] = withElements(layers[edit.layerIndex]!, elements);
  return { ...state, template: { ...state.template, layers } };
}

/**
 * The one canonical form an element's defaults take (X16, HL5e): a `style`
 * block naming no override restates what the absent key already means — every
 * field of an optional-override block is optional — so it is dropped the way
 * `enabled: true` and `elements: []` are. Same object when there is nothing to
 * drop.
 */
function canonicalElement(element: HtmlElement): HtmlElement {
  if (
    element.style === undefined ||
    element.style.fontWeight !== undefined ||
    element.style.fontFamily !== undefined
  )
    return element;
  const next: Record<string, unknown> = { ...element };
  delete next.style;
  return next as unknown as HtmlElement;
}

/**
 * The one canonical form a template layer's defaults take (X16, D129, HL5a):
 * `enabled: true` restates what absence already means, `elements: []` is
 * the same as no list, and an element's empty `style` block is the same as no
 * block. Mapping these to absent is what `withEnabled` / `withElements` /
 * `setHtmlElementStyle` already write, so a hand-authored brief that spelled
 * the defaults out compares equal to the draft after an off→on (or add→remove,
 * or set→clear) round trip. Same object when nothing needs rewriting.
 */
function canonicalLayer(layer: CreativeTemplateLayer): CreativeTemplateLayer {
  const dropEnabled = layer.enabled === true;
  const dropElements = Array.isArray(layer.elements) && layer.elements.length === 0;
  const canonicalElements = dropElements ? undefined : layer.elements?.map(canonicalElement);
  const restyledElements =
    canonicalElements !== undefined &&
    layer.elements !== undefined &&
    canonicalElements.some((element, index) => element !== layer.elements![index]);
  if (!dropEnabled && !dropElements && !restyledElements) return layer;
  const next: Record<string, unknown> = { ...layer };
  if (dropEnabled) delete next.enabled;
  if (dropElements) delete next.elements;
  else if (restyledElements) next.elements = canonicalElements;
  return next as unknown as CreativeTemplateLayer;
}

export function canonicalTemplate(template: BriefTemplate): BriefTemplate {
  let changed = false;
  const layers = template.layers.map((layer) => {
    const next = canonicalLayer(layer);
    if (next !== layer) changed = true;
    return next;
  });
  return changed ? { ...template, layers } : template;
}

/**
 * `toBrief` always writes these as strings, empty included. A YAML empty
 * scalar is null at the boundary (D68); mapping it to "" is the form the
 * draft holds, so a freshly opened file is not dirty.
 */
const REQUIRED_BRIEF_STRINGS = ["targetRegion", "targetAudience", "campaignMessage"] as const;

/**
 * `toBrief` omits these when empty. Null is absence: drop the key so the
 * snapshot matches a save of the coalesced draft.
 */
const OMITTED_BRIEF_STRINGS = ["localizedMessage", "clickDestination"] as const;

const REQUIRED_PRODUCT_STRINGS = ["id", "name", "primaryColor", "logoPath"] as const;

function canonicalProduct(product: Product): Product {
  // A stored snapshot's products array can hold anything: a null entry from a
  // hand-edited file is held verbatim, the way a malformed template is, so
  // recovery never throws and never loses the draft.
  if (product === null || typeof product !== "object") return product;
  let changed = false;
  const next: Record<string, unknown> = { ...product };
  for (const key of REQUIRED_PRODUCT_STRINGS) {
    if (next[key] == null) {
      next[key] = "";
      changed = true;
    }
  }
  // `toProduct` writes inputAsset only when its trimmed value is non-empty,
  // so null, "" and a blank string all spell absence and drop the key.
  if (
    "inputAsset" in next &&
    (next.inputAsset == null ||
      (typeof next.inputAsset === "string" && next.inputAsset.trim() === ""))
  ) {
    delete next.inputAsset;
    changed = true;
  }
  return changed ? (next as unknown as Product) : product;
}

function canonicalNullScalars(brief: CampaignBrief): CampaignBrief {
  // The same totality one level up: a snapshot that is not an object (a bare
  // string from a corrupt localStorage entry) is returned unchanged.
  if (brief === null || typeof brief !== "object") return brief;
  let changed = false;
  const next: Record<string, unknown> = { ...brief };
  for (const key of REQUIRED_BRIEF_STRINGS) {
    if (next[key] == null) {
      next[key] = "";
      changed = true;
    }
  }
  for (const key of OMITTED_BRIEF_STRINGS) {
    if (key in next && next[key] == null) {
      delete next[key];
      changed = true;
    }
  }
  if (Array.isArray(brief.products)) {
    const products = brief.products.map(canonicalProduct);
    if (products.some((product, i) => product !== brief.products[i])) {
      next.products = products;
      changed = true;
    }
  }
  return changed ? (next as unknown as CampaignBrief) : brief;
}

export function canonicalBrief(brief: CampaignBrief): CampaignBrief {
  // A pre-L3a brief (and a few fixtures) carries no template; absence is
  // not a default to rewrite. Null scalars still collapse, so a template-less
  // snapshot with `targetAudience: null` is not dirty against the draft.
  if (brief.template === undefined) return canonicalNullScalars(brief);
  // A stored snapshot (or any other caller) can carry a template that
  // fails isBriefTemplate: null, a non-array layers list, a null entry.
  // Mapping those throws. Before X16 they were held verbatim; every path
  // through here must do the same, so discard does not lose the file.
  if (!isBriefTemplate(brief.template)) return canonicalNullScalars(brief);
  const template = canonicalTemplate(brief.template);
  const withTemplate = template === brief.template ? brief : { ...brief, template };
  return canonicalNullScalars(withTemplate);
}

/**
 * A frame patch merged into `prior` (HL5a), so the result is always a frame the
 * domain accepts: a value that is not a finite number — a NaN or an infinity a
 * hand-restored draft can carry — keeps the one it had, a finite one is clamped
 * into [0, 1], and an `anchor` outside `ANCHOR_VALUES` is refused the same way.
 * The editor never produces an element the boundary refuses.
 */
function clampedFrame(patch: Partial<Frame>, prior: Frame): Frame {
  const next: Record<string, unknown> = { ...prior };
  for (const field of FRAME_NUMBER_FIELDS) {
    const value = patch[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    next[field] = Math.min(1, Math.max(0, value));
  }
  const anchor = patch.anchor;
  if (anchor !== undefined && (ANCHOR_VALUES as readonly string[]).includes(anchor)) {
    next.anchor = anchor;
  }
  return next as unknown as Frame;
}

function reduceEditor(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "setMode": {
      // A flip to the same mode changed nothing — keep the state identity-equal,
      // the way a refused action stays identity-equal. D99's drop lives in
      // `toBrief` (a whole-classic gate), not here: the draft's formats must
      // survive so the D5 round-trip and the remedy stay true.
      if (action.mode === state.mode) return state;
      return { ...state, mode: action.mode };
    }
    case "applyPreset": {
      // D109 — a type is a preset, applied once: it seeds the platforms, the
      // formats and the mode the preset table carries, and the brief records
      // the type. The mode goes through the `setMode` branch itself, so its
      // rule (a same-mode flip stays identity-equal) is never restated here.
      // Nothing re-applies a preset — no remount, no load, no presentation
      // switch; the seed is spent by the one dispatch the seed effect makes.
      const preset = CAMPAIGN_TYPE_PRESETS[action.campaignType];
      const withMode = reduceEditor(state, {
        type: "setMode",
        mode: preset.mode,
      });
      // D9 — the same seeding rule the `toggleFormat` and `togglePlatform`
      // cases run whenever Video turns on: a fresh draft gains the motion
      // defaults, or a seeded motion preset would open an editor whose Save is
      // blocked by an empty motion axis the user never saw a control for. The
      // retraction mirrors it the same way, so switching to a still-only
      // preset leaves no orphaned kinds behind.
      const videoTurningOn =
        preset.formats.includes("motion") && !withMode.formats.includes("motion");
      const videoTurningOff =
        !preset.formats.includes("motion") && withMode.formats.includes("motion");
      let motion = withMode.motion;
      let duration = withMode.duration;
      let motionSeeded = withMode.motionSeeded;
      if (
        videoTurningOn &&
        motion.length === 0 &&
        duration.length === 0 &&
        !withMode.motionTouched
      ) {
        motion = [...MOTION_KINDS];
        duration = [DEFAULT_DURATION_SEC];
        motionSeeded = true;
      } else if (videoTurningOff && !withMode.motionTouched) {
        motion = [];
        duration = [];
        motionSeeded = false;
      }
      return {
        ...withMode,
        type: action.campaignType,
        // The applied preset's canonical template: the seeded campaign carries the
        // template its type names, not the default one the fresh draft held (L3a).
        template: templateFromCanonical(action.campaignType),
        platforms: [...preset.platforms],
        formats: [...preset.formats],
        // A3 — a display preset's output.sizes are derived the same way the
        // platform toggles contribute them: the union of the preset's display
        // profiles' sizes, in canonical order (`platformsToSizes` answers []
        // for a social-only preset, so the social seeds stay exactly as they
        // were). `sizes` is authored state (see `toBrief`), so without this the
        // seeded display campaign would carry platforms but no sizes and run
        // with nothing to render — the D8 dead end D117 exists to refuse.
        sizes: platformsToSizes(preset.platforms),
        motion,
        duration,
        motionSeeded,
        occlusionNotice: null,
      };
    }
    case "patch": {
      let patch = action.patch;
      if (patch.campaignName !== undefined && state.source.kind === "new") {
        patch = {
          ...patch,
          briefId: slugify(patch.campaignName),
        };
      }
      const next = { ...state, ...patch };
      if (patch.briefId === undefined || patch.briefId === state.briefId) return next;
      return {
        ...next,
        pool: null,
        headlineAxisDropped: false,
        variation: { ...state.variation, headline: false },
      };
    }
    case "setProduct": {
      return {
        ...state,
        products: state.products.map((product) => {
          if (product.key !== action.key) return product;
          const next = { ...product, ...action.patch };
          if (action.patch.id !== undefined) next.idTouched = true;
          else if (action.patch.name !== undefined && !product.idTouched)
            next.id = slugify(action.patch.name);
          return next;
        }),
      };
    }
    case "addProduct":
      return {
        ...state,
        ...allocateProduct(state.products, state.nextProductKey),
      };
    case "removeProduct":
      return {
        ...state,
        products: state.products.filter((product) => product.key !== action.key),
      };
    case "setTreatment": {
      return {
        ...state,
        treatments: state.treatments.map((treatment, index) => {
          if (index !== action.index) return treatment;
          return { ...treatment, ...action.patch };
        }),
      };
    }
    case "addTreatment":
      return {
        ...state,
        treatments: [
          ...state.treatments,
          { id: "", layout: LAYOUT_OPTIONS[0], tone: TONE_OPTIONS[0] },
        ],
      };
    case "removeTreatment":
      return {
        ...state,
        treatments: state.treatments.filter((_, index) => index !== action.index),
      };
    case "addLayer": {
      // D124, D128 — the editor's offer IS the boundary's rule: a kind the Template
      // section could not offer (outside `accepts`, at its own cap, filling a shared
      // budget, or with no legal order placement) is refused here exactly as the API
      // refuses it, so the two cannot drift. A refused dispatch stays identity-equal,
      // like every guarded case above.
      if (!addableKinds(state).includes(action.kind)) return state;
      // `as number`: `addableKinds` already verified that a legal insertion index exists.
      const insertionIndex = findLegalInsertionIndex(
        state.template.creativeType,
        state.template.layers,
        action.kind,
      ) as number;

      // A new layer carries no props (L5): `{ id, kind }` only, the id derived
      // from the kind and deduplicated against the ids the list already holds
      // (`image`, then `image-2`, `image-3`, …).
      const taken = new Set(state.template.layers.map((layer) => layer.id));
      let id: string = action.kind;
      for (let n = 2; taken.has(id); n += 1) id = `${action.kind}-${n}`;
      const newLayer = { id, kind: action.kind };
      const nextLayers = [
        ...state.template.layers.slice(0, insertionIndex),
        newLayer,
        ...state.template.layers.slice(insertionIndex),
      ];
      return {
        ...state,
        occlusionNotice: formatOcclusionNotice(
          findOcclusionDeltaOverEnabled(state.template.layers, nextLayers),
        ),
        template: {
          ...state.template,
          // Placed at the derived legal index (highest index satisfying constraints,
          // defaulting to topmost), so an offered add always yields a legal order (D128).
          layers: nextLayers,
        },
      };
    }
    case "removeLayer": {
      // The same offer discipline, the other direction: a layer the section
      // could not offer for removal (a required kind's last presence) is a
      // no-op, so the draft can never hold a brief the boundary refuses for
      // stripping a kind it will not parse without.
      if (!removableLayerIds(state).includes(action.id)) return state;
      // Exactly one row per click. The storage guard refuses duplicate layer
      // ids, but the reducer is the contract and a draft restored before it
      // could still carry a pair: filtering by id would strip both at once —
      // the duplicated kind required, Save would then fail for a layer the
      // user never touched. The first match goes; the duplicate stays.
      const index = state.template.layers.findIndex((layer) => layer.id === action.id);
      const nextLayers = state.template.layers.filter((_, i) => i !== index);
      return {
        ...state,
        occlusionNotice: formatOcclusionNotice(
          findOcclusionDeltaOverEnabled(state.template.layers, nextLayers),
        ),
        template: {
          ...state.template,
          layers: nextLayers,
        },
      };
    }
    case "moveLayer": {
      // Array position is z-order (D128): a move re-orders the list in place,
      // every other layer untouched. An out-of-range end is a no-op the way
      // `removeLayer`'s unremovable id is — the draft never leaves what the
      // boundary offered — and moving a layer onto its own index says nothing.
      const layerCount = state.template.layers.length;
      if (
        action.from === action.to ||
        !isLayerIndex(action.from, layerCount) ||
        !isLayerIndex(action.to, layerCount)
      ) {
        return state;
      }
      const layers = [...state.template.layers];
      const [moved] = layers.splice(action.from, 1);
      layers.splice(action.to, 0, moved);
      return {
        ...state,
        occlusionNotice: formatOcclusionNotice(
          findOcclusionDeltaOverEnabled(state.template.layers, layers),
        ),
        template: {
          ...state.template,
          layers,
        },
      };
    }
    case "setLayerEnabled": {
      // D129, MP-D4 — the same offer discipline a remove and an add hold: a layer
      // the Template section could not offer (the last enabled instance of a
      // required kind) is refused here, so the draft can never hold a template the
      // boundary refuses for carrying a required kind with nothing enabled.
      const index = state.template.layers.findIndex((layer) => layer.id === action.id);
      if (index === -1) return state;
      // Already in the state asked for: no edit, so no history entry either.
      // (Two rows sharing an id — a draft restored before the storage guard —
      // are served by the first match, exactly as `removeLayer` serves them.)
      const layer = state.template.layers[index]!;
      if ((layer.enabled !== false) === action.enabled) return state;
      if (!action.enabled && !disableableLayerIds(state).includes(action.id)) {
        return state;
      }
      const nextLayers = state.template.layers.map((existing, i) =>
        i === index ? withEnabled(existing, action.enabled) : existing,
      );
      return {
        ...state,
        // MP-D3: the notice is computed over the layers that draw, so switching an
        // occluding layer off clears it and switching it back on raises it again.
        occlusionNotice: formatOcclusionNotice(
          findOcclusionDeltaOverEnabled(state.template.layers, nextLayers),
        ),
        template: {
          ...state.template,
          layers: nextLayers,
        },
      };
    }
    case "addHtmlElement": {
      const edit = htmlElementEdit(state, action.layerId);
      if (edit === undefined) return state;
      return withHtmlElements(state, edit, [...edit.elements, newHtmlElement(action.kind)]);
    }
    case "removeHtmlElement": {
      const edit = htmlElementEdit(state, action.layerId, action.index);
      if (edit === undefined) return state;
      return withHtmlElements(
        state,
        edit,
        edit.elements.filter((_, index) => index !== action.index),
      );
    }
    case "moveHtmlElement": {
      const edit = htmlElementEdit(state, action.layerId, action.from);
      if (edit === undefined) return state;
      // Both ends, both bounds, and integrality — the `moveLayer` rule: an
      // element moved onto its own index says nothing, and one moved past the
      // end would splice it somewhere no caller asked for.
      if (action.from === action.to) return state;
      if (!isListIndex(action.to, edit.elements.length)) return state;
      const elements = [...edit.elements];
      const [moved] = elements.splice(action.from, 1);
      elements.splice(action.to, 0, moved);
      return withHtmlElements(state, edit, elements);
    }
    case "setHtmlElementText": {
      const edit = htmlElementEdit(state, action.layerId, action.index);
      if (edit === undefined) return state;
      // An `image` element carries no copy — the domain's field table refuses
      // it — so there is no text to set and nothing to write.
      if (edit.elements[action.index]!.kind === "image") return state;
      return withHtmlElements(
        state,
        edit,
        edit.elements.map((element, index) =>
          index === action.index ? { ...element, text: action.text } : element,
        ),
      );
    }
    case "setHtmlElementFrame": {
      const edit = htmlElementEdit(state, action.layerId, action.index);
      if (edit === undefined) return state;
      const element = edit.elements[action.index]!;
      const frame = clampedFrame(action.patch, element.frame);
      // Already the frame asked for: no edit, so no history entry either.
      if (FRAME_FIELDS.every((field) => frame[field] === element.frame[field])) return state;
      return withHtmlElements(
        state,
        edit,
        edit.elements.map((existing, index) =>
          index === action.index ? { ...existing, frame } : existing,
        ),
      );
    }
    case "setHtmlElementStyle": {
      const edit = htmlElementEdit(state, action.layerId, action.index);
      if (edit === undefined) return state;
      const element = edit.elements[action.index]!;
      // An `image` element carries no style — the domain's field table refuses
      // it — so there is nothing to override and nothing to write.
      if (element.kind === "image") return state;
      const style: { fontWeight?: FontWeightKind; fontFamily?: FontFamilyKind } = {
        ...element.style,
      };
      // A field the patch names is written or removed; a field it does not
      // name keeps what the element had — the per-field composition of
      // `setStyle`'s patch, the `setHtmlElementFrame` patch's shape.
      if ("fontWeight" in action.patch) {
        const value = action.patch.fontWeight;
        if (value === undefined) delete style.fontWeight;
        else {
          // The reducer is the contract, the way `setBeatWeight`'s bounds are:
          // a value outside the domain's own vocabulary refuses the whole
          // dispatch, so a hand-restored draft cannot smuggle one in.
          if (!(FONT_WEIGHT_VALUES as readonly number[]).includes(value)) return state;
          style.fontWeight = value;
        }
      }
      if ("fontFamily" in action.patch) {
        const value = action.patch.fontFamily;
        if (value === undefined) delete style.fontFamily;
        else {
          if (!(FONT_FAMILY_VALUES as readonly string[]).includes(value)) return state;
          style.fontFamily = value;
        }
      }
      const overridden = Object.keys(style).length > 0;
      // Already the style asked for — the absent block included: no edit, so
      // no history entry either, the `setHtmlElementFrame` rule.
      if (
        overridden === (element.style !== undefined) &&
        element.style?.fontWeight === style.fontWeight &&
        element.style?.fontFamily === style.fontFamily
      )
        return state;
      return withHtmlElements(
        state,
        edit,
        edit.elements.map((existing, index) => {
          if (index !== action.index) return existing;
          if (overridden) return { ...existing, style };
          // The all-absent block IS the absent key (X16's rule, the same one
          // `withElements` gives an empty list): set-then-clear leaves the
          // element exactly as it loaded, so the round trip is byte-clean.
          const next: Record<string, unknown> = { ...existing };
          delete next.style;
          return next as unknown as HtmlElement;
        }),
      );
    }
    case "addBeat":
      // The domain caps a sequence at MAX_BEATS and the parser refuses more, so the editor
      // must not build a draft it knows Save will reject. A restored draft that already
      // holds more is left intact deliberately — see normalizeDraftState.
      if (state.timeline.beats.length >= MAX_BEATS) return state;
      return {
        ...state,
        nextBeatKey: state.nextBeatKey + 1,
        timeline: {
          ...state.timeline,
          // `text` carries an insert from the approved pool (E5.4); a plain Add starts blank.
          beats: [
            ...state.timeline.beats,
            { key: state.nextBeatKey, text: action.text ?? "", weight: 1 },
          ],
        },
      };
    case "removeBeat": {
      const timeline = removeTimelineBeat(state.timeline, action.index);
      if (timeline.beats.length === state.timeline.beats.length) return state;
      return { ...state, timeline };
    }
    case "moveBeat": {
      // Both ends, both bounds, and integrality. `to` was unchecked: moving beat 0 to index
      // 9 of a three-beat list spliced it onto the end and left keyBeat pointing at 10, a
      // timeline the API rejects on Save.
      const beatCount = state.timeline.beats.length;
      if (
        action.from === action.to ||
        !isBeatIndex(action.from, beatCount) ||
        !isBeatIndex(action.to, beatCount)
      ) {
        return state;
      }
      return {
        ...state,
        timeline: moveTimelineBeat(state.timeline, action.from, action.to),
      };
    }
    case "setBeatText":
      return {
        ...state,
        timeline: {
          ...state.timeline,
          beats: state.timeline.beats.map((beat, index) =>
            index === action.index ? { ...beat, text: action.text } : beat,
          ),
        },
      };
    case "setBeatWeight":
      // The Stepper bounds this, but the reducer is the contract: a weight outside
      // [1, MAX_WEIGHT], or a fraction, serialises straight into a brief the parser
      // refuses. An out-of-range dispatch is a no-op, as the move and remove cases are.
      if (
        !isBeatIndex(action.index, state.timeline.beats.length) ||
        !Number.isInteger(action.weight) ||
        action.weight < 1 ||
        action.weight > MAX_WEIGHT
      ) {
        return state;
      }
      return {
        ...state,
        timeline: {
          ...state.timeline,
          beats: state.timeline.beats.map((beat, index) =>
            index === action.index ? { ...beat, weight: action.weight } : beat,
          ),
        },
      };
    case "setKeyBeat":
      // keyBeat is 1-based and must point at a beat that exists; the action is 0-based.
      if (!isBeatIndex(action.index, state.timeline.beats.length)) return state;
      return {
        ...state,
        timeline: { ...state.timeline, keyBeat: action.index + 1 },
      };
    case "setTransition":
      return {
        ...state,
        timeline: { ...state.timeline, transition: action.transition },
      };
    case "setVariation": {
      // Setting the count by hand answers the notice — it has said its one thing.
      if (action.field === "count") {
        return {
          ...state,
          countNotice: null,
          variation: { ...state.variation, count: action.value },
        };
      }
      return {
        ...state,
        variation: { ...state.variation, [action.field]: action.value },
      };
    }
    case "toggleLayout": {
      // Min-one guard (D6): the last selected value cannot be deselected — the click
      // is a no-op, which deletes the "select at least one" error by construction.
      const layout = toggleOrdered(state.variation.layout, action.value, LAYOUT_OPTIONS);
      if (layout.length === 0) return state;
      return { ...state, variation: { ...state.variation, layout } };
    }
    case "toggleTone": {
      const tone = toggleOrdered(state.variation.tone, action.value, TONE_OPTIONS);
      if (tone.length === 0) return state;
      return { ...state, variation: { ...state.variation, tone } };
    }
    case "toggleAnchor": {
      // Min-one guard (D6): the last selected value cannot be deselected — the click
      // is a no-op, which deletes the "select at least one" error by construction.
      const anchor = toggleOrdered(state.variation.anchor, action.value, ANCHOR_OPTIONS);
      if (anchor.length === 0) return state;
      return {
        ...state,
        variation: { ...state.variation, anchor },
        // Latched, never recomputed. The ratioOverridden discipline does not
        // transfer: for ratio, full-set ≡ absent is lossless, but here absent
        // means "each variant's anchor derives from its own layout" while an
        // explicit top+bottom pair means the planner draws the anchor
        // independently — different variant spaces with layout locked, so
        // recomputing would collapse the user's expressed intent back to the
        // absent key. A toggle on→off therefore leaves a dirty brief that still
        // carries the axis; only an untouched loaded brief (flag from key
        // presence in fromBrief) round-trips byte-identically (D57).
        anchorExplicit: true,
      };
    }
    case "toggleRatio": {
      const nextRatioSelection = toggleOrdered(state.variation.ratio, action.value, RATIO_OPTIONS);
      return {
        ...state,
        variation: { ...state.variation, ratio: nextRatioSelection },
        // Recomputed, not latched. Toggling a ratio off and back on returns the selection
        // to what the platforms derive, and a flag stuck at true would freeze it there —
        // the next platform change would leave the ratios behind, still showing the old
        // platform's shapes.
        ratioOverridden: differsFrom(nextRatioSelection, platformsToRatios(state.platforms)),
      };
    }
    case "toggleBackground": {
      // Same guard as layout and tone. The domain multiplies these axes by their raw
      // length, so an empty one makes a policy that can produce nothing at all.
      const background = toggleOrdered(
        state.variation.background,
        action.value,
        BACKGROUND_OPTIONS,
      );
      if (background.length === 0) return state;
      return { ...state, variation: { ...state.variation, background } };
    }
    case "togglePalette": {
      const paletteShift = toggleOrdered(
        state.variation.paletteShift,
        action.value,
        PALETTE_SHIFT_OPTIONS,
      );
      if (paletteShift.length === 0) return state;
      return { ...state, variation: { ...state.variation, paletteShift } };
    }
    case "toggleHeadline":
      return {
        ...state,
        variation: { ...state.variation, headline: !state.variation.headline },
      };
    case "setStyle": {
      // The domain's own validator is the contract here, the way `setBeatWeight`'s
      // bounds are: a patch that would leave the block outside the Style VO's
      // vocabulary or bounds is a no-op. The Layout step's controls are bounded by
      // the same constants, so nothing the UI can dispatch is refused — but a
      // hand-restored draft cannot smuggle a value through either.
      const merged = { ...state.style, ...action.patch };
      // A patch may set a field to `undefined` — the Effect row's None chip is
      // exactly that (T6) — and the absent key is the block's own spelling of
      // "no effect". Delete rather than park, so the draft's shape always
      // matches what a loaded brief's style holds.
      for (const key of Object.keys(merged) as (keyof Style)[]) {
        if (merged[key] === undefined) delete merged[key];
      }
      if (styleProblem(merged) !== undefined) return state;
      // Latched, like `anchorExplicit`: a control touched this session says "I wrote
      // this key", so returning a value to its default KEEPS the block — an
      // explicit-but-default style round-trips verbatim (D58), and a brief whose
      // style was never touched never grows one.
      return { ...state, style: merged, styleExplicit: true };
    }
    case "toggleMotion": {
      const next = state.motion.includes(action.value)
        ? state.motion.filter((m) => m !== action.value)
        : [...state.motion, action.value];
      return { ...state, motion: next, motionTouched: true };
    }
    case "setDuration": {
      const next = [...state.duration];
      next[action.index] = action.value;
      return { ...state, duration: next, motionTouched: true };
    }
    case "addPhotoOutput": {
      // The remedy offered beside the exclusion warning has to actually remove it, and
      // the warning is raised by `formats` holding motion without static — not by the
      // platform list alone. Toggling a platform did neither reliably: it left the
      // warning standing, and on a brief that already had the photo platform selected it
      // took it away, which is the opposite of what the button says.
      //
      // Idempotent by construction: pressing it twice is pressing it once.
      const formats = state.formats.includes("static")
        ? state.formats
        : [...state.formats, "static"];
      const platforms = state.platforms.some((id) => platformsToFormats([id]).includes("static"))
        ? state.platforms
        : [...state.platforms, PHOTO_PLATFORM];
      return withCountClamp({
        ...state,
        formats,
        platforms,
        formatsOverridden: true,
        outputExplicit: true,
      });
    }
    case "addDuration": {
      // A click lands on a particular second of the reel, and that is the length the user
      // asked for — discarding it and appending "the next free one" quietly adds a
      // different number from the one they pointed at.
      //
      // The planner de-duplicates this axis (`unique(axes.duration)` in
      // VariationPolicy.vo), so a value already present would be an entry that silently
      // does nothing; in that case, and when the caller names no second at all, fall back
      // to the next unused length.
      const asked = action.value;
      const next =
        asked !== undefined && !state.duration.includes(asked)
          ? asked
          : nextFreeDuration(state.duration);
      return next === undefined
        ? state
        : {
            ...state,
            duration: [...state.duration, next],
            motionTouched: true,
          };
    }
    case "removeDuration":
      return {
        ...state,
        duration: state.duration.filter((_, index) => index !== action.index),
        motionTouched: true,
      };
    case "toggleFormat": {
      const nextFormats = state.formats.includes(action.value)
        ? state.formats.filter((f) => f !== action.value)
        : [...state.formats, action.value];

      const videoTurningOn = action.value === "motion" && nextFormats.includes("motion");
      const videoTurningOff = action.value === "motion" && !nextFormats.includes("motion");

      let motion = state.motion;
      let duration = state.duration;
      let motionSeeded = state.motionSeeded;

      // Seeding domain defaults on Video-on (D9):
      // When Video is turned on on a fresh draft with no motion/duration set,
      // seed all motion kinds and 6s duration.
      if (videoTurningOn && motion.length === 0 && duration.length === 0 && !state.motionTouched) {
        motion = [...MOTION_KINDS];
        duration = [DEFAULT_DURATION_SEC];
        motionSeeded = true;
      } else if (videoTurningOff && !state.motionTouched) {
        // Retraction on Video-off while untouched (D9):
        // Retract seeded motion and duration back to empty.
        motion = [];
        duration = [];
        motionSeeded = false;
      }

      // D7/C6: a format toggle never forces an `output` block of its own. `toBrief`
      // writes output when the result actually diverges from the absent-key default
      // (so an on-toggle that adds motion persists it), and omits it when the toggle
      // returns to the default (so toggle-on→off serialises byte-identically — the
      // corpus round-trip is a merge gate). `outputExplicit` is reserved for one
      // thing only: a loaded brief that declared `output`, which must be preserved.
      return {
        ...state,
        formats: nextFormats,
        motion,
        duration,
        motionSeeded,
        // Recomputed for the same reason as the ratio axis: turning Video on and off again
        // leaves the formats equal to what the platforms derive, and latching the flag
        // would stop a later platform change updating them.
        formatsOverridden: differsFrom(nextFormats, platformsToFormats(state.platforms)),
      };
    }
    case "togglePlatform": {
      const nextPlatforms = toggleOrdered(state.platforms, action.value, PLATFORM_ORDER);
      const nextFormats = state.formatsOverridden
        ? state.formats
        : platformsToFormats(nextPlatforms);
      const nextRatio = state.ratioOverridden
        ? state.variation.ratio
        : platformsToRatios(nextPlatforms);
      // `sizes` is authored state, so a toggle edits it rather than re-deriving:
      // adding a display platform contributes the sizes it offers that are not
      // already present (the user's subset survives), removing one drops the
      // sizes no remaining display platform offers. A social-only toggle touches
      // nothing — both branches degenerate to the list that is already there.
      const removing = state.platforms.includes(action.value);
      const nextSizes = removing
        ? state.sizes.filter((size) => platformsToSizes(nextPlatforms).includes(size))
        : orderedDisplaySizes([
            ...state.sizes,
            ...(PLATFORM_PROFILES[action.value]?.sizes ?? []).map((slot) => slot.size),
          ]);

      let motion = state.motion;
      let duration = state.duration;
      let motionSeeded = state.motionSeeded;

      if (!state.formatsOverridden) {
        const videoTurningOn = nextFormats.includes("motion") && !state.formats.includes("motion");
        const videoTurningOff = !nextFormats.includes("motion") && state.formats.includes("motion");
        if (
          videoTurningOn &&
          motion.length === 0 &&
          duration.length === 0 &&
          !state.motionTouched
        ) {
          motion = [...MOTION_KINDS];
          duration = [DEFAULT_DURATION_SEC];
          motionSeeded = true;
        } else if (videoTurningOff && !state.motionTouched) {
          motion = [];
          duration = [];
          motionSeeded = false;
        }
      }

      return {
        ...state,
        platforms: nextPlatforms,
        formats: nextFormats,
        sizes: nextSizes,
        motion,
        duration,
        motionSeeded,
        variation: {
          ...state.variation,
          ratio: nextRatio,
        },
      };
    }
    case "setPool": {
      if (action.briefId !== state.briefId) return state;
      const none = approvedHeadlines(action.pool) === 0;
      return {
        ...state,
        pool: action.pool,
        headlineAxisDropped: none && (state.headlineAxisDropped || state.variation.headline),
        variation: {
          ...state.variation,
          headline: state.variation.headline && !none,
        },
      };
    }
    case "loadPool": {
      if (action.briefId !== state.briefId) return state;
      return {
        ...state,
        pool: action.pool,
      };
    }
    case "load": {
      // Capabilities describe the host, not the brief — a brief switch (including
      // the run-context sync re-adopting the active brief) must not forget them.
      return {
        ...fromBrief(action.brief, action.entry),
        capabilities: state.capabilities,
      };
    }
    case "apply": {
      // Snapshot what was actually applied, not whatever the reducer holds when the
      // dispatch lands. Save & apply awaits the network first, so recomputing here
      // would record edits made during the request as applied when the run has the
      // pre-await brief — the same trap the `save` action carries `saved` for.
      // A server brief may still spell `enabled: true` / `elements: []`; store
      // the canonical form so the dirty check compares like with like (X16).
      return {
        ...state,
        appliedSnapshot: canonicalBrief(action.applied ?? toBrief(state)),
      };
    }
    case "restore":
      // A draft persisted before the probe answered (or by an older editor) carries
      // stale capabilities. Keep the verdict this session already has, or restoring
      // would re-enable motion on a host that has said it cannot produce it.
      return {
        ...action.state,
        capabilities: state.capabilities ?? action.state.capabilities,
      };
    case "save": {
      // Snapshot what was actually persisted, not whatever the reducer holds when the
      // response lands — edits made during the request must stay dirty. The draft
      // itself is never replaced: `save` updates the snapshot and the source's file
      // identity/revision in place, so keystrokes typed while the request was in
      // flight survive (replacing the draft is `load`'s job, and its cost).
      const savedSnapshot = canonicalBrief(action.saved ?? toBrief(state));
      const entry = action.entry;
      if (state.source.kind === "file") {
        const source = { ...state.source, savedSnapshot };
        if (entry !== undefined) {
          source.file = entry.file;
          // An entry that carries no revision never wipes the guard the editor
          // already holds — an absent revision would downgrade the next save to
          // last-write-wins, a fabricated one would satisfy a write that should fail.
          if (entry.revision !== undefined) source.revision = entry.revision;
        }
        return { ...state, source };
      }
      // A first save gains its file identity — the file the server named, so the next
      // save is a conditional PUT rather than another POST.
      return {
        ...state,
        source: {
          kind: "file",
          file: entry?.file ?? `${state.briefId}.yaml`,
          loadedId: state.briefId,
          savedSnapshot,
          revision: entry?.revision,
        },
      };
    }
    case "discard": {
      if (state.source.kind === "file" && state.source.savedSnapshot) {
        return {
          ...fromBrief(state.source.savedSnapshot, {
            file: state.source.file,
            revision: state.source.revision,
          }),
          capabilities: state.capabilities,
        };
      }
      return {
        ...initialEditorState(state.mode),
        capabilities: state.capabilities,
      };
    }
    case "setCapabilities":
      return { ...state, capabilities: action.capabilities };
  }
}

export function approvedHeadlines(pool: CopyPool | null): number {
  return approvedHeadlineTexts(pool).length;
}

/**
 * The approved copy in the pool, as text (E5.4).
 *
 * The shared source the plan asks for. `HeadlinePoolPanel` is wizard-internal and typed to
 * `WizardState`, so there was nothing to reuse — this extracts the one rule that matters
 * ("approved" is the only status a person may insert) so the drawer's count and the
 * timeline's insert list cannot disagree about what is approved.
 *
 * Order is the pool's own, and duplicates are dropped: the same line approved twice is one
 * choice to a person, and offering it twice reads as a bug.
 */
export function approvedHeadlineTexts(pool: CopyPool | null): readonly string[] {
  if (pool === null) return [];
  const texts = pool.entries
    .filter((entry) => entry.status === "approved")
    .map((entry) => entry.text);
  return [...new Set(texts)];
}

function toProduct(draft: ProductDraft): Product {
  const product: Product = {
    id: draft.id,
    name: draft.name,
    primaryColor: draft.primaryColor,
    logoPath: draft.logoPath,
  };
  const inputAsset = draft.inputAsset.trim();
  return inputAsset ? { ...product, inputAsset } : product;
}

function toTreatment(draft: TreatmentDraft): Treatment {
  return {
    id: draft.id,
    layout: draft.layout as Treatment["layout"],
    tone: draft.tone as Treatment["tone"],
  };
}

/**
 * Whether this editor state may carry a serialised `copy.timeline` — the same D5 rule
 * the running parser enforces: a timeline requires motion output (`mode: "variation"`
 * and `output.formats` including motion) and cannot combine with `axes.headline:
 * pool://copy` (motion copy sequences are fixed across variants). The beats themselves
 * are kept in the draft no matter what — toggling Video off or switching to classic
 * merely stops the serialisation, so Save never sends a brief the API would reject and
 * the authored work returns the moment Video does.
 */
export function canSerializeTimeline(state: EditorState): boolean {
  return (
    state.mode === "variation" && state.formats.includes("motion") && !state.variation.headline
  );
}

/**
 * The style block the saved brief will carry (T5): verbatim when the loaded
 * brief declared one (styleExplicit — an explicit-but-default block still says
 * "I wrote this key") or when the draft diverges from the leaf's defaults;
 * undefined otherwise, so a style-less brief never grows one. The one
 * derivation `toBrief` and the preview props share, so the dock can never show
 * a style the brief would not save (D45).
 */
export function briefStyle(state: EditorState): Style | undefined {
  return state.styleExplicit || styleDiverges(state.style) ? { ...state.style } : undefined;
}

/**
 * The formats the saved brief will carry (D99): a classic campaign renders
 * stills only, so motion is omitted whenever `mode === "brief"`, however the
 * draft still holds it. The draft itself is never touched — the D5 round-trip
 * (switch to classic and back) and the remedy ("switch back to Randomized")
 * both need the user's list intact. When dropping motion would empty the list,
 * the projection is `["static"]`: the classic pipeline draws stills, and the
 * API refuses an empty `output.formats`.
 *
 * The one derivation `toBrief` and the preview props share, so the dock can
 * never show a platform the brief would not save (D45).
 */
export function serialisedFormats(state: EditorState): readonly string[] {
  if (state.mode !== "brief") return state.formats;
  const droppedMotion = state.formats.includes("motion");
  const withoutMotion = state.formats.filter((format) => format !== "motion");
  if (droppedMotion && withoutMotion.length === 0) return ["static"];
  return withoutMotion;
}

/**
 * Whether the serialised output equals the absent-key default (static × the
 * static platforms). Shared with the preview so `outputShown` cannot disagree
 * with `toBrief` about whether a platform caption exists (D45/D99).
 */
export function isDefaultOutput(state: EditorState): boolean {
  const formats = serialisedFormats(state);
  return (
    formats.length === 1 &&
    formats[0] === "static" &&
    state.platforms.length === STATIC_PLATFORMS.length &&
    STATIC_PLATFORMS.every((platform) => state.platforms.includes(platform))
  );
}

/**
 * X18: the one parser for the free-typed policy integers (count, seed,
 * minDistance, perProduct, perRatio). A draft means an integer only if it is
 * a plain digit string (optionally signed, optionally with an exponent —
 * `1e5` means 100000, which the validators already accepted); decimal form
 * (`42.0`), trailing garbage (`12abc`) and blank mean nothing and return
 * `undefined`. Validators and `toBrief` share it so the value validation
 * accepts is exactly the value the save writes — previously `Number(value)`
 * on one side and `parseInt(value, 10)` on the other saved `1e5` as `1`.
 */
export function parsePolicyInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || !/^[+-]?\d+(e[+-]?\d+)?$/i.test(trimmed)) return undefined;
  const num = Number(trimmed);
  return Number.isSafeInteger(num) ? num : undefined;
}

/**
 * A beat names a scene of its own only when its `background` is a non-empty string;
 * `""`, a number, a stray field off an unvalidated snapshot — all are the parser's
 * spelling of "no background", and the API refuses anything else on save. The one
 * predicate `fromBrief`, `toBrief` and `normalizeTimelineDraft` share, so the three can
 * never disagree about what a scene is: a bad value repaired on the way in is not written
 * back on the way out, and a value that reaches `toBrief` from a snapshot that skipped
 * repair (`discard` hands `savedSnapshot` straight to `fromBrief`) is dropped rather than
 * serialised into a payload the boundary rejects.
 */
function isNamedBackground(background: unknown): background is string {
  return typeof background === "string" && background !== "";
}

export function toBrief(state: EditorState): CampaignBrief {
  // D99: a classic brief cannot request the motion format — the run paths
  // refuse the combination every time, because the classic product × ratio ×
  // treatment matrix has no motion path. The gate is `mode === "brief"`, not a
  // flip latch: however the draft got here, the brief it serialises carries
  // only what the classic pipeline can actually render, while the draft keeps
  // the user's own list (a flip back to Randomized has it again, unchanged).
  const formats = serialisedFormats(state);
  // Authored state, not a re-derivation: `fromBrief` restores a brief's size
  // subset into `state.sizes`, and deriving from the platforms here would widen
  // a `["728x90"]` request back to the profile's full list on every save — the
  // round-trip the merge gate exists to protect. A selection with no display
  // platform holds an empty list, so a social-only brief still emits no key.
  const sizes = state.sizes;
  // `mode` and `output` are optional in CampaignBrief — absent means the classic
  // static pipeline, which is exactly what a fresh draft holds. Writing them
  // unconditionally grew every classic brief on save (and made a freshly loaded
  // file read as dirty: its snapshot carried no such keys), so they are emitted
  // only when they say something the absent key would not: a variation mode, or
  // an output the loaded brief declared, the user has toggled, or that diverges
  // from the default. Rendering is unaffected either way — the static platforms
  // keep zero insets (D11) — same discipline the ratio axis already follows.
  const style = briefStyle(state);
  const brief: CampaignBrief = {
    schemaVersion: state.schemaVersion,
    // The template is always written (L3a): the domain requires it, and saving
    // must carry the pinned reference + materialised layers back exactly as
    // loaded — the editor never re-derives a template the user may have edited.
    template: state.template,
    id: state.briefId,
    targetRegion: state.targetRegion,
    targetAudience: state.targetAudience,
    campaignMessage: state.campaignMessage,
    products: state.products.map(toProduct),
    // The brief's style (T5) applies in both modes; emitted only when it says
    // something the absent key does not (see briefStyle).
    ...(style !== undefined ? { style } : {}),
    ...(state.mode === "variation" || state.modeExplicit ? { mode: state.mode } : {}),
    // D112 — `type` follows `mode`'s rule one line above: absent means
    // social-post, so a draft still on the default never grows the key (the
    // corpus round-trip and the freshly-loaded-clean check depend on it),
    // while a non-default type or an explicitly spelled default is written.
    ...(state.type !== DEFAULT_CAMPAIGN_TYPE || state.typeExplicit ? { type: state.type } : {}),
    ...(state.outputExplicit || !isDefaultOutput(state)
      ? {
          output: {
            formats: [...formats],
            platforms: [...state.platforms],
            // The authored size subset (see above); a social-only selection
            // holds none, so the key is omitted exactly as before (D116).
            ...(sizes.length > 0 ? { sizes: [...sizes] } : {}),
          },
        }
      : {}),
  };
  const localized = state.localizedMessage.trim();
  const withLocalized = localized ? { ...brief, localizedMessage: localized } : brief;
  // Sequenced copy for motion clips (E5). The block is written only when the state may
  // carry one — the D5 gate `canSerializeTimeline` mirrors the parser's — and only when
  // beats exist: an empty list is "no timeline", and a loaded brief with no `copy` block
  // must not grow one. `copyExplicit` is the lone exemption, preserving a declared-but-
  // empty `copy: {}` a loaded file wrote (D11), exactly as `outputExplicit` preserves
  // `output`. When the beats are present the whole timeline is written, including its
  // defaults — `transition` and `keyBeat` are required by the domain, so a loaded brief
  // keeps them and an authored one always states them.
  const timeline =
    canSerializeTimeline(state) && state.timeline.beats.length > 0
      ? {
          beats: state.timeline.beats.map((beat) => ({
            text: beat.text,
            weight: beat.weight,
            // VE5a: written back only when the beat names a real scene — a draft that
            // never had one, or one repaired to `""`/a non-string, must serialise exactly
            // as it did without the field, and never a value the boundary refuses (D3).
            ...(isNamedBackground(beat.background) ? { background: beat.background } : {}),
          })),
          transition: state.timeline.transition,
          keyBeat: state.timeline.keyBeat,
        }
      : undefined;
  const copy =
    timeline !== undefined || state.copyExplicit
      ? { ...(timeline !== undefined ? { timeline } : {}) }
      : undefined;
  const withCopy = copy !== undefined ? { ...withLocalized, copy } : withLocalized;
  const destination = state.clickDestination.trim();
  // VE3a (D11): the music bed's licence record is carried through untouched —
  // no control in this lane authors or clears it, so a present block is
  // written back verbatim and an absent one never grows the key. The API
  // boundary re-validates the rights fields on save, not the editor.
  const audio = state.audio !== undefined ? { audio: state.audio } : {};
  if (state.mode === "brief") {
    const withTreatments =
      state.treatments.length > 0
        ? { ...withCopy, treatments: state.treatments.map(toTreatment) }
        : withCopy;
    const withAudio = { ...withTreatments, ...audio };
    return destination ? { ...withAudio, clickDestination: destination } : withAudio;
  }
  // X18: every policy integer goes through the validator's own parser, so a
  // draft that passes validation saves exactly the number it was validated as.
  const count = parsePolicyInteger(state.variation.count) ?? 0;
  const seed = parsePolicyInteger(state.variation.seed);
  const minDistance = parsePolicyInteger(state.variation.minDistance);
  const perProduct = parsePolicyInteger(state.variation.perProduct);
  const perRatio = parsePolicyInteger(state.variation.perRatio);
  // Build the object first and drop it when nothing survives: blank inputs parse to
  // undefined, which is neither > 0 nor === 0, and would otherwise emit an empty
  // `coverage: {}`.
  const coverageFields = {
    ...(perProduct !== undefined && perProduct > 0 ? { perProduct } : {}),
    ...(perRatio !== undefined && perRatio > 0 ? { perRatio } : {}),
  };
  const coverage =
    Object.keys(coverageFields).length > 0
      ? (coverageFields as VariationPolicy["coverage"])
      : undefined;
  const axes = {
    layout: [...state.variation.layout],
    tone: [...state.variation.tone],
    // The anchor axis (T4) is written only when it says something the absent key
    // does not: the absent axis derives top/bottom from `layout`, so a selection
    // equal to that derived pair round-trips an anchor-less brief key-free and
    // hash-identical (D57) — the ratio axis' convention, not layout/tone's,
    // because this axis' absence is NOT its full vocabulary. A declared
    // `anchorExplicit` selection is preserved even when it equals the pair.
    ...(anchorAxisActive(state) ? { anchor: [...state.variation.anchor] } : {}),
    // The ratio axis is written only when it constrains: absent means every
    // ratio, so a full selection round-trips a brief without the key
    // byte-identically instead of growing a redundant `ratio: [all]`.
    ...(state.variation.ratio.length < RATIO_OPTIONS.length
      ? { ratio: [...state.variation.ratio] }
      : {}),
    background: { source: [...state.variation.background] },
    paletteShift: [...state.variation.paletteShift],
    ...(state.variation.headline ? { headline: HEADLINE_POOL_REF } : {}),
    // D12: a loaded motion brief keeps its motion fields verbatim even on a host with
    // no controls for them, so saving never strips what the file already declared.
    ...(state.motion.length > 0 ? { motion: [...state.motion] } : {}),
    ...(state.duration.length > 0 ? { duration: [...state.duration] } : {}),
  };
  return {
    ...withLocalized,
    variation: {
      count,
      ...(seed !== undefined ? { seed } : {}),
      ...(minDistance !== undefined ? { minDistance } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      axes,
    },
    ...(copy !== undefined ? { copy } : {}),
    ...(destination ? { clickDestination: destination } : {}),
    ...audio,
  };
}

/**
 * An array-valued input, or `fallback` when it is anything else. Shared by the
 * two places untyped JSON becomes an EditorState — `fromBrief` (a brief from
 * disk or the API) and `normalizeDraftState` (a draft from localStorage) — so
 * every reducer that calls `.filter`/`.includes` on a list can trust it is one.
 */
const list = <T>(value: unknown, fallback: T[]): T[] =>
  Array.isArray(value) ? [...(value as T[])] : fallback;

export function fromBrief(
  brief: CampaignBrief,
  entry?: { file: string; revision?: string },
): EditorState {
  // X16: a hand-authored `enabled: true` or `elements: []` is the same as
  // absence. X17: a YAML empty scalar is null at the boundary (D68); the
  // snapshot maps those to the form `toBrief` writes (`""` or omitted), so
  // a freshly loaded file is not dirty. Canonicalise once so the draft and
  // the snapshot share that form.
  const canonical = canonicalBrief(brief);
  const tempId = generateTempId();
  const source: EditorSource = entry
    ? {
        kind: "file",
        file: entry.file,
        loadedId: canonical.id,
        savedSnapshot: canonical,
        revision: entry.revision,
      }
    : { kind: "new", tempId };
  // A stored snapshot reaches discard unvalidated: `products` can be absent,
  // null, or a non-array, and an entry can be null. `list` proves an array,
  // and an unusable entry is treated as an empty object, so recovery and
  // discard never dereference what they cannot read.
  const rawProducts = list<Product>(brief.products, []);
  const products =
    rawProducts.length > 0
      ? rawProducts.map((p, i) => {
          const product = p !== null && typeof p === "object" ? p : ({} as Product);
          return {
            ...emptyProduct(i + 1, product.primaryColor),
            ...product,
            id: product.id ?? "",
            name: product.name ?? "",
            primaryColor: product.primaryColor ?? "",
            logoPath: product.logoPath ?? "",
            inputAsset: product.inputAsset ?? "",
            idTouched: true,
          };
        })
      : [emptyProduct(1)];
  const nextProductKey = rawProducts.length > 0 ? rawProducts.length + 1 : 2;
  const treatments =
    brief.treatments?.map((t) => ({
      id: t.id,
      layout: t.layout,
      tone: t.tone,
    })) ?? [];
  const formats = [...(brief.output?.formats ?? ["static"])];
  const platforms = [...(brief.output?.platforms ?? [...STATIC_PLATFORMS])];
  // The brief's size subset is authored state (D116): absent means the union of
  // the selected display profiles' sizes — the pre-state derivation, unchanged
  // for social-only and un-narrowed briefs — while a present list (possibly a
  // single `["728x90"]`) is restored verbatim, so a load→save round-trip
  // preserves exactly what the file asked for.
  // Carry the persisted variation policy back into the draft. Defaulting these would
  // silently rewrite a randomized brief's policy the first time it was saved, even
  // though E1 renders no controls for them yet (they arrive in E2.2 / E2.3).
  const variation = brief.variation;
  const axes = variation?.axes as Record<string, unknown> | undefined;
  const num = (value: unknown): string => (typeof value === "number" ? String(value) : "");
  const coverage = variation?.coverage as { perProduct?: number; perRatio?: number } | undefined;
  const derivedFormats = platformsToFormats(platforms);
  const sizes =
    brief.output?.sizes !== undefined ? [...brief.output.sizes] : platformsToSizes(platforms);
  // One comparison for both paths. This used to be an inline set test while the draft
  // path used `differsFrom`, so the same brief got a different verdict depending on
  // whether it arrived from disk or from a restored draft — and the load path, the one
  // that reads other people's briefs, was the lenient of the two.
  const storedFormats = brief.output?.formats;
  const formatsOverridden =
    storedFormats !== undefined && differsFrom(storedFormats, derivedFormats);

  const derivedRatios = platformsToRatios(platforms);
  const storedRatios =
    axes?.ratio !== undefined ? list(axes.ratio, [...RATIO_OPTIONS]) : [...RATIO_OPTIONS];
  const ratioOverridden = differsFrom(storedRatios, derivedRatios);

  const motionList = list(axes?.motion, []);
  const durationList = list(axes?.duration, []);
  const motionTouched = motionList.length > 0 || durationList.length > 0;

  // E5: a load keeps a declared timeline — and a declared-but-empty `copy` block — so
  // saving cannot silently strip what a file already wrote (D11), the same reason the
  // output block is preserved above. The parser defaults `transition`/`keyBeat` onto
  // every accepted timeline, and requires non-empty beats, so the draft below is always
  // structurally sound; the text/weight values are copied verbatim, never trimmed.
  const copyTimeline = brief.copy?.timeline;
  const timeline: TimelineDraft = copyTimeline
    ? {
        beats: copyTimeline.beats.map((beat, index) => ({
          key: index + 1,
          text: beat.text,
          weight: beat.weight,
          // A restored `savedSnapshot` reaches here unvalidated (discard): repair the
          // scene to the parser's spelling on the way in, exactly as the draft
          // normaliser does, so a `""` or a non-string never survives to a save.
          ...(isNamedBackground(beat.background) ? { background: beat.background } : {}),
        })),
        transition: copyTimeline.transition,
        keyBeat: copyTimeline.keyBeat,
      }
    : { beats: [], transition: "fade", keyBeat: 1 };

  return {
    schemaVersion: brief.schemaVersion,
    source,
    nextBeatKey: timeline.beats.length + 1,
    mode: brief.mode ?? "brief",
    // D112 — absent means the default; a brief that wrote the default
    // explicitly keeps its marker, the way `mode`'s own flag does below.
    type: brief.type ?? DEFAULT_CAMPAIGN_TYPE,
    // The brief's template is held after X16 canonicalisation (L3a): `toBrief`
    // writes it back so a load → save never drops or re-derives the pinned
    // reference. `enabled: true` and `elements: []` are absence, not edits.
    template: canonical.template,
    campaignName: brief.id,
    briefId: brief.id,
    targetRegion: brief.targetRegion ?? "",
    targetAudience: brief.targetAudience ?? "",
    campaignMessage: brief.campaignMessage ?? "",
    localizedMessage: brief.localizedMessage ?? "",
    clickDestination: brief.clickDestination ?? "",
    // VE3a (D11, fix3): the licence record is copied across untouched when it
    // satisfies the domain's full audio contract (`isAudio`) — `toBrief`
    // writes it back, so a load → save never drops a valid record, and
    // `discard` re-runs this path against the (unvalidated) saved snapshot
    // with the same result. A record short of the contract is dropped here
    // rather than carried into a save `parseBrief` would refuse with no
    // control to repair or clear it.
    ...(isAudio(brief.audio) ? { audio: brief.audio } : {}),
    products,
    nextProductKey,
    treatments,
    timeline,
    copyExplicit: brief.copy !== undefined,
    anchorExplicit: axes?.anchor !== undefined,
    // A declared style block is kept verbatim (D58 — a save never strips what
    // a file wrote); its absence is the absence of the key.
    style: brief.style ?? {},
    styleExplicit: brief.style !== undefined,
    variation: {
      count: variation ? String(variation.count) : "12",
      seed: num(variation?.seed),
      minDistance:
        variation?.minDistance === undefined
          ? variation
            ? ""
            : "2"
          : String(variation.minDistance),
      perProduct: coverage ? num(coverage.perProduct) : variation ? "" : "1",
      perRatio: coverage ? num(coverage.perRatio) : variation ? "" : "1",
      layout: list(axes?.layout, [...LAYOUT_OPTIONS]),
      tone: list(axes?.tone, [...TONE_OPTIONS]),
      anchor: list(axes?.anchor, [...DERIVED_ANCHOR_OPTIONS]),
      ratio: storedRatios,
      background: list((axes?.background as { source?: unknown } | undefined)?.source, [
        ...DEFAULT_BACKGROUND_SOURCES,
      ]),
      paletteShift: list(axes?.paletteShift, [...PALETTE_SHIFT_OPTIONS]),
      headline: axes?.headline === HEADLINE_POOL_REF,
    },
    motion: motionList,
    duration: durationList,
    formats,
    platforms,
    sizes,
    outputExplicit: brief.output !== undefined,
    modeExplicit: brief.mode === "brief",
    typeExplicit: brief.type === DEFAULT_CAMPAIGN_TYPE,
    formatsOverridden,
    ratioOverridden,
    motionTouched,
    motionSeeded: false,
    pool: null,
    headlineAxisDropped: false,
    countNotice: null,
    occlusionNotice: null,
    appliedSnapshot: null,
    capabilities: null,
  };
}

/**
 * True when the draft still matches a freshly-opened editor in the same mode. A new
 * source counts as dirty by definition, so this is what "has the user actually typed
 * anything?" has to ask before prompting or auto-saving.
 */
export function isPristine(state: EditorState): boolean {
  // `campaignName` is not part of the brief — only its slug is, as `id`. So a name made
  // entirely of characters the slug strips ("!!!") leaves the brief identical to a blank
  // one, and comparing briefs alone would call that pristine: the draft would never be
  // autosaved and leaving would not prompt, so the typed name would vanish without a word.
  if (state.campaignName !== initialEditorState(state.mode).campaignName) return false;
  return JSON.stringify(toBrief(state)) === JSON.stringify(toBrief(initialEditorState(state.mode)));
}

/**
 * Deep equality **by value**, not by serialised key order. `JSON.stringify`
 * is key-order sensitive: a snapshot holds the brief in the order the file wrote
 * it while `toBrief` emits its own fixed order, so comparing the two as strings
 * read every freshly loaded file as dirty the instant it opened. Keys carry no
 * meaning; values do.
 *
 * Both sides are canonicalised (object keys sorted recursively) before
 * stringifying, which sidesteps the `undefined` trap too: `JSON.stringify` drops
 * `undefined`-valued keys on both sides, so `{ a: 1 }` and `{ a: 1, b: undefined }`
 * still compare equal — same discipline as `canonicalJson` in `VariationPolicy`.
 * Arrays are mapped element-wise, never sorted: `products`, `treatments`,
 * `variation.axes.*` and `copy.timeline.beats` are order-carrying, and a swapped
 * pair must stay a real difference.
 *
 * The shape is not limited to briefs: the draft-recovery check in BriefEditor
 * compares whole editor states with it, and a second comparison that disagreed
 * with this one is exactly the drift class the key-order bug came from. Editor
 * states are JSON-able (strings, numbers, booleans, arrays, plain objects,
 * `null`) so the same canonicalisation applies unchanged.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalKeys(a)) === JSON.stringify(canonicalKeys(b));
}

function canonicalKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalKeys(source[key]);
    return sorted;
  }
  return value;
}

export function isDirtySinceSave(state: EditorState): boolean {
  if (state.source.kind === "new") return true;
  if (!state.source.savedSnapshot) return true;
  return !valuesEqual(toBrief(state), state.source.savedSnapshot);
}

export function isDirtySinceApply(state: EditorState): boolean {
  if (!state.appliedSnapshot) return true;
  return !valuesEqual(toBrief(state), state.appliedSnapshot);
}

export function draftKeyFor(id: string): string {
  return `cf:draft:${id}`;
}

export function getDraftKey(state: EditorState): string {
  const id = state.source.kind === "file" ? state.source.loadedId : state.source.tempId;
  return draftKeyFor(id);
}

/**
 * The empty brief — what "no campaign" is, for both the editor and the shell. A blank
 * `id` is the marker: nothing can be saved, listed or run under it.
 */
export function blankBrief(): CampaignBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id: "",
    targetRegion: "",
    targetAudience: "",
    campaignMessage: "",
    products: [],
  };
}

export function saveDraftToStorage(state: EditorState): void {
  if (typeof localStorage === "undefined") return;
  const key = getDraftKey(state);
  const draft = { state, timestamp: Date.now() };
  localStorage.setItem(key, JSON.stringify(draft));
}

export function loadDraftFromStorage(state: EditorState): EditorState | null {
  if (typeof localStorage === "undefined") return null;
  const key = getDraftKey(state);
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as { state?: unknown };
    if (typeof draft.state !== "object" || draft.state === null) return null;
    return normalizeDraftState(draft.state as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * W3 (F19): whether the blank route's stored draft holds real work. H6 gives every
 * unnamed editor the one stable key, so `cf:draft:new` survives the unmount — and
 * the autosave effect writes only non-pristine states there, so a draft still on
 * disk while no editor is mounted is exactly the abandoned work the D11 recovery
 * exists to keep. The create dialog reads this before publishing a seed, which
 * would otherwise overwrite the draft silently.
 *
 * Read-only by contract: nothing is written, cleared or purged, and the
 * normalisation happens on the in-memory read only, exactly as in
 * `loadDraftFromStorage` — a malformed entry answers false, never throws.
 */
export function hasRecoverableDraft(): boolean {
  const draft = loadDraftFromStorage(initialEditorState());
  return draft !== null && !isPristine(draft);
}

/**
 * Rebuilds a persisted draft over the EditorState shape THIS build expects, so
 * a draft an older build wrote — missing a field this build reads
 * unconditionally — restores instead of crashing render. `restore`'s own
 * comment already named the hazard ("a draft persisted... by an older editor")
 * but only ever patched `capabilities`; #85 added `variation.ratio` and nothing
 * filled the gap, so `toBrief`'s `state.variation.ratio.length` threw on mount
 * for every session with a pre-#85 draft, before `purgeDraftFromStorage` ever
 * ran — the stale draft survived reload and only `localStorage.clear()`
 * recovered.
 *
 * Same rigor as `fromBrief`, its sibling deserializer: every list a reducer
 * calls array methods on goes through `list()`, every enum is checked against
 * its legal values, and what the draft actually set still wins — this fills
 * gaps and repairs wrong-typed fields, it never discards a valid value (D11's
 * whole reason for existing). Each repaired key is re-asserted explicitly
 * after the `...raw` spread; a key left to the spread keeps the draft's value
 * even when that value is wrong, which is exactly how the first cut of this
 * function let an invalid `mode` through.
 *
 * `initialEditorState` mints the stable draft key and two product keys that are usually
 * discarded here. `fromBrief` does the same on every load; a fresh identity is
 * the only correct fallback for a draft that lost its own, and a burnt counter
 * value costs nothing — product keys need only be unique.
 */
/**
 * Whether a stored list says something other than what the platforms would derive.
 *
 * Order-sensitive, deliberately. A set comparison would call `["motion", "static"]` equal
 * to the derived `["static", "motion"]` and so not overridden — and the next platform
 * toggle would then replace it with the canonical order, changing the serialised
 * `output.formats` of a brief nobody edited. The corpus round-trip is a merge gate, and
 * "same values, different order" is not the same bytes.
 */
function differsFrom(stored: readonly string[], derived: readonly string[]): boolean {
  return (
    stored.length !== derived.length || stored.some((value, index) => value !== derived[index])
  );
}

/**
 * Rebuilds a persisted `timeline` over the shape this build expects, with the same
 * repair-first, discard-only-when-unusable rigor as the rest of `normalizeDraftState`:
 * a beat that is not an object, a weight outside [1, MAX_WEIGHT], a non-"cut"/"fade"
 * transition and an out-of-range `keyBeat` are repaired rather than trusted — but a
 * `keyBeat` cannot be repaired past `beats.length`, and with the list empty the field
 * has no valid value at all and is reset to its never-serialised sentinel 1.
 */
function normalizeTimelineDraft(value: unknown): TimelineDraft {
  const rawTimeline =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  // The key is never serialised, so a restored draft has none: mint by position. That is
  // safe precisely because the list has just been read whole — no reorder has happened yet.
  const beats: TimelineBeatDraft[] = (
    Array.isArray(rawTimeline?.beats) ? rawTimeline.beats : []
  ).map((entry, index) => {
    if (typeof entry !== "object" || entry === null) return { key: index + 1, text: "", weight: 1 };
    const beat = entry as Partial<TimelineBeatDraft>;
    const weight =
      typeof beat.weight === "number" &&
      Number.isInteger(beat.weight) &&
      beat.weight >= 1 &&
      beat.weight <= MAX_WEIGHT
        ? beat.weight
        : 1;
    return {
      key: index + 1,
      text: typeof beat.text === "string" ? beat.text : "",
      weight,
      // A restored draft keeps its scenes (D11); anything that is not a non-empty
      // string is repaired to "no scene of its own", the parser's spelling — the same
      // predicate `fromBrief` and `toBrief` use, so the three can never disagree.
      ...(isNamedBackground(beat.background) ? { background: beat.background } : {}),
    };
  });
  const transition =
    rawTimeline !== null && (rawTimeline.transition === "cut" || rawTimeline.transition === "fade")
      ? rawTimeline.transition
      : "fade";
  const storedKeyBeat =
    rawTimeline !== null &&
    typeof rawTimeline.keyBeat === "number" &&
    Number.isInteger(rawTimeline.keyBeat)
      ? rawTimeline.keyBeat
      : 1;
  const keyBeat = beats.length === 0 ? 1 : Math.min(Math.max(1, storedKeyBeat), beats.length);
  return { beats, transition, keyBeat };
}

/**
 * Rebuild a persisted `style` block over the shape this build expects, with the
 * same repair-first, discard-only-when-unusable rigor as the sibling
 * normalizers: each element is checked against the domain leaf's vocabulary and
 * bounds, and an out-of-vocabulary or out-of-bounds value is dropped rather
 * than dereferenced or serialised — a hand-edited draft cannot smuggle a style
 * the parser would refuse.
 */
function normalizeStyleDraft(value: unknown): Style {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const style: {
    -readonly [K in keyof Style]: Style[K];
  } = {};
  if (
    typeof raw.fontFamily === "string" &&
    (FONT_FAMILY_VALUES as readonly string[]).includes(raw.fontFamily)
  ) {
    style.fontFamily = raw.fontFamily as Style["fontFamily"];
  }
  if (
    typeof raw.fontWeight === "number" &&
    (FONT_WEIGHT_VALUES as readonly number[]).includes(raw.fontWeight)
  ) {
    style.fontWeight = raw.fontWeight as Style["fontWeight"];
  }
  if (
    typeof raw.sizeScale === "number" &&
    Number.isFinite(raw.sizeScale) &&
    raw.sizeScale >= MIN_SIZE_SCALE &&
    raw.sizeScale <= MAX_SIZE_SCALE
  ) {
    style.sizeScale = raw.sizeScale;
  }
  if (
    typeof raw.lineHeight === "number" &&
    Number.isFinite(raw.lineHeight) &&
    raw.lineHeight >= MIN_LINE_HEIGHT &&
    raw.lineHeight <= MAX_LINE_HEIGHT
  ) {
    style.lineHeight = raw.lineHeight;
  }
  if (
    typeof raw.letterSpacing === "number" &&
    Number.isFinite(raw.letterSpacing) &&
    raw.letterSpacing >= MIN_LETTER_SPACING &&
    raw.letterSpacing <= MAX_LETTER_SPACING
  ) {
    style.letterSpacing = raw.letterSpacing;
  }
  if (typeof raw.align === "string" && (ALIGN_VALUES as readonly string[]).includes(raw.align)) {
    style.align = raw.align as Style["align"];
  }
  if (
    typeof raw.textEffect === "string" &&
    (TEXT_EFFECT_VALUES as readonly string[]).includes(raw.textEffect)
  ) {
    style.textEffect = raw.textEffect as Style["textEffect"];
  }
  return style;
}

/**
 * Rebuild a persisted `audio` block with the same repair-first,
 * discard-only-when-unusable rigor as the sibling normalizers: a stored value
 * survives only when it satisfies the domain's FULL audio contract —
 * `isAudio` (VE-D8 fix3) — never dereferenced when it does not, so recovery
 * must not throw on a hand-edited draft (the X16/X17 lesson). Anything short
 * of that contract (empty rights, a missing `licenceId`, an unknown key, an
 * impossible `expiresOn`) is dropped rather than carried through: a record
 * `parseBrief` would refuse must not reach a save the editor offers no control
 * to repair or clear.
 */
function normalizeAudioDraft(value: unknown): CampaignBrief["audio"] {
  return isAudio(value) ? (value as CampaignBrief["audio"]) : undefined;
}

export function normalizeDraftState(raw: Record<string, unknown>): EditorState {
  const mode: CampaignMode = raw.mode === "variation" ? "variation" : "brief";
  // D112 — a draft saved before the type existed carries no `type`, and a
  // hand-edited one may carry anything: the enum is checked against its legal
  // vocabulary, never believed, and the absent key means the default.
  const typeValid = (CAMPAIGN_TYPES as readonly string[]).includes(raw.type as string);
  const type: CampaignType = typeValid ? (raw.type as CampaignType) : DEFAULT_CAMPAIGN_TYPE;
  // L3a — a draft saved before the template became required writes no key: it
  // normalises to the campaign type's canonical template, exactly what a fresh
  // draft and an applied preset seed. A draft that does carry one is held
  // verbatim — the template is authored data the editor must never re-derive —
  // but only after the full shape guard: anything that is not a non-null,
  // non-array object whose five fields are each legal (`id` a canonical member,
  // `version` a positive integer, `creativeType` and `unit` vocabulary members,
  // `layers` an array) is a corrupt draft and takes the canonical fallback
  // silently, so a user reopening a damaged draft gets a working editor, not a
  // brief the API refuses. `isBriefTemplate` is the one contract here, shared
  // with the persisted-brief guard. It checks shape, never content: a valid
  // template keeps any layer order it was saved with.
  const rawTemplate = raw.template;
  const template: BriefTemplate = isBriefTemplate(rawTemplate)
    ? canonicalTemplate(rawTemplate)
    : templateFromCanonical(type);
  const initial = initialEditorState(mode);
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" ? value : fallback;
  const rawSource = raw.source as Partial<EditorSource> | null | undefined;
  const resolvedSource: EditorSource =
    rawSource !== null &&
    typeof rawSource === "object" &&
    (rawSource.kind === "new" || rawSource.kind === "file")
      ? (rawSource as EditorSource)
      : initial.source;
  // A draft persisted before X16 may still carry a raw `enabled: true` /
  // `elements: []` snapshot. Canonicalise it so recovery does not restore a
  // "difference" that is only the default spelled out, and so a restored
  // draft is not dirty against its own snapshot. canonicalBrief itself
  // leaves a template it does not recognise unchanged, so a corrupt
  // snapshot is kept verbatim rather than throwing.
  const source: EditorSource =
    resolvedSource.kind === "file" && resolvedSource.savedSnapshot
      ? {
          ...resolvedSource,
          savedSnapshot: canonicalBrief(resolvedSource.savedSnapshot),
        }
      : resolvedSource;
  const v = (
    typeof raw.variation === "object" && raw.variation !== null ? raw.variation : {}
  ) as Record<string, unknown>;
  // `list` proves an array, not its members: a hand-edited draft's `anchor:
  // ["diagonal"]` (the #169 `[null]` pattern) would otherwise ride the
  // `as AnchorOption` cast preview-props makes into CreativePreview's leaf
  // lookups. Only the axis' own vocabulary survives, and min-one holds — a
  // filter that empties falls back to the pair the absent axis behaves as.
  const anchorSelection = list(v.anchor, initial.variation.anchor).filter((value) =>
    ANCHOR_OPTIONS.includes(value),
  );
  const anchor = anchorSelection.length > 0 ? anchorSelection : [...initial.variation.anchor];
  const variation: EditorState["variation"] = {
    count: str(v.count, initial.variation.count),
    seed: str(v.seed, initial.variation.seed),
    minDistance: str(v.minDistance, initial.variation.minDistance),
    perProduct: str(v.perProduct, initial.variation.perProduct),
    perRatio: str(v.perRatio, initial.variation.perRatio),
    layout: list(v.layout, initial.variation.layout),
    tone: list(v.tone, initial.variation.tone),
    anchor,
    ratio: list(v.ratio, initial.variation.ratio),
    background: list(v.background, initial.variation.background),
    paletteShift: list(v.paletteShift, initial.variation.paletteShift),
    headline: typeof v.headline === "boolean" ? v.headline : initial.variation.headline,
  };
  // A persisted array can hold anything: `list` only proves it is an array, so an
  // entry that is not a usable object (a `null` from a hand-edited draft, a bare
  // string) is replaced rather than dereferenced — reading `.key` off it would
  // throw inside the loader's try/catch and silently discard the whole draft,
  // losing every recovered edit D11 exists to keep.
  const products = (list(raw.products, initial.products) as unknown[]).map((entry, i) => {
    if (typeof entry !== "object" || entry === null) return emptyProduct(i + 1);
    const draft = entry as ProductDraft;
    return typeof draft.key === "number" && draft.key > 0 ? draft : { ...draft, key: i + 1 };
  });
  const storedNextProductKey =
    typeof raw.nextProductKey === "number" && raw.nextProductKey > 0
      ? raw.nextProductKey
      : undefined;
  // A stored counter is trusted only above the keys it must outlive: a stale one
  // (≤ an existing key) would make addProduct mint a duplicate and removeProduct
  // delete two products — the very collision D16 exists to prevent. A counter
  // burned past the keys still wins; product keys only need to be unique.
  const nextProductKey = Math.max(storedNextProductKey ?? 0, nextKeyAfter(products));
  const campaignName = str(raw.campaignName, typeof raw.briefId === "string" ? raw.briefId : "");
  const motion = list(raw.motion, initial.motion);
  const duration = list(raw.duration, initial.duration);
  const formats = list(raw.formats, initial.formats);
  const platforms = list(raw.platforms, initial.platforms);
  // A draft saved before `sizes` became state wrote no field: the union of the
  // selected display profiles' sizes is exactly what the old derivation would
  // have serialised, so it is the default. A stored list is filtered to the
  // vocabulary — `list` only proves it is an array, and a hand-edited entry is
  // dropped rather than dereferenced or serialised — while a present list is
  // otherwise believed, subset included.
  const normalizedTimeline = normalizeTimelineDraft(raw.timeline);
  const style = normalizeStyleDraft(raw.style);
  const schemaVersion = isSupportedBriefSchemaVersion(raw.schemaVersion)
    ? raw.schemaVersion
    : BRIEF_SCHEMA_VERSION;

  return {
    ...initial,
    ...raw,
    schemaVersion,
    source,
    mode,
    type,
    template,
    campaignName,
    briefId: str(raw.briefId, initial.briefId),
    clickDestination: str(raw.clickDestination, initial.clickDestination),
    // Re-asserted, not left to the `...raw` spread: a draft that smuggled a
    // malformed audio through the spread must have it dropped here, and a
    // well-formed one is kept verbatim (reference, not copy).
    audio: normalizeAudioDraft(raw.audio),
    products,
    nextProductKey,
    treatments: list(raw.treatments, initial.treatments),
    timeline: normalizedTimeline,
    // Keys are minted by position in normalizeTimelineDraft, so the counter starts past them.
    nextBeatKey: normalizedTimeline.beats.length + 1,
    copyExplicit: raw.copyExplicit === true,
    // A pre-T4 draft wrote no anchor at all: inferred from the data like the
    // sibling overrides — a selection that diverges from the derived pair was
    // authored, whatever the flag says; a declared one is believed.
    anchorExplicit:
      raw.anchorExplicit === undefined
        ? !isDerivedAnchorSelection(variation.anchor)
        : raw.anchorExplicit === true,
    style,
    // A pre-T5 draft wrote neither key: inferred from the data like the sibling
    // overrides — a block that diverges from the defaults was authored, a
    // declared flag is believed.
    styleExplicit:
      raw.styleExplicit === undefined ? styleDiverges(style) : raw.styleExplicit === true,
    variation,
    motion,
    duration,
    formats,
    platforms,
    sizes: list(raw.sizes, platformsToSizes(platforms)).filter((size) =>
      (DISPLAY_SIZE_VALUES as readonly string[]).includes(size),
    ),
    outputExplicit: raw.outputExplicit === true,
    // Unlike the flags below, `=== true` is right for a legacy draft: the mode itself
    // survives in `mode`, and losing the marker only omits a key whose absence means
    // exactly what its value said. No authored work is lost.
    modeExplicit: raw.modeExplicit === true,
    // An unknown stored type is the default, not an authored one: believing
    // `typeExplicit` anyway would serialise an explicit `social-post` for a
    // draft that never wrote that type.
    typeExplicit: typeValid && raw.typeExplicit === true,
    // A draft written before these flags existed has none of them, and `=== true` would
    // read that absence as "never overridden". It is not the same statement: the draft
    // may well hold formats, ratios or motion the user authored by hand. Restoring those
    // as platform-derived means the next platform toggle overwrites them, and turning
    // Video off retracts motion kinds the user chose — silent loss of authored work, in a
    // draft whose whole purpose is to not lose it.
    //
    // So an absent flag is inferred from the data, exactly as `fromBrief` infers it when
    // loading a brief from disk; a flag that is present is believed.
    formatsOverridden:
      raw.formatsOverridden === undefined
        ? differsFrom(formats, platformsToFormats(platforms))
        : raw.formatsOverridden === true,
    ratioOverridden:
      raw.ratioOverridden === undefined
        ? differsFrom(variation.ratio, platformsToRatios(platforms))
        : raw.ratioOverridden === true,
    motionTouched:
      raw.motionTouched === undefined
        ? motion.length > 0 || duration.length > 0
        : raw.motionTouched === true,
    motionSeeded: raw.motionSeeded === true,
    // The count notice is one-time UI, not part of the draft it describes.
    countNotice: null,
    // The occlusion notice is derived UI from reposition, not persisted state.
    occlusionNotice: null,
  } as EditorState;
}

export function purgeDraftFromStorage(state: EditorState): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(getDraftKey(state));
}

/** The platform the exclusion remedy adds when the brief has no still-image outlet. */
export const PHOTO_PLATFORM = "instagram-feed";

/**
 * The next whole second in range that this list does not already hold, or undefined
 * when every one is taken. Duplicates are meaningless — the planner collapses them.
 */
export function nextFreeDuration(duration: readonly number[]): number | undefined {
  const taken = new Set(duration);
  if (!taken.has(DEFAULT_DURATION_SEC)) return DEFAULT_DURATION_SEC;
  for (let seconds = MIN_DURATION_SEC; seconds <= MAX_DURATION_SEC; seconds += 1) {
    if (!taken.has(seconds)) return seconds;
  }
  return undefined;
}

export const PLAN_DEBOUNCE_MS = 250;

export function canPlan(state: EditorState): boolean {
  // X18: `toBrief` omits an optional policy draft the parser refuses, so a
  // plan started against one would estimate a policy the user is not looking
  // at. A draft may therefore be blank (the key the brief omits anyway) or
  // parse — never the truncation of a refused value.
  const draftOrParsed = (value: string): boolean =>
    value.trim() === "" || parsePolicyInteger(value) !== undefined;
  return (
    state.mode === "variation" &&
    state.briefId.length > 0 &&
    state.products.some((product) => product.id.length > 0) &&
    (parsePolicyInteger(state.variation.count) ?? 0) >= 1 &&
    draftOrParsed(state.variation.seed) &&
    draftOrParsed(state.variation.minDistance) &&
    draftOrParsed(state.variation.perProduct) &&
    draftOrParsed(state.variation.perRatio)
  );
}

/**
 * Every action goes through the clamp, because almost every action can move the
 * ceiling: dropping a ratio, a product, a motion kind, a duration, a format, a
 * platform, or the headlines the pool approves all shrink what the axes can produce.
 * Clamping only where the plan first noticed it (layout and tone) left every other
 * path to be refused by the planner instead — the very thing the clamp exists to
 * prevent.
 *
 * Two actions are exempt: one that changed nothing (the axis guards return the same
 * state), and the user setting the count by hand, which is them answering the notice
 * rather than provoking a new one.
 */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const next = reduceEditor(state, action);
  if (next === state) return state;
  if (action.type === "setVariation" && action.field === "count") return next;
  return withCountClamp(next);
}
