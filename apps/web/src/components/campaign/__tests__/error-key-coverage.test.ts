import { describe, test, expect } from "vitest";
import { validateState } from "@/components/campaign/validate";
import { initialEditorState } from "@/components/campaign/editor-state";
import { isKnownKey } from "@/components/campaign/error-sections";
import { SECTION_BY_ERROR_KEY, MOTION_HOST_SECTION } from "@/components/campaign/ErrorStrip";
import { SECTION_TITLES, type SectionId } from "@/components/campaign/sections";
import type { EditorState, ProductDraft } from "@/components/campaign/editor-state";

function makeFixture(overrides: Partial<EditorState>): EditorState {
  const base = initialEditorState();
  return { ...base, ...overrides } as EditorState;
}

// Dummy product with required properties
function makeProduct(overrides: Partial<ProductDraft>): ProductDraft {
  return {
    id: "",
    name: "",
    primaryColor: "#000000",
    logoPath: "",
    key: 0,
    inputAsset: "",
    idTouched: false,
    ...overrides,
  };
}

describe("L1.1 error key coverage", () => {
  test("blank brief (randomized) emits only known keys", () => {
    const state = initialEditorState();
    const errors = validateState(state);
    for (const sectionErrors of Object.values(errors)) {
      for (const key of Object.keys(sectionErrors)) {
        expect(isKnownKey(key)).toBe(true);
      }
    }
  });

  test("blank brief (classic) emits only known keys", () => {
    const state = { ...initialEditorState(), mode: "brief" as const };
    const errors = validateState(state);
    for (const sectionErrors of Object.values(errors)) {
      for (const key of Object.keys(sectionErrors)) {
        expect(isKnownKey(key)).toBe(true);
      }
    }
  });

  test("every field wrong emits only known keys", () => {
    const state = makeFixture({
      briefId: "INVALID ID!",
      targetRegion: "",
      targetAudience: "",
      campaignMessage: "",
      products: [
        makeProduct({ id: "bad id", name: "", primaryColor: "red", logoPath: "", key: 0 }),
        makeProduct({ id: "bad id", name: "", primaryColor: "12345", logoPath: "", key: 1 }),
      ],
      variation: {
        count: "0",
        seed: "-1",
        minDistance: "10",
        perProduct: "-1",
        perRatio: "100",
        ratio: [],
        layout: [],
        tone: [],
        background: [],
        paletteShift: [],
        headline: false,
      },
      formats: [],
      platforms: [],
      motion: [],
      duration: [1],
    });
    const errors = validateState(state);
    for (const sectionErrors of Object.values(errors)) {
      for (const key of Object.keys(sectionErrors)) {
        expect(isKnownKey(key)).toBe(true);
      }
    }
  });

  test("two products with all product errors emits known keys", () => {
    const state = makeFixture({
      products: [
        makeProduct({ id: "", name: "", primaryColor: "ZZZ", logoPath: "" }),
        makeProduct({ id: "", name: "", primaryColor: "ZZZ", logoPath: "" }),
      ],
    });
    const errors = validateState(state);
    const productErrors = errors.products ?? {};
    for (const key of Object.keys(productErrors)) {
      expect(isKnownKey(key)).toBe(true);
    }
  });

  test("motion with all output errors emits known keys", () => {
    const state = makeFixture({
      formats: ["motion"],
      platforms: ["invalid-platform"],
      motion: [],
      duration: [1],
    });
    const errors = validateState(state);
    for (const sectionErrors of Object.values(errors)) {
      for (const key of Object.keys(sectionErrors)) {
        expect(isKnownKey(key)).toBe(true);
      }
    }
  });
});

describe("W6.7 error bucket ↔ section totality", () => {
  test("every section id resolves to itself, and no bucket hides beyond the six", () => {
    const ids = Object.keys(SECTION_TITLES) as SectionId[];
    for (const id of ids) {
      expect(SECTION_BY_ERROR_KEY[id]).toBe(id);
    }
    expect(Object.keys(SECTION_BY_ERROR_KEY)).toHaveLength(ids.length);
  });

  test("SECTION_BY_ERROR_KEY is a bijection: every value is a declared section", () => {
    const ids = Object.keys(SECTION_TITLES) as SectionId[];
    const values = Object.values(SECTION_BY_ERROR_KEY);
    expect(values).toHaveLength(new Set(values).size);
    expect(values.sort()).toEqual(ids.sort());
  });

  test("motion is the one non-section bucket, and lives inside its Output host", () => {
    expect(MOTION_HOST_SECTION).toBe("output");
    expect(SECTION_BY_ERROR_KEY).not.toHaveProperty("motion");
  });
});
