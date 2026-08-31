import type {
  CampaignBrief,
  CopyPool,
  Product,
  Treatment,
  VariationPolicy,
} from "@campaignfoundry/CampaignOrchestration";
// The leaf, never the barrel: the barrel re-exports the infrastructure adapters, which
// pull node:fs/path/crypto into the browser bundle.
import {
  DEFAULT_BACKGROUND_SOURCES,
  DEFAULT_DURATION,
  DEFAULT_DURATION_SEC,
  HEADLINE_POOL_REF,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
} from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import { MOTION_KINDS } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import {
  MAX_BEATS,
  MAX_WEIGHT,
  MIN_DWELL_SEC,
  timelineProblem,
  type CopyTimeline,
} from "@campaignfoundry/CampaignOrchestration/copy-timeline";

// Re-exported, not restated: every one of these is the domain's own value, and the
// editor's copies of them were exactly the drift the leaf exists to prevent (D18).
export {
  DEFAULT_DURATION_SEC,
  HEADLINE_POOL_REF,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  MOTION_KINDS,
  MAX_BEATS,
  MAX_WEIGHT,
  MIN_DWELL_SEC,
};
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { PLATFORM_PROFILES, type PlatformProfile } from "@campaignfoundry/Distribution/platform-profiles";
import { platformsToFormats, platformsToRatios } from "./derive";


export const LAYOUT_OPTIONS = ["headline-top", "headline-bottom"] as const;
export const TONE_OPTIONS = ["bold", "subtle"] as const;
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
  const numericKeys = products.map((p) => p.key).filter((k): k is number => typeof k === "number" && k > 0);
  return numericKeys.length > 0 ? Math.max(...numericKeys) + 1 : 1;
}

/**
 * Returns the next unused swatch in SWATCH_PALETTE for a new product, or wraps around.
 */
