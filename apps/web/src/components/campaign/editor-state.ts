import type { CampaignBrief, CopyPool, Product, Treatment, VariationPolicy } from "@campaignfoundry/CampaignOrchestration";

export const LAYOUT_OPTIONS = ["headline-top", "headline-bottom"] as const;
export const TONE_OPTIONS = ["bold", "subtle"] as const;
export const BACKGROUND_OPTIONS = ["procedural", "asset-pool", "genai"] as const;
export const PALETTE_SHIFT_OPTIONS = [0, 0.1, 0.2] as const;
export const HEADLINE_POOL_REF = "pool://copy";
export const STATIC_PLATFORMS = ["instagram-feed", "linkedin", "x"] as const;

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

let nextProductKey = 1;

export function emptyProduct(): ProductDraft {
  const key = nextProductKey;
  nextProductKey += 1;
  return {
    key,
    id: "",
    name: "",
    primaryColor: "#1473E6",
    logoPath: "",
    inputAsset: "",
    idTouched: false,
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
  briefId: string;
  targetRegion: string;
  targetAudience: string;
  campaignMessage: string;
  localizedMessage: string;
  products: ProductDraft[];
  treatments: TreatmentDraft[];
  variation: {
    count: string;
    seed: string;
    minDistance: string;
    perProduct: string;
    perRatio: string;
    layout: string[];
    tone: string[];
    background: string[];
    paletteShift: number[];
    headline: boolean;
  };
  motion: string[];
  duration: number[];
  formats: string[];
  platforms: string[];
  pool: CopyPool | null;
  headlineAxisDropped: boolean;
  appliedSnapshot: CampaignBrief | null;
  capabilities: { motion: boolean; reason?: string } | null;
}

export type EditorAction =
  | { type: "setMode"; mode: CampaignMode }
  | { type: "patch"; patch: Partial<Pick<EditorState, "briefId" | "targetRegion" | "targetAudience" | "campaignMessage" | "localizedMessage">> }
  | { type: "setProduct"; key: number; patch: Partial<ProductDraft> }
  | { type: "addProduct" }
  | { type: "removeProduct"; key: number }
  | { type: "setTreatment"; index: number; patch: Partial<TreatmentDraft> }
  | { type: "addTreatment" }
  | { type: "removeTreatment"; index: number }
  | { type: "setVariation"; field: "count" | "seed" | "minDistance" | "perProduct" | "perRatio"; value: string }
  | { type: "toggleLayout"; value: string }
  | { type: "toggleTone"; value: string }
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
  | { type: "apply" }
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
    briefId: "",
    targetRegion: "",
    targetAudience: "",
    campaignMessage: "",
    localizedMessage: "",
    products: [emptyProduct(), emptyProduct()],
    treatments: [],
    variation: {
      count: "12",
      seed: "",
      minDistance: "2",
      perProduct: "1",
      perRatio: "1",
      layout: [...LAYOUT_OPTIONS],
      tone: [...TONE_OPTIONS],
      background: ["procedural"],
      paletteShift: [...PALETTE_SHIFT_OPTIONS],
      headline: false,
    },
    motion: [],
    duration: [],
    formats: ["static"],
    platforms: [...STATIC_PLATFORMS],
    pool: null,
    headlineAxisDropped: false,
    appliedSnapshot: null,
    capabilities: null,
  };
}

