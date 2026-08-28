import { describe, test, expect } from "vitest";
import * as messages from "@/components/campaign/messages";
import { hasErrors, maxMinDistance, validateStep } from "../validate";
import { emptyProduct, initialWizardState, type WizardState } from "../wizard-state";

const validProducts = (): WizardState["products"] => [
  {
    key: 1,
    id: "alpha",
    name: "A",
    primaryColor: "#1473E6",
    logoPath: "a.png",
    inputAsset: "",
    idTouched: true,
  },
  {
    key: 2,
    id: "beta",
    name: "B",
    primaryColor: "#E0218A",
    logoPath: "b.png",
    inputAsset: "",
    idTouched: true,
  },
];

describe("validateStep", () => {
  test("maxMinDistance is the six always-active Hamming axes while no optional axis is exposed", () => {
    expect(maxMinDistance(initialWizardState)).toBe(6);
  });

  test("type requires a path-safe brief id", () => {
    expect(validateStep("type", initialWizardState).briefId).toBe(messages.briefId);
    expect(validateStep("type", { ...initialWizardState, briefId: "camp" })).toEqual({});
  });

  test("products require unique path-safe ids, hex colours, names, logos, and a mode minimum", () => {
    const empty = validateStep("products", initialWizardState);
    expect(empty.products).toBe(messages.products(2, "Classic"));
    expect(empty["product-0-id"]).toBe(messages.productId);
    expect(empty["product-0-name"]).toBe(messages.productName);
    expect(empty["product-0-logo"]).toBe(messages.productLogo);

    const badColor: WizardState = {
      ...initialWizardState,
      products: [{ ...validProducts()[0], primaryColor: "blue" }, validProducts()[1]],
    };
    expect(validateStep("products", badColor)["product-0-color"]).toBe(messages.productColor);

    const dup: WizardState = {
      ...initialWizardState,
      products: [validProducts()[0], { ...validProducts()[1], id: "alpha" }],
    };
    expect(validateStep("products", dup)["product-1-id"]).toBe(messages.productIdDuplicate("alpha"));

    expect(validateStep("products", { ...initialWizardState, products: validProducts() })).toEqual({});

    const one: WizardState = {
      ...initialWizardState,
      mode: "variation",
      products: [validProducts()[0]],
    };
    expect(validateStep("products", one)).toEqual({});
    expect(
      validateStep("products", { ...initialWizardState, mode: "variation", products: [emptyProduct(1)] })
        .products,
    ).toBe(messages.products(1, "Randomized"));
  });

  test("copy requires region, audience, and message", () => {
    const errors = validateStep("copy", initialWizardState);
    expect(errors.targetRegion).toBe(messages.targetRegion);
    expect(errors.targetAudience).toBe(messages.targetAudience);
    expect(errors.campaignMessage).toBe(messages.campaignMessage);
    expect(
      validateStep("copy", {
        ...initialWizardState,
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "Hi",
      }),
    ).toEqual({});
  });

  test("policy is skipped for classic and checks numeric fields when randomized", () => {
    expect(validateStep("policy", initialWizardState)).toEqual({});
    const base: WizardState = { ...initialWizardState, mode: "variation" };
    expect(validateStep("policy", { ...base, variation: { ...base.variation, count: "" } }).count).toBe(messages.count);
    expect(validateStep("policy", { ...base, variation: { ...base.variation, seed: "nope" } }).seed).toBe(messages.seed);
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, seed: "1.5" } }).seed,
    ).toBe(messages.seed);
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, seed: "4294967296" } }).seed,
    ).toBe(messages.seed);
    // The bound follows the active axes: six without the headline axis, seven with it.
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, minDistance: "-1" } }).minDistance,
    ).toBe(messages.minDistance(6));
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, minDistance: "7" } }).minDistance,
    ).toBe(messages.minDistance(6));
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, minDistance: "6" } }).minDistance,
    ).toBeUndefined();
    expect(maxMinDistance(base)).toBe(6);
    const pooled: WizardState = { ...base, variation: { ...base.variation, headline: true } };
    expect(maxMinDistance(pooled)).toBe(7);
    expect(
      validateStep("policy", { ...pooled, variation: { ...pooled.variation, minDistance: "7" } }).minDistance,
    ).toBeUndefined();
    expect(
      validateStep("policy", { ...pooled, variation: { ...pooled.variation, minDistance: "8" } }).minDistance,
    ).toBe(messages.minDistance(7));

    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, perProduct: "1.5" } }).perProduct,
    ).toBe(messages.perProduct);
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, perRatio: "x" } }).perRatio,
    ).toBe(messages.perRatio);
    expect(validateStep("policy", base)).toEqual({});
    expect(
      validateStep("policy", {
        ...base,
        variation: { ...base.variation, seed: "0", minDistance: "6", perProduct: "", perRatio: "" },
      }),
    ).toEqual({});
    expect(
      validateStep("policy", {
        ...base,
        variation: { ...base.variation, seed: "", minDistance: "", perProduct: "", perRatio: "" },
      }),
    ).toEqual({});
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, layout: [] } }).layout,
    ).toBe(messages.layout);
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, tone: [] } }).tone,
    ).toBe(messages.tone);
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, background: [] } }).background,
    ).toBe(messages.background);
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, paletteShift: [] } }).paletteShift,
    ).toBe(messages.paletteShift);
  });

  test("output requires at least one platform; review has no extra checks", () => {
    expect(validateStep("output", { ...initialWizardState, platforms: [] }).platforms).toBe(
      messages.platforms,
    );
    expect(validateStep("output", initialWizardState)).toEqual({});
    expect(validateStep("review", initialWizardState)).toEqual({});
  });

  test("hasErrors is true only when a field is present", () => {
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ count: "nope" })).toBe(true);
  });
});
