import { describe, test, expect } from "vitest";
import {
  assetFileName,
  canPlan,
  emptyProduct,
  fileToBase64,
  initialWizardState,
  slugify,
  stepsFor,
  toBrief,
  wizardReducer,
  type WizardState,
} from "../wizard-state";

const withStep = (stepIndex: number, over: Partial<WizardState> = {}): WizardState => ({
  ...initialWizardState,
  stepIndex,
  ...over,
});

describe("slugify / assetFileName", () => {
  test("slugs names and strips junk", () => {
    expect(slugify("Hydra Bottle")).toBe("hydra-bottle");
    expect(slugify("  --X--  ")).toBe("x");
    expect(slugify("")).toBe("");
    expect(slugify("a".repeat(80))).toHaveLength(64);
  });

  test("builds a path-safe asset basename", () => {
    expect(assetFileName("My Logo.PNG")).toBe("my-logo.png");
    expect(assetFileName("photo.JPEG")).toBe("photo.jpeg");
    expect(assetFileName("...")).toBe("logo.png");
    expect(assetFileName("no-ext")).toBe("no-ext.png");
  });
});

describe("fileToBase64", () => {
  test("encodes the file bytes", async () => {
    const file = new File([new Uint8Array([104, 105])], "x.png", { type: "image/png" });
    expect(await fileToBase64(file)).toBe(btoa("hi"));
  });
});

describe("stepsFor", () => {
  test("inserts the policy step only for randomized campaigns", () => {
    expect(stepsFor("brief")).not.toContain("policy");
    expect(stepsFor("variation")).toContain("policy");
  });
});

describe("wizardReducer", () => {
  test("clamps next/back and setMode", () => {
    expect(wizardReducer(withStep(0), { type: "back" }).stepIndex).toBe(0);
    expect(wizardReducer(withStep(4), { type: "next" }).stepIndex).toBe(4); // classic last
    expect(wizardReducer(withStep(3), { type: "next" }).stepIndex).toBe(4);
    expect(
      wizardReducer(withStep(5, { mode: "variation" }), { type: "setMode", mode: "brief" }).stepIndex,
    ).toBe(4);
  });

  test("patches scalars and variation fields", () => {
    const patched = wizardReducer(initialWizardState, { type: "patch", patch: { briefId: "camp" } });
    expect(patched.briefId).toBe("camp");
    expect(
      wizardReducer(initialWizardState, { type: "setVariation", field: "count", value: "8" }).variation
        .count,
    ).toBe("8");
  });

  test("auto-slugs a product id until the id is touched", () => {
    const named = wizardReducer(initialWizardState, {
      type: "setProduct",
      index: 0,
      patch: { name: "Hydra Bottle" },
    });
    expect(named.products[0].id).toBe("hydra-bottle");
    const touched = wizardReducer(named, { type: "setProduct", index: 0, patch: { id: "custom" } });
    expect(touched.products[0].idTouched).toBe(true);
    const renamed = wizardReducer(touched, { type: "setProduct", index: 0, patch: { name: "Other" } });
    expect(renamed.products[0].id).toBe("custom");
  });

  test("adds and removes products", () => {
    const added = wizardReducer(initialWizardState, { type: "addProduct" });
    expect(added.products).toHaveLength(3);
    expect(added.products[2]).toEqual(emptyProduct());
    expect(wizardReducer(added, { type: "removeProduct", index: 0 }).products).toHaveLength(2);
  });

  test("toggles axes and platforms, preserving allowlist order", () => {
    const off = wizardReducer(initialWizardState, { type: "toggleLayout", value: "headline-top" });
    expect(off.variation.layout).toEqual(["headline-bottom"]);
    const on = wizardReducer(off, { type: "toggleLayout", value: "headline-top" });
    expect(on.variation.layout).toEqual(["headline-top", "headline-bottom"]);
    expect(
      wizardReducer(initialWizardState, { type: "toggleTone", value: "bold" }).variation.tone,
    ).toEqual(["subtle"]);
    expect(
      wizardReducer(initialWizardState, { type: "toggleBackground", value: "genai" }).variation
        .background,
    ).toEqual(["procedural", "genai"]);
    expect(
      wizardReducer(initialWizardState, { type: "togglePalette", value: 0 }).variation.paletteShift,
    ).toEqual([0.1, 0.2]);
    expect(
      wizardReducer(initialWizardState, { type: "togglePlatform", value: "x" }).platforms,
    ).toEqual(["instagram-feed", "linkedin"]);
  });
});

describe("toBrief / canPlan", () => {
  const filled: WizardState = {
    ...initialWizardState,
    briefId: "camp",
    targetRegion: "DE",
    targetAudience: "fans",
    campaignMessage: "Hi",
    localizedMessage: "Hallo",
    products: [
      {
        id: "alpha",
        name: "A",
        primaryColor: "#1473E6",
        logoPath: "a.png",
        inputAsset: "in.png",
        idTouched: true,
      },
      {
        id: "beta",
        name: "B",
        primaryColor: "#E0218A",
        logoPath: "b.png",
        inputAsset: "  ",
        idTouched: true,
      },
    ],
  };

  test("omits empty optional fields in classic mode", () => {
    const classic = toBrief({ ...filled, localizedMessage: "" });
    expect(classic.mode).toBe("brief");
    expect(classic.localizedMessage).toBeUndefined();
    expect(classic.variation).toBeUndefined();
    expect(classic.products[0].inputAsset).toBe("in.png");
    expect(classic.products[1].inputAsset).toBeUndefined();
    expect(classic.output).toEqual({
      formats: ["static"],
      platforms: ["instagram-feed", "linkedin", "x"],
    });
  });

  test("includes variation when randomized, omitting empty nested blocks", () => {
    const randomized = toBrief({
      ...filled,
      mode: "variation",
      variation: {
        count: "12",
        seed: "42",
        minDistance: "2",
        perProduct: "1",
        perRatio: "",
        layout: [],
        tone: [],
        background: [],
        paletteShift: [],
      },
    });
    expect(randomized.variation).toEqual({
      count: 12,
      seed: 42,
      minDistance: 2,
      coverage: { perProduct: 1 },
    });
    const ratioOnly = toBrief({
      ...filled,
      mode: "variation",
      variation: {
        count: "nope",
        seed: "",
        minDistance: "",
        perProduct: "",
        perRatio: "1",
        layout: [],
        tone: [],
        background: [],
        paletteShift: [],
      },
    });
    expect(ratioOnly.variation).toEqual({ count: 0, coverage: { perRatio: 1 } });
    const noOptional = toBrief({
      ...filled,
      mode: "variation",
      variation: {
        count: "3",
        seed: "",
        minDistance: "",
        perProduct: "",
        perRatio: "",
        layout: ["headline-top"],
        tone: ["bold"],
        background: ["procedural"],
        paletteShift: [0],
      },
    });
    expect(noOptional.variation).toEqual({
      count: 3,
      axes: {
        layout: ["headline-top"],
        tone: ["bold"],
        background: { source: ["procedural"] },
        paletteShift: [0],
      },
    });
  });

  test("canPlan requires variation mode, an id, a product id, and count >= 1", () => {
    expect(canPlan(initialWizardState)).toBe(false);
    expect(canPlan({ ...filled, mode: "variation" })).toBe(true);
    expect(canPlan({ ...filled, mode: "variation", variation: { ...filled.variation, count: "0" } })).toBe(
      false,
    );
  });
});