export function nextUnusedSwatch(products: readonly ProductDraft[]): string {
  const used = new Set(products.map((p) => p.primaryColor.toUpperCase()));
  return SWATCH_PALETTE.find((c) => !used.has(c.toUpperCase())) ?? SWATCH_PALETTE[products.length % SWATCH_PALETTE.length];
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
  | { kind: "file"; file: string; loadedId: string; savedSnapshot: CampaignBrief | null; revision: string | undefined };

export interface EditorState {
  source: EditorSource;
  mode: CampaignMode;
  campaignName: string;
  briefId: string;
  targetRegion: string;
  targetAudience: string;
  campaignMessage: string;
  localizedMessage: string;
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
  /**
   * True only when the loaded brief declared a `copy` block (D11). A declared-but-empty
   * block (`copy: {}`) is legal — the parser accepts it — and must survive a load→save
   * the same way `outputExplicit` preserves a declared `output`: saving must not strip
   * what a file already wrote. The editor never authors an empty block on its own;
   * `toBrief` writes one only to keep such a file byte-identical.
   */
  copyExplicit: boolean;
  variation: {
    count: string;
    seed: string;
    minDistance: string;
    perProduct: string;
    perRatio: string;
    layout: string[];
    tone: string[];
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
  appliedSnapshot: CampaignBrief | null;
  capabilities: { motion: boolean; reason?: string } | null;
}

export type EditorAction =
  | { type: "setMode"; mode: CampaignMode }
  | { type: "patch"; patch: Partial<Pick<EditorState, "campaignName" | "briefId" | "targetRegion" | "targetAudience" | "campaignMessage" | "localizedMessage">> }
  | { type: "setProduct"; key: number; patch: Partial<ProductDraft> }
  | { type: "addProduct" }
  | { type: "removeProduct"; key: number }
  | { type: "setTreatment"; index: number; patch: Partial<TreatmentDraft> }
  | { type: "addTreatment" }
  | { type: "removeTreatment"; index: number }
  | { type: "addBeat"; text?: string }
  | { type: "removeBeat"; index: number }
  | { type: "moveBeat"; from: number; to: number }
  | { type: "setBeatText"; index: number; text: string }
  | { type: "setBeatWeight"; index: number; weight: number }
  | { type: "setKeyBeat"; index: number }
  | { type: "setTransition"; transition: "cut" | "fade" }
  | { type: "setVariation"; field: "count" | "seed" | "minDistance" | "perProduct" | "perRatio"; value: string }
  | { type: "toggleLayout"; value: string }
  | { type: "toggleTone"; value: string }
  | { type: "toggleRatio"; value: string }
  | { type: "toggleBackground"; value: string }
  | { type: "togglePalette"; value: number }
  | { type: "toggleHeadline" }
  | { type: "toggleMotion"; value: string }
  | { type: "setDuration"; index: number; value: number }
  | { type: "addDuration"; value?: number }
  | { type: "addPhotoOutput" }
  | { type: "removeDuration"; index: number }
  | { type: "toggleFormat"; value: string }
  | { type: "togglePlatform"; value: string }
  | { type: "setPool"; briefId: string; pool: CopyPool | null }
  | { type: "loadPool"; briefId: string; pool: CopyPool | null }
  | { type: "load"; brief: CampaignBrief; entry?: { file: string; revision?: string } }
  | { type: "apply"; applied?: CampaignBrief }
  | { type: "save"; saved?: CampaignBrief; entry?: { file: string; revision?: string } }
  | { type: "restore"; state: EditorState }
  | { type: "discard" }
  | { type: "setCapabilities"; capabilities: { motion: boolean; reason?: string } };

function generateTempId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function initialEditorState(mode: CampaignMode = "brief"): EditorState {
  const tempId = generateTempId();
  return {
    source: { kind: "new", tempId },
    mode,
    campaignName: "",
    briefId: "",
    targetRegion: "",
    targetAudience: "",
    campaignMessage: "",
    localizedMessage: "",
    products: [emptyProduct(1)],
    nextProductKey: 2,
    nextBeatKey: 1,
    treatments: [],
    timeline: { beats: [], transition: "fade", keyBeat: 1 },
    copyExplicit: false,
    variation: {
      count: "12",
      seed: "",
      minDistance: "2",
      perProduct: "1",
      perRatio: "1",
      layout: [...LAYOUT_OPTIONS],
      tone: [...TONE_OPTIONS],
      ratio: [...RATIO_OPTIONS],
      background: [...DEFAULT_BACKGROUND_SOURCES],
      paletteShift: [...PALETTE_SHIFT_OPTIONS],
      headline: false,
    },
    motion: [],
    duration: [],
    formats: ["static"],
    platforms: [...STATIC_PLATFORMS],
    outputExplicit: false,
    modeExplicit: false,
    formatsOverridden: false,
    ratioOverridden: false,
    motionTouched: false,
    motionSeeded: false,
    pool: null,
    headlineAxisDropped: false,
    countNotice: null,
    appliedSnapshot: null,
    capabilities: null,
  };
}

function toggleOrdered<T>(list: readonly T[], value: T, order: readonly T[]): T[] {
  const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  return order.filter((item) => next.includes(item));
}


/*
 * How big the draw is. These three live here rather than in `validate.ts` because the
 * reducer needs them — the count clamp cannot run without knowing the ceiling — and
 * having validate own them made the two modules import each other. `validate.ts`
 * re-exports all three, so every existing caller is unaffected.
 */

/** Ratios the requested platforms package motion at — the motion filter's allowlist. */
export function motionPackagedRatios(state: EditorState | readonly string[]): Set<string> {
  const platforms: readonly string[] = Array.isArray(state) ? (state as readonly string[]) : (state as EditorState).platforms;
  return new Set(
    platforms
      .map((id: string) => PLATFORM_PROFILES[id])
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

/**
 * D13/D6: when an axis toggle shrinks what the axes can produce below the count, the
 * count comes down with it (the planner would refuse anything higher) and the editor
 * says so once, beside the slider. Any toggle that does not clamp clears the notice —
 * it describes the latest clamp only, never history.
 */
function withCountClamp(state: EditorState): EditorState {
  const axisMax = axisProductSize(state);
  const count = Number.parseInt(state.variation.count, 10) || 0;
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
  else if (index === timeline.keyBeat - 1) nextKeyIndex = Math.min(timeline.keyBeat - 1, beats.length - 1);
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
  return { beats: next, transition: timeline.transition, keyBeat: nextKeyIndex + 1 };
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
  return { beats: timeline.beats, transition: timeline.transition, keyBeat: timeline.keyBeat };
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
 */
export type AddBeatBlock =
  | { readonly kind: "max"; readonly max: number }
  | { readonly kind: "floor"; readonly shortestSec: number; readonly floorSec: number };

export function addBeatBlockedBy(state: EditorState): AddBeatBlock | undefined {
  if (state.timeline.beats.length >= MAX_BEATS) return { kind: "max", max: MAX_BEATS };
  const durations = timelineDurations(state);
  const withOneMore: CopyTimeline = {
    beats: [...state.timeline.beats, { text: "", weight: 1 }],
    transition: state.timeline.transition,
    keyBeat: state.timeline.keyBeat,
  };
  if (timelineProblem(withOneMore, durations) === undefined) return undefined;
  return { kind: "floor", shortestSec: Math.min(...durations), floorSec: MIN_DWELL_SEC };
}

/** A usable 0-based beat index: an integer inside the current list. */
function isBeatIndex(index: number, beatCount: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < beatCount;
}

function reduceEditor(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "setMode": {
      return { ...state, mode: action.mode };
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
          else if (action.patch.name !== undefined && !product.idTouched) next.id = slugify(action.patch.name);
          return next;
        }),
      };
    }
    case "addProduct":
      return { ...state, ...allocateProduct(state.products, state.nextProductKey) };
    case "removeProduct":
      return { ...state, products: state.products.filter((product) => product.key !== action.key) };
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
        treatments: [...state.treatments, { id: "", layout: LAYOUT_OPTIONS[0], tone: TONE_OPTIONS[0] }],
      };
    case "removeTreatment":
      return {
        ...state,
        treatments: state.treatments.filter((_, index) => index !== action.index),
      };
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
      return { ...state, timeline: { ...state.timeline, keyBeat: action.index + 1 } };
    case "setTransition":
      return { ...state, timeline: { ...state.timeline, transition: action.transition } };
    case "setVariation": {
      // Setting the count by hand answers the notice — it has said its one thing.
      if (action.field === "count") {
        return { ...state, countNotice: null, variation: { ...state.variation, count: action.value } };
      }
      return { ...state, variation: { ...state.variation, [action.field]: action.value } };
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
      const background = toggleOrdered(state.variation.background, action.value, BACKGROUND_OPTIONS);
      if (background.length === 0) return state;
      return { ...state, variation: { ...state.variation, background } };
    }
    case "togglePalette": {
      const paletteShift = toggleOrdered(state.variation.paletteShift, action.value, PALETTE_SHIFT_OPTIONS);
      if (paletteShift.length === 0) return state;
      return { ...state, variation: { ...state.variation, paletteShift } };
    }
    case "toggleHeadline":
      return { ...state, variation: { ...state.variation, headline: !state.variation.headline } };
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
      const formats = state.formats.includes("static") ? state.formats : [...state.formats, "static"];
      const platforms = state.platforms.some((id) => platformsToFormats([id]).includes("static"))
        ? state.platforms
        : [...state.platforms, PHOTO_PLATFORM];
      return withCountClamp({ ...state, formats, platforms, formatsOverridden: true, outputExplicit: true });
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
        asked !== undefined && !state.duration.includes(asked) ? asked : nextFreeDuration(state.duration);
      return next === undefined ? state : { ...state, duration: [...state.duration, next], motionTouched: true };
    }
    case "removeDuration":
      return { ...state, duration: state.duration.filter((_, index) => index !== action.index), motionTouched: true };
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
      const nextFormats = state.formatsOverridden ? state.formats : platformsToFormats(nextPlatforms);
      const nextRatio = state.ratioOverridden ? state.variation.ratio : platformsToRatios(nextPlatforms);

      let motion = state.motion;
      let duration = state.duration;
      let motionSeeded = state.motionSeeded;

      if (!state.formatsOverridden) {
        const videoTurningOn = nextFormats.includes("motion") && !state.formats.includes("motion");
        const videoTurningOff = !nextFormats.includes("motion") && state.formats.includes("motion");
        if (videoTurningOn && motion.length === 0 && duration.length === 0 && !state.motionTouched) {
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
        variation: { ...state.variation, headline: state.variation.headline && !none },
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
      return { ...fromBrief(action.brief, action.entry), capabilities: state.capabilities };
    }
    case "apply": {
      // Snapshot what was actually applied, not whatever the reducer holds when the
      // dispatch lands. Save & apply awaits the network first, so recomputing here
      // would record edits made during the request as applied when the run has the
      // pre-await brief — the same trap the `save` action carries `saved` for.
      return { ...state, appliedSnapshot: action.applied ?? toBrief(state) };
    }
    case "restore":
      // A draft persisted before the probe answered (or by an older editor) carries
      // stale capabilities. Keep the verdict this session already has, or restoring
      // would re-enable motion on a host that has said it cannot produce it.
      return { ...action.state, capabilities: state.capabilities ?? action.state.capabilities };
    case "save": {
      // Snapshot what was actually persisted, not whatever the reducer holds when the
      // response lands — edits made during the request must stay dirty. The draft
      // itself is never replaced: `save` updates the snapshot and the source's file
      // identity/revision in place, so keystrokes typed while the request was in
      // flight survive (replacing the draft is `load`'s job, and its cost).
      const savedSnapshot = action.saved ?? toBrief(state);
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
          ...fromBrief(state.source.savedSnapshot, { file: state.source.file, revision: state.source.revision }),
          capabilities: state.capabilities,
        };
      }
      return { ...initialEditorState(state.mode), capabilities: state.capabilities };
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
  const texts = pool.entries.filter((entry) => entry.status === "approved").map((entry) => entry.text);
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
  return { id: draft.id, layout: draft.layout as Treatment["layout"], tone: draft.tone as Treatment["tone"] };
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
  return state.mode === "variation" && state.formats.includes("motion") && !state.variation.headline;
}