function toggleOrdered<T>(list: readonly T[], value: T, order: readonly T[]): T[] {
  const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  return order.filter((item) => next.includes(item));
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "setMode": {
      return { ...state, mode: action.mode };
    }
    case "patch": {
      const next = { ...state, ...action.patch };
      if (action.patch.briefId === undefined || action.patch.briefId === state.briefId) return next;
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
      return { ...state, products: [...state.products, emptyProduct()] };
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
    case "setVariation":
      return { ...state, variation: { ...state.variation, [action.field]: action.value } };
    case "toggleLayout":
      return {
        ...state,
        variation: { ...state.variation, layout: toggleOrdered(state.variation.layout, action.value, LAYOUT_OPTIONS) },
      };
    case "toggleTone":
      return {
        ...state,
        variation: { ...state.variation, tone: toggleOrdered(state.variation.tone, action.value, TONE_OPTIONS) },
      };
    case "toggleBackground":
      return {
        ...state,
        variation: {
          ...state.variation,
          background: toggleOrdered(state.variation.background, action.value, BACKGROUND_OPTIONS),
        },
      };
    case "togglePalette":
      return {
        ...state,
        variation: {
          ...state.variation,
          paletteShift: toggleOrdered(state.variation.paletteShift, action.value, PALETTE_SHIFT_OPTIONS),
        },
      };
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
    case "addDuration":
      return { ...state, duration: [...state.duration, 5] };
    case "removeDuration":
      return { ...state, duration: state.duration.filter((_, index) => index !== action.index) };
    case "toggleFormat": {
      const next = state.formats.includes(action.value)
        ? state.formats.filter((f) => f !== action.value)
        : [...state.formats, action.value];
      return { ...state, formats: next };
    }
    case "togglePlatform":
      return { ...state, platforms: toggleOrdered(state.platforms, action.value, STATIC_PLATFORMS) };
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
      return fromBrief(action.brief, action.entry);
    }
    case "apply": {
      return { ...state, appliedSnapshot: toBrief(state) };
    }
    case "restore":
      return action.state;
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
        return fromBrief(state.source.savedSnapshot, { file: state.source.file, revision: state.source.revision });
      }
      return initialEditorState(state.mode);
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
  const brief: CampaignBrief = {
    id: state.briefId,
    targetRegion: state.targetRegion,
    targetAudience: state.targetAudience,
    campaignMessage: state.campaignMessage,
    products: state.products.map(toProduct),
    mode: state.mode,
    output: {
      formats: [...state.formats],
      platforms: [...state.platforms],
    },
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

export function fromBrief(brief: CampaignBrief, entry?: { file: string; revision?: string }): EditorState {
  const tempId = generateTempId();
  const source: EditorSource = entry
    ? { kind: "file", file: entry.file, loadedId: brief.id, savedSnapshot: brief, revision: entry.revision }
    : { kind: "new", tempId };
  const products = brief.products.length > 0 ? brief.products.map((p, i) => ({ ...emptyProduct(), key: Date.now() + i, ...p, idTouched: true })) : [emptyProduct(), emptyProduct()];
  const treatments = brief.treatments?.map((t) => ({ id: t.id, layout: t.layout, tone: t.tone })) ?? [];
  const formats = [...(brief.output?.formats ?? ["static"])];
  const platforms = [...(brief.output?.platforms ?? [...STATIC_PLATFORMS])];
  // Carry the persisted variation policy back into the draft. Defaulting these would
  // silently rewrite a randomized brief's policy the first time it was saved, even
  // though E1 renders no controls for them yet (they arrive in E2.2 / E2.3).
  const variation = brief.variation;
  const axes = variation?.axes as Record<string, unknown> | undefined;
  const num = (value: unknown): string => (typeof value === "number" ? String(value) : "");
  const list = <T,>(value: unknown, fallback: T[]): T[] => (Array.isArray(value) ? [...(value as T[])] : fallback);
  const coverage = variation?.coverage as { perProduct?: number; perRatio?: number } | undefined;
  return {
    source,
    mode: brief.mode ?? "brief",
    briefId: brief.id,
    targetRegion: brief.targetRegion,
    targetAudience: brief.targetAudience,
    campaignMessage: brief.campaignMessage,
    localizedMessage: brief.localizedMessage ?? "",
    products,
    treatments,
    variation: {
      count: variation ? String(variation.count) : "12",
      seed: num(variation?.seed),
      minDistance: variation?.minDistance === undefined ? (variation ? "" : "2") : String(variation.minDistance),
      perProduct: coverage ? num(coverage.perProduct) : variation ? "" : "1",
      perRatio: coverage ? num(coverage.perRatio) : variation ? "" : "1",
      layout: list(axes?.layout, [...LAYOUT_OPTIONS]),
      tone: list(axes?.tone, [...TONE_OPTIONS]),
      background: list((axes?.background as { source?: unknown } | undefined)?.source, ["procedural"]),
      paletteShift: list(axes?.paletteShift, [...PALETTE_SHIFT_OPTIONS]),
      headline: axes?.headline === HEADLINE_POOL_REF,
    },
    motion: list(axes?.motion, []),
    duration: list(axes?.duration, []),
    formats,
    platforms,
    pool: null,
    headlineAxisDropped: false,
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

export function getDraftKey(state: EditorState): string {
  const id = state.source.kind === "file" ? state.source.loadedId : state.source.tempId;
  return `cf:draft:${id}`;
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
    const draft = JSON.parse(raw);
    return draft.state ?? null;
  } catch {
    return null;
  }
}

export function purgeDraftFromStorage(state: EditorState): void {
  if (typeof localStorage === "undefined") return;
  const key = getDraftKey(state);
  localStorage.removeItem(key);
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
