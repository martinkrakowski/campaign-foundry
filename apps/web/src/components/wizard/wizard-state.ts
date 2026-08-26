import type { CampaignBrief, Product } from "@campaignfoundry/CampaignOrchestration";

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
/** PLATFORM_PROFILES hides motion platforms until a later wave — there is no fetch route. */
export const STATIC_PLATFORMS = ["instagram-feed", "linkedin", "x"] as const;

export type CampaignMode = "brief" | "variation";

export interface ProductDraft {
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
  };
  platforms: string[];
}

export type WizardAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "setMode"; mode: CampaignMode }
  | { type: "patch"; patch: Partial<Pick<WizardState, "briefId" | "targetRegion" | "targetAudience" | "campaignMessage" | "localizedMessage">> }
  | { type: "setProduct"; index: number; patch: Partial<ProductDraft> }
  | { type: "addProduct" }
  | { type: "removeProduct"; index: number }
  | { type: "setVariation"; field: "count" | "seed" | "minDistance" | "perProduct" | "perRatio"; value: string }
  | { type: "toggleLayout"; value: string }
  | { type: "toggleTone"; value: string }
  | { type: "toggleBackground"; value: string }
  | { type: "togglePalette"; value: number }
  | { type: "togglePlatform"; value: string };

export function stepsFor(mode: CampaignMode): readonly WizardStepId[] {
  return mode === "variation" ? VARIATION_STEPS : CLASSIC_STEPS;
}

export function emptyProduct(): ProductDraft {
  return {
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
  },
  platforms: [...STATIC_PLATFORMS],
};

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export function assetFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  const match = lower.match(/\.(png|jpg|jpeg)$/);
  const ext = match?.[1] ?? "png";
  const stem = slugify(lower.replace(/\.[^.]+$/, "")) || "logo";
  return `${stem.slice(0, 64)}.${ext}`;
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
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
    case "patch":
      return { ...state, ...action.patch };
    case "setProduct": {
      return {
        ...state,
        products: state.products.map((product, index) => {
          if (index !== action.index) return product;
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
      return { ...state, products: state.products.filter((_, index) => index !== action.index) };
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
    case "togglePlatform":
      return { ...state, platforms: toggleOrdered(state.platforms, action.value, STATIC_PLATFORMS) };
  }
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : undefined;
}

function parseOptionalInt(value: string): number | undefined {
  const num = parseOptionalNumber(value);
  return num !== undefined && Number.isInteger(num) ? num : undefined;
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
  const seed = parseOptionalNumber(state.variation.seed);
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

  const axes: NonNullable<NonNullable<CampaignBrief["variation"]>["axes"]> = {
    ...(state.variation.layout.length > 0 ? { layout: [...state.variation.layout] } : {}),
    ...(state.variation.tone.length > 0 ? { tone: [...state.variation.tone] } : {}),
    ...(state.variation.background.length > 0
      ? { background: { source: [...state.variation.background] } }
      : {}),
    ...(state.variation.paletteShift.length > 0 ? { paletteShift: [...state.variation.paletteShift] } : {}),
  };

  return {
    ...withCopy,
    variation: {
      count,
      ...(seed !== undefined ? { seed } : {}),
      ...(minDistance !== undefined ? { minDistance } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      ...(Object.keys(axes).length > 0 ? { axes } : {}),
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
