import { describe, test, expect } from "vitest";
import { assetIdentity } from "../GeneratedAsset.js";

describe("assetIdentity", () => {
  test("classic identity is product/ratio/treatment", () => {
    expect(assetIdentity({ productId: "alpha", aspectRatio: "1:1", treatment: "default" })).toBe(
      "alpha/1:1/default",
    );
  });

  test("variation identity is product/v<index> even when the triple is present", () => {
    expect(
      assetIdentity({
        productId: "alpha",
        aspectRatio: "9:16",
        treatment: "headline-top-subtle",
        variantIndex: 4,
      }),
    ).toBe("alpha/v4");
  });
});
