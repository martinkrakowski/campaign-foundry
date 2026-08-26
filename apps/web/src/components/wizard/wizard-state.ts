import type { CampaignBrief, CopyPool, Product } from "@campaignfoundry/CampaignOrchestration";

export const WIZARD_STEPS = ["type", "products", "copy", "policy", "output", "review"] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number];

export const CLASSIC_STEPS: readonly WizardStepId[] = ["type", "products", "copy", "output", "review"];
export const VARIATION_STEPS: readonly WizardStepId[] = [
  "type",
  "products",
  "copy",
  "policy",
  "output",
  "review",
];

export const LAYOUT_OPTIONS = ["headline-top", "headline-bottom"] as const;
export const TONE_OPTIONS = ["bold", "subtle"] as const;
export const BACKGROUND_OPTIONS = ["procedural", "asset-pool", "genai"] as const;
export const PALETTE_SHIFT_OPTIONS = [0, 0.1, 0.2] as const;
/** The only pool reference the parser accepts for the `headline` axis (mirrors HEADLINE_POOL_REF). */
export const HEADLINE_POOL_REF = "pool://copy";
/** PLATFORM_PROFILES hides motion platforms until a later wave — there is no fetch route. */
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

export interface WizardState {
  stepIndex: number;
  mode: CampaignMode;
  briefId: string;
  targetRegion: string;
  targetAudience: string;
  campaignMessage: string;
  localizedMessage: string;
  products: ProductDraft[];
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
    /** Draw headlines from the approved copy pool (`headline: pool://copy`). */
    headline: boolean;
  };
  platforms: string[];
  /** The brief's copy pool as last fetched/edited in the Copy step; null until one exists. */
  pool: CopyPool | null;
  /**
   * True after a pool change removed the last approved entry while the headline
   * axis was on (the reducer turned it off); cleared once an entry is approved again.
   */
  headlineAxisDropped: boolean;
}

export type WizardAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "setMode"; mode: CampaignMode }
  | { type: "patch"; patch: Partial<Pick<WizardState, "briefId" | "targetRegion" | "targetAudience" | "campaignMessage" | "localizedMessage">> }
  | { type: "setProduct"; key: number; patch: Partial<ProductDraft> }
  | { type: "addProduct" }
  | { type: "removeProduct"; key: number }
  | { type: "setVariation"; field: "count" | "seed" | "minDistance" | "perProduct" | "perRatio"; value: string }
  | { type: "toggleLayout"; value: string }
  | { type: "toggleTone"; value: string }
  | { type: "toggleBackground"; value: string }
  | { type: "togglePalette"; value: number }
  | { type: "toggleHeadline" }
  /** Tagged with the brief the response belongs to: a late reply for a previous id is dropped. */
  | { type: "setPool"; briefId: string; pool: CopyPool | null }
  | { type: "togglePlatform"; value: string };

export function stepsFor(mode: CampaignMode): readonly WizardStepId[] {
  return mode === "variation" ? VARIATION_STEPS : CLASSIC_STEPS;
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

export const initialWizardState: WizardState = {
  stepIndex: 0,
  mode: "brief",
  briefId: "",
  targetRegion: "",
  targetAudience: "",
  campaignMessage: "",
  localizedMessage: "",
  products: [emptyProduct(), emptyProduct()],
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
  platforms: [...STATIC_PLATFORMS],
  pool: null,
  headlineAxisDropped: false,
};

/** Number of approved entries in the wizard's pool (0 without a pool). */
export function approvedHeadlines(pool: CopyPool | null): number {
  return pool === null ? 0 : pool.entries.filter((entry) => entry.status === "approved").length;
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

function toggleOrdered<T>(list: readonly T[], value: T, order: readonly T[]): T[] {
  const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  return order.filter((item) => next.includes(item));
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "next": {
      const steps = stepsFor(state.mode);
      return { ...state, stepIndex: Math.min(state.stepIndex + 1, steps.length - 1) };
    }
    case "back":
      return { ...state, stepIndex: Math.max(state.stepIndex - 1, 0) };
    case "setMode": {
      const steps = stepsFor(action.mode);
      return { ...state, mode: action.mode, stepIndex: Math.min(state.stepIndex, steps.length - 1) };
    }
    case "patch": {
      const next = { ...state, ...action.patch };
      // The pool belongs to one brief: a new id starts from nothing (and drops the
      // axis and its notice) rather than showing — or patching — the previous brief's entries.
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
    case "setVariation":
      return { ...state, variation: { ...state.variation, [action.field]: action.value } };
    case "toggleLayout":
      return {
        ...state,
        variation: {
          ...state.variation,
          layout: toggleOrdered(state.variation.layout, action.value, LAYOUT_OPTIONS),
        },
      };
    case "toggleTone":
      return {
        ...state,
        variation: {
          ...state.variation,
          tone: toggleOrdered(state.variation.tone, action.value, TONE_OPTIONS),
        },
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
    case "setPool": {
      if (action.briefId !== state.briefId) return state;
      // The axis is only meaningful with something to draw from: losing the last
      // approved entry switches it off rather than leaving a brief that cannot plan
      // — and remembers that it did, so the Copy step can say so.
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
    case "togglePlatform":
      return { ...state, platforms: toggleOrdered(state.platforms, action.value, STATIC_PLATFORMS) };
  }
}

function parseOptionalInt(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const num = Number(trimmed);
  return Number.isInteger(num) ? num : undefined;
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

/** Build a CampaignBrief from wizard state (omits empty optional blocks). */
export function toBrief(state: WizardState): CampaignBrief {
  const brief: CampaignBrief = {
    id: state.briefId,
    targetRegion: state.targetRegion,
    targetAudience: state.targetAudience,
    campaignMessage: state.campaignMessage,
    products: state.products.map(toProduct),
    mode: state.mode,
    output: {
      formats: ["static"],
      platforms: [...state.platforms],
    },
  };
  const localized = state.localizedMessage.trim();
  const withCopy = localized ? { ...brief, localizedMessage: localized } : brief;
  if (state.mode !== "variation") return withCopy;

  const count = parseOptionalInt(state.variation.count) ?? 0;
  const seed = parseOptionalInt(state.variation.seed);
  const minDistance = parseOptionalInt(state.variation.minDistance);
  const perProduct = parseOptionalInt(state.variation.perProduct);
  const perRatio = parseOptionalInt(state.variation.perRatio);
  const coverage =
    perProduct === undefined && perRatio === undefined
      ? undefined
      : {
          ...(perProduct !== undefined ? { perProduct } : {}),
          ...(perRatio !== undefined ? { perRatio } : {}),
        };

  // Always emit the selected axes (including empty). Omitting an axis restores the
  // planner defaults, which is the opposite of deselecting every option.
  const axes: NonNullable<NonNullable<CampaignBrief["variation"]>["axes"]> = {
    layout: [...state.variation.layout],
    tone: [...state.variation.tone],
    background: { source: [...state.variation.background] },
    paletteShift: [...state.variation.paletteShift],
    ...(state.variation.headline ? { headline: HEADLINE_POOL_REF } : {}),
  };

  return {
    ...withCopy,
    variation: {
      count,
      ...(seed !== undefined ? { seed } : {}),
      ...(minDistance !== undefined ? { minDistance } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      axes,
    },
  };
}

export const PLAN_DEBOUNCE_MS = 250;

export function canPlan(state: WizardState): boolean {
  return (
    state.mode === "variation" &&
    state.briefId.length > 0 &&
    state.products.some((product) => product.id.length > 0) &&
    Number(state.variation.count) >= 1
  );
}
