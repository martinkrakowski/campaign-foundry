import { describe, test, expect } from "vitest";
import { isVariationTarget, type RegenerationTarget } from "../CampaignPipelinePort.js";

describe("isVariationTarget", () => {
  test("discriminates on numeric variantIndex", () => {
    const variation: RegenerationTarget = { productId: "alpha", variantIndex: 0 };
    const classic: RegenerationTarget = { productId: "alpha", aspectRatio: "1:1", treatment: "default" };
    expect(isVariationTarget(variation)).toBe(true);
    expect(isVariationTarget(classic)).toBe(false);
    expect(
      isVariationTarget({ productId: "alpha", variantIndex: undefined } as unknown as RegenerationTarget),
    ).toBe(false);
  });
});
