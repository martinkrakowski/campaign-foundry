import { describe, test, expect } from "vitest";
import { validateState } from "@/components/campaign/validate";
import { initialEditorState } from "@/components/campaign/editor-state";
import { isKnownKey } from "@/components/campaign/error-sections";
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
