import type { CampaignBrief, CopyPool, Product, Treatment, VariationPolicy } from "@campaignfoundry/CampaignOrchestration";
// The leaf, never the barrel: the barrel re-exports the infrastructure adapters, which
// pull node:fs/path/crypto into the browser bundle.
import {
  DEFAULT_BACKGROUND_SOURCES,
  HEADLINE_POOL_REF,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
} from "@campaignfoundry/CampaignOrchestration/variation-defaults";

// Re-exported, not restated: every one of these is the domain's own value, and the
// editor's copies of them were exactly the drift the leaf exists to prevent (D18).
export { HEADLINE_POOL_REF, MAX_DURATION_SEC, MIN_DURATION_SEC };
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { PLATFORM_PROFILES, type PlatformProfile } from "@campaignfoundry/Distribution/platform-profiles";


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
  treatments: TreatmentDraft[];
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
   * `output`, or the user has toggled a format or platform. A default-valued
   * output that was never declared serialises as the absent key instead — the
   * static platforms carry zero insets (D11), so both forms render identically.
   */
  outputExplicit: boolean;
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
  | { type: "setVariation"; field: "count" | "seed" | "minDistance" | "perProduct" | "perRatio"; value: string }
  | { type: "toggleLayout"; value: string }
  | { type: "toggleTone"; value: string }
  | { type: "toggleRatio"; value: string }
  | { type: "toggleBackground"; value: string }
  | { type: "togglePalette"; value: number }
  | { type: "toggleHeadline" }
  | { type: "toggleMotion"; value: string }
  | { type: "setDuration"; index: number; value: number }
  | { type: "addDuration" }
  | { type: "removeDuration"; index: number }
  | { type: "toggleFormat"; value: string }
  | { type: "togglePlatform"; value: string }
  | { type: "setPool"; briefId: string; pool: CopyPool | null }
  | { type: "loadPool"; briefId: string; pool: CopyPool | null }
  | { type: "load"; brief: CampaignBrief; entry?: { file: string; revision?: string } }
  | { type: "apply"; applied?: CampaignBrief }
  | { type: "save"; saved?: CampaignBrief }
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
    treatments: [],
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
export function motionPackagedRatios(state: EditorState): Set<string> {
  return new Set(
    state.platforms
      .map((id) => PLATFORM_PROFILES[id])
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
    case "toggleRatio":
      return {
        ...state,
        variation: { ...state.variation, ratio: toggleOrdered(state.variation.ratio, action.value, RATIO_OPTIONS) },
      };
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
      return { ...state, motion: next };
    }
    case "setDuration": {
      const next = [...state.duration];
      next[action.index] = action.value;
      return { ...state, duration: next };
    }
    case "addDuration": {
      // The planner de-duplicates this axis (`unique(axes.duration)` in
      // VariationPolicy.vo), so appending a fixed value lets the user add entries that
      // silently do nothing. Offer the next unused length instead.
      const next = nextFreeDuration(state.duration);
      return next === undefined ? state : { ...state, duration: [...state.duration, next] };
    }
    case "removeDuration":
      return { ...state, duration: state.duration.filter((_, index) => index !== action.index) };
    case "toggleFormat": {
      const next = state.formats.includes(action.value)
        ? state.formats.filter((f) => f !== action.value)
        : [...state.formats, action.value];
      // The user has spoken about output: it must persist even if the toggles
      // happen to land back on the absent-key default.
      return { ...state, formats: next, outputExplicit: true };
    }
    case "togglePlatform":
      return {
        ...state,
        platforms: toggleOrdered(state.platforms, action.value, PLATFORM_ORDER),
        outputExplicit: true,
      };
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
      // response lands — edits made during the request must stay dirty.
      const savedSnapshot = action.saved ?? toBrief(state);
      const source: EditorSource = state.source.kind === "file" 
        ? { ...state.source, savedSnapshot }
        : { kind: "file", file: `${state.briefId}.yaml`, loadedId: state.briefId, savedSnapshot, revision: undefined };
      return { ...state, source };
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
  return pool === null ? 0 : pool.entries.filter((entry) => entry.status === "approved").length;
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
    ...(state.mode === "variation" ? { mode: state.mode } : {}),
    ...(state.outputExplicit || !isDefaultOutput
      ? { output: { formats: [...state.formats], platforms: [...state.platforms] } }
      : {}),
  };
  const localized = state.localizedMessage.trim();
  const withCopy = localized ? { ...brief, localizedMessage: localized } : brief;
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
    ...withCopy,
    variation: {
      count,
      ...(isFinite(seed) ? { seed } : {}),
      ...(isFinite(minDistance) ? { minDistance } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      axes,
    },
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
  return {
    source,
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
    variation: {
      count: variation ? String(variation.count) : "12",
      seed: num(variation?.seed),
      minDistance: variation?.minDistance === undefined ? (variation ? "" : "2") : String(variation.minDistance),
      perProduct: coverage ? num(coverage.perProduct) : variation ? "" : "1",
      perRatio: coverage ? num(coverage.perRatio) : variation ? "" : "1",
      layout: list(axes?.layout, [...LAYOUT_OPTIONS]),
      tone: list(axes?.tone, [...TONE_OPTIONS]),
      ratio: list(axes?.ratio, [...RATIO_OPTIONS]),
      background: list((axes?.background as { source?: unknown } | undefined)?.source, [...DEFAULT_BACKGROUND_SOURCES]),
      paletteShift: list(axes?.paletteShift, [...PALETTE_SHIFT_OPTIONS]),
      headline: axes?.headline === HEADLINE_POOL_REF,
    },
    motion: list(axes?.motion, []),
    duration: list(axes?.duration, []),
    formats,
    platforms,
    outputExplicit: brief.output !== undefined,
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

export function isDirtySinceSave(state: EditorState): boolean {
  if (state.source.kind === "new") return true;
  if (!state.source.savedSnapshot) return true;
  return JSON.stringify(toBrief(state)) !== JSON.stringify(state.source.savedSnapshot);
}

export function isDirtySinceApply(state: EditorState): boolean {
  if (!state.appliedSnapshot) return true;
  return JSON.stringify(toBrief(state)) !== JSON.stringify(state.appliedSnapshot);
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
    variation,
    motion: list(raw.motion, initial.motion),
    duration: list(raw.duration, initial.duration),
    formats: list(raw.formats, initial.formats),
    platforms: list(raw.platforms, initial.platforms),
    outputExplicit: raw.outputExplicit === true,
    // The count notice is one-time UI, not part of the draft it describes.
    countNotice: null,
  } as EditorState;
}

export function purgeDraftFromStorage(state: EditorState): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(getDraftKey(state));
}

/** Clip lengths the API accepts, mirroring load-brief's MIN/MAX_DURATION_SEC. */
/** The default length a first duration is offered at. */
export const DEFAULT_DURATION_SEC = 5;

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
