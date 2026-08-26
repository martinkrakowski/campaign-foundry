import { describe, test, expect } from "vitest";
import { hasErrors, validateStep } from "../validate";
import { emptyProduct, initialWizardState, type WizardState } from "../wizard-state";

const validProducts = (): WizardState["products"] => [
  {
    id: "alpha",
    name: "A",
    primaryColor: "#1473E6",
    logoPath: "a.png",
    inputAsset: "",
    idTouched: true,
  },
  {
    id: "beta",
    name: "B",
    primaryColor: "#E0218A",
    logoPath: "b.png",
    inputAsset: "",
    idTouched: true,
  },
];

describe("validateStep", () => {
  test("type requires a path-safe brief id", () => {
    expect(validateStep("type", initialWizardState).briefId).toMatch(/Lowercase letters/);
    expect(validateStep("type", { ...initialWizardState, briefId: "camp" })).toEqual({});
  });

  test("products require unique path-safe ids, hex colours, names, logos, and a mode minimum", () => {
    const empty = validateStep("products", initialWizardState);
    expect(empty.products).toMatch(/classic/);
    expect(empty["product-0-id"]).toMatch(/path-safe/);
    expect(empty["product-0-name"]).toMatch(/required/);
    expect(empty["product-0-logo"]).toMatch(/Logo path/);

    const badColor: WizardState = {
      ...initialWizardState,
      products: [{ ...validProducts()[0], primaryColor: "blue" }, validProducts()[1]],
    };
    expect(validateStep("products", badColor)["product-0-color"]).toMatch(/hex/);

    const dup: WizardState = {
      ...initialWizardState,
      products: [validProducts()[0], { ...validProducts()[1], id: "alpha" }],
    };
    expect(validateStep("products", dup)["product-1-id"]).toMatch(/Duplicate/);

    expect(validateStep("products", { ...initialWizardState, products: validProducts() })).toEqual({});

    const one: WizardState = {
      ...initialWizardState,
      mode: "variation",
      products: [validProducts()[0]],
    };
    expect(validateStep("products", one)).toEqual({});
    expect(
      validateStep("products", { ...initialWizardState, mode: "variation", products: [emptyProduct()] })
        .products,
    ).toMatch(/randomized/);
  });

  test("copy requires region, audience, and message", () => {
    const errors = validateStep("copy", initialWizardState);
    expect(errors.targetRegion).toMatch(/required/);
    expect(errors.targetAudience).toMatch(/required/);
    expect(errors.campaignMessage).toMatch(/required/);
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
    expect(validateStep("policy", { ...base, variation: { ...base.variation, count: "" } }).count).toMatch(
      /integer/,
    );
    expect(validateStep("policy", { ...base, variation: { ...base.variation, seed: "nope" } }).seed).toMatch(
      /finite/,
    );
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, minDistance: "-1" } }).minDistance,
    ).toMatch(/integer/);
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, perProduct: "1.5" } }).perProduct,
    ).toMatch(/integer/);
    expect(
      validateStep("policy", { ...base, variation: { ...base.variation, perRatio: "x" } }).perRatio,
    ).toMatch(/integer/);
    expect(validateStep("policy", base)).toEqual({});
    expect(
      validateStep("policy", {
        ...base,
        variation: { ...base.variation, seed: "", minDistance: "", perProduct: "", perRatio: "" },
      }),
    ).toEqual({});
  });

  test("output requires at least one platform; review has no extra checks", () => {
    expect(validateStep("output", { ...initialWizardState, platforms: [] }).platforms).toMatch(
      /at least one/,
    );
    expect(validateStep("output", initialWizardState)).toEqual({});
    expect(validateStep("review", initialWizardState)).toEqual({});
  });

  test("hasErrors is true only when a field is present", () => {
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ count: "nope" })).toBe(true);
  });
});
