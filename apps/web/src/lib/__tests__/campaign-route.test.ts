import { describe, test, expect } from "vitest";
import { campaignRoute } from "../campaign-route";

describe("campaignRoute", () => {
  test("builds /brief/<id> for a slug", () => {
    expect(campaignRoute("summer-spark")).toBe("/brief/summer-spark");
  });

  test("builds /brief/<id> for a uuid", () => {
    const uuid = "6f9c7f2e-8b1a-4e9d-9c2b-1a2b3c4d5e6f";
    expect(campaignRoute(uuid)).toBe(`/brief/${uuid}`);
  });

  test("encodes a character the route would otherwise misparse", () => {
    expect(campaignRoute("a/b")).toBe("/brief/a%2Fb");
  });
});
