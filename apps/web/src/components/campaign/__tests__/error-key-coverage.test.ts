import { describe, test, expect } from "vitest";
import { validateState } from "@/components/campaign/validate";
import { initialEditorState } from "@/components/campaign/editor-state";
import { isKnownKey } from "@/components/campaign/error-sections";
import {
  SECTION_BY_ERROR_KEY,
  MOTION_ERROR_KEY,
  MOTION_HOST_SECTION,
  sectionForErrorBucket,
} from "@/components/campaign/ErrorStrip";
import { SECTION_TITLES, sectionOrder, type SectionId } from "@/components/campaign/sections";
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
        anchor: [],
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

  test("sectionForErrorBucket is the one bucket→section mapping: sections pass through, motion folds into its host, null is nothing", () => {
    // The mapping the walk, `reveal` and the D35 handoff's published verdict share.
    // Pinned here beside the map it is built on, so a new bucket cannot silently
    // bypass it (the `as SectionId` inside is safe exactly because this file proves
    // the bucket universe is the six sections plus motion).
    expect(sectionForErrorBucket(null)).toBeNull();
    expect(sectionForErrorBucket(MOTION_ERROR_KEY)).toBe(MOTION_HOST_SECTION);
    const ids = Object.keys(SECTION_TITLES) as SectionId[];
    for (const id of ids) {
      expect(sectionForErrorBucket(id)).toBe(id);
    }
  });

  /**
   * W6.7's criterion, restated for the one column (SG1).
   *
   * It used to read "every section has a step, and every step but `review` is a
   * section", which was the vocabulary the wizard imposed: a step list of
   * `[...sectionOrder(mode), "review"]`. There are no steps and no `review`, so
   * the drift this guards against is now between the ORDER a mode renders and
   * the TITLES every surface reads — and it still runs in both directions: a
   * section added to an order without a title, or a title with no place in
   * either order, fails here.
   */
  test.each(["brief", "variation"] as const)(
    "%s: every section in the order has a title, and no order invents an id",
    (mode) => {
      const sections = sectionOrder(mode);
      // No duplicates: an id twice in one order would render one section twice.
      expect(sections).toHaveLength(new Set(sections).size);
      for (const section of sections) {
        expect(SECTION_TITLES).toHaveProperty(section);
        expect(SECTION_BY_ERROR_KEY[section]).toBe(section);
      }
    },
  );

  test("every declared section belongs to at least one mode's order", () => {
    // The other direction: a title with no order to render it is a section the
    // editor can never show, and an outline row that scrolls to nothing.
    const rendered = new Set([...sectionOrder("brief"), ...sectionOrder("variation")]);
    for (const id of Object.keys(SECTION_TITLES) as SectionId[]) {
      expect(rendered.has(id)).toBe(true);
    }
  });

  test("motion's host is a section that exists in every mode, so the chip is always reachable", () => {
    // The property that actually matters. A motion chip reveals its *host*, so a
    // host absent from a mode's section order would leave the chip pointing at a
    // section that is not rendered in that mode, and clicking it would scroll
    // nowhere at all.
    for (const mode of ["brief", "variation"] as const) {
      expect(sectionOrder(mode)).toContain(MOTION_HOST_SECTION);
    }
  });
});