export function toBrief(state: EditorState): CampaignBrief {
  // `mode` and `output` are optional in CampaignBrief — absent means the classic
  // static pipeline, which is exactly what a fresh draft holds. Writing them
  // unconditionally grew every classic brief on save (and made a freshly loaded
  // file read as dirty: its snapshot carried no such keys), so they are emitted
  // only when they say something the absent key would not: a variation mode, or
  // an output the loaded brief declared, the user has toggled, or that diverges
  // from the default. Rendering is unaffected either way — the static platforms
  // keep zero insets (D11) — same discipline the ratio axis already follows.
  const isDefaultOutput =
    state.formats.length === 1 &&
    state.formats[0] === "static" &&
    state.platforms.length === STATIC_PLATFORMS.length &&
    STATIC_PLATFORMS.every((platform) => state.platforms.includes(platform));
  const brief: CampaignBrief = {
    id: state.briefId,
    targetRegion: state.targetRegion,
    targetAudience: state.targetAudience,
    campaignMessage: state.campaignMessage,
    products: state.products.map(toProduct),
    ...(state.mode === "variation" || state.modeExplicit ? { mode: state.mode } : {}),
    ...(state.outputExplicit || !isDefaultOutput
      ? { output: { formats: [...state.formats], platforms: [...state.platforms] } }
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
          beats: state.timeline.beats.map((beat) => ({ text: beat.text, weight: beat.weight })),
          transition: state.timeline.transition,
          keyBeat: state.timeline.keyBeat,
        }
      : undefined;
  const copy =
    timeline !== undefined || state.copyExplicit
      ? { ...(timeline !== undefined ? { timeline } : {}) }
      : undefined;
  const withCopy = copy !== undefined ? { ...withLocalized, copy } : withLocalized;
  if (state.mode === "brief") {
    return state.treatments.length > 0 ? { ...withCopy, treatments: state.treatments.map(toTreatment) } : withCopy;
  }
  const count = parseInt(state.variation.count, 10) || 0;
  const seed = parseInt(state.variation.seed, 10);
  const minDistance = parseInt(state.variation.minDistance, 10);
  const perProduct = parseInt(state.variation.perProduct, 10);
  const perRatio = parseInt(state.variation.perRatio, 10);
  // Build the object first and drop it when nothing survives: blank inputs parse to NaN,
  // which is neither > 0 nor === 0, and would otherwise emit an empty `coverage: {}`.
  const coverageFields = {
    ...(perProduct > 0 ? { perProduct } : {}),
    ...(perRatio > 0 ? { perRatio } : {}),
  };
  const coverage =
    Object.keys(coverageFields).length > 0 ? (coverageFields as VariationPolicy["coverage"]) : undefined;
  const axes = {
    layout: [...state.variation.layout],
    tone: [...state.variation.tone],
    // The ratio axis is written only when it constrains: absent means every
    // ratio, so a full selection round-trips a brief without the key
    // byte-identically instead of growing a redundant `ratio: [all]`.
    ...(state.variation.ratio.length < RATIO_OPTIONS.length ? { ratio: [...state.variation.ratio] } : {}),
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
      ...(isFinite(seed) ? { seed } : {}),
      ...(isFinite(minDistance) ? { minDistance } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      axes,
    },
    ...(copy !== undefined ? { copy } : {}),
  };
}

/**
 * An array-valued input, or `fallback` when it is anything else. Shared by the
 * two places untyped JSON becomes an EditorState — `fromBrief` (a brief from
 * disk or the API) and `normalizeDraftState` (a draft from localStorage) — so
 * every reducer that calls `.filter`/`.includes` on a list can trust it is one.
 */
const list = <T,>(value: unknown, fallback: T[]): T[] => (Array.isArray(value) ? [...(value as T[])] : fallback);

export function fromBrief(brief: CampaignBrief, entry?: { file: string; revision?: string }): EditorState {
  const tempId = generateTempId();
  const source: EditorSource = entry
    ? { kind: "file", file: entry.file, loadedId: brief.id, savedSnapshot: brief, revision: entry.revision }
    : { kind: "new", tempId };
  const products = brief.products.length > 0
    ? brief.products.map((p, i) => ({ ...emptyProduct(i + 1, p.primaryColor), ...p, idTouched: true }))
    : [emptyProduct(1)];
  const nextProductKey = brief.products.length > 0 ? brief.products.length + 1 : 2;
  const treatments = brief.treatments?.map((t) => ({ id: t.id, layout: t.layout, tone: t.tone })) ?? [];
  const formats = [...(brief.output?.formats ?? ["static"])];
  const platforms = [...(brief.output?.platforms ?? [...STATIC_PLATFORMS])];
  // Carry the persisted variation policy back into the draft. Defaulting these would
  // silently rewrite a randomized brief's policy the first time it was saved, even
  // though E1 renders no controls for them yet (they arrive in E2.2 / E2.3).
  const variation = brief.variation;
  const axes = variation?.axes as Record<string, unknown> | undefined;
  const num = (value: unknown): string => (typeof value === "number" ? String(value) : "");
  const coverage = variation?.coverage as { perProduct?: number; perRatio?: number } | undefined;
  const derivedFormats = platformsToFormats(platforms);
  // One comparison for both paths. This used to be an inline set test while the draft
  // path used `differsFrom`, so the same brief got a different verdict depending on
  // whether it arrived from disk or from a restored draft — and the load path, the one
  // that reads other people's briefs, was the lenient of the two.
  const storedFormats = brief.output?.formats;
  const formatsOverridden = storedFormats !== undefined && differsFrom(storedFormats, derivedFormats);

  const derivedRatios = platformsToRatios(platforms);
  const storedRatios = axes?.ratio !== undefined ? list(axes.ratio, [...RATIO_OPTIONS]) : [...RATIO_OPTIONS];
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
        beats: copyTimeline.beats.map((beat, index) => ({ key: index + 1, text: beat.text, weight: beat.weight })),
        transition: copyTimeline.transition,
        keyBeat: copyTimeline.keyBeat,
      }
    : { beats: [], transition: "fade", keyBeat: 1 };

  return {
    source,
    nextBeatKey: timeline.beats.length + 1,
    mode: brief.mode ?? "brief",
    campaignName: brief.id,
    briefId: brief.id,
    targetRegion: brief.targetRegion,
    targetAudience: brief.targetAudience,
    campaignMessage: brief.campaignMessage,
    localizedMessage: brief.localizedMessage ?? "",
    products,
    nextProductKey,
    treatments,
    timeline,
    copyExplicit: brief.copy !== undefined,
    variation: {
      count: variation ? String(variation.count) : "12",
      seed: num(variation?.seed),
      minDistance: variation?.minDistance === undefined ? (variation ? "" : "2") : String(variation.minDistance),
      perProduct: coverage ? num(coverage.perProduct) : variation ? "" : "1",
      perRatio: coverage ? num(coverage.perRatio) : variation ? "" : "1",
      layout: list(axes?.layout, [...LAYOUT_OPTIONS]),
      tone: list(axes?.tone, [...TONE_OPTIONS]),
      ratio: storedRatios,
      background: list((axes?.background as { source?: unknown } | undefined)?.source, [...DEFAULT_BACKGROUND_SOURCES]),
      paletteShift: list(axes?.paletteShift, [...PALETTE_SHIFT_OPTIONS]),
      headline: axes?.headline === HEADLINE_POOL_REF,
    },
    motion: motionList,
    duration: durationList,
    formats,
    platforms,
    outputExplicit: brief.output !== undefined,
    modeExplicit: brief.mode === "brief",
    formatsOverridden,
    ratioOverridden,
    motionTouched,
    motionSeeded: false,
    pool: null,
    headlineAxisDropped: false,
    countNotice: null,
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
  return { id: "", targetRegion: "", targetAudience: "", campaignMessage: "", products: [] } as CampaignBrief;
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
 * `initialEditorState` mints a temp id and two product keys that are usually
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
  return stored.length !== derived.length || stored.some((value, index) => value !== derived[index]);
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
  const rawTimeline = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  // The key is never serialised, so a restored draft has none: mint by position. That is
  // safe precisely because the list has just been read whole — no reorder has happened yet.
  const beats: TimelineBeatDraft[] = (Array.isArray(rawTimeline?.beats) ? rawTimeline.beats : []).map(
    (entry, index) => {
      if (typeof entry !== "object" || entry === null) return { key: index + 1, text: "", weight: 1 };
      const beat = entry as Partial<TimelineBeatDraft>;
      const weight =
        typeof beat.weight === "number" && Number.isInteger(beat.weight) && beat.weight >= 1 && beat.weight <= MAX_WEIGHT
          ? beat.weight
          : 1;
      return { key: index + 1, text: typeof beat.text === "string" ? beat.text : "", weight };
    },
  );
  const transition =
    rawTimeline !== null && (rawTimeline.transition === "cut" || rawTimeline.transition === "fade")
      ? rawTimeline.transition
      : "fade";
  const storedKeyBeat =
    rawTimeline !== null && typeof rawTimeline.keyBeat === "number" && Number.isInteger(rawTimeline.keyBeat)
      ? rawTimeline.keyBeat
      : 1;
  const keyBeat = beats.length === 0 ? 1 : Math.min(Math.max(1, storedKeyBeat), beats.length);
  return { beats, transition, keyBeat };
}

export function normalizeDraftState(raw: Record<string, unknown>): EditorState {
  const mode: CampaignMode = raw.mode === "variation" ? "variation" : "brief";
  const initial = initialEditorState(mode);
  const str = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
  const rawSource = raw.source as Partial<EditorSource> | null | undefined;
  const source: EditorSource =
    rawSource !== null &&
    typeof rawSource === "object" &&
    (rawSource.kind === "new" || rawSource.kind === "file")
      ? (rawSource as EditorSource)
      : initial.source;
  const v = (typeof raw.variation === "object" && raw.variation !== null ? raw.variation : {}) as Record<
    string,
    unknown
  >;
  const variation: EditorState["variation"] = {
    count: str(v.count, initial.variation.count),
    seed: str(v.seed, initial.variation.seed),
    minDistance: str(v.minDistance, initial.variation.minDistance),
    perProduct: str(v.perProduct, initial.variation.perProduct),
    perRatio: str(v.perRatio, initial.variation.perRatio),
    layout: list(v.layout, initial.variation.layout),
    tone: list(v.tone, initial.variation.tone),
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
  const storedNextProductKey = typeof raw.nextProductKey === "number" && raw.nextProductKey > 0 ? raw.nextProductKey : undefined;
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
  const normalizedTimeline = normalizeTimelineDraft(raw.timeline);

  return {
    ...initial,
    ...raw,
    source,
    mode,
    campaignName,
    briefId: str(raw.briefId, initial.briefId),
    products,
    nextProductKey,
    treatments: list(raw.treatments, initial.treatments),
    timeline: normalizedTimeline,
    // Keys are minted by position in normalizeTimelineDraft, so the counter starts past them.
    nextBeatKey: normalizedTimeline.beats.length + 1,
    copyExplicit: raw.copyExplicit === true,
    variation,
    motion,
    duration,
    formats,
    platforms,
    outputExplicit: raw.outputExplicit === true,
    // Unlike the flags below, `=== true` is right for a legacy draft: the mode itself
    // survives in `mode`, and losing the marker only omits a key whose absence means
    // exactly what its value said. No authored work is lost.
    modeExplicit: raw.modeExplicit === true,
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
  return (
    state.mode === "variation" &&
    state.briefId.length > 0 &&
    state.products.some((product) => product.id.length > 0) &&
    parseInt(state.variation.count, 10) >= 1
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
