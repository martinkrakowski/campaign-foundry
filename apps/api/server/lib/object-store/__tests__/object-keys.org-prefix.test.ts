import { describe, expect, test } from "vitest";
import { campaignPrefix, cachePrefix, orgPrefix } from "../object-keys.js";

const ORG = "acme";
const CAMPAIGN = "018f89b0-8c4d-4e3c-9b21-5d8e7c6a5b4c";

describe("the org prefix (PT-9m2, D243)", () => {
  test("orgPrefix is org slash id slash and no org can reach a sibling org", () => {
    expect(orgPrefix(ORG)).toBe("org/acme/");

    // Every narrower prefix of one org starts with the org prefix.
    expect(campaignPrefix(ORG, CAMPAIGN).startsWith(orgPrefix(ORG))).toBe(true);
    expect(cachePrefix(ORG).startsWith(orgPrefix(ORG))).toBe(true);

    // A sibling org's prefix must NOT start with this org's prefix — that is the
    // trailing `/` doing its job: `org/acme` (no slash) WOULD also match
    // `org/acme-two/...`, so both halves are asserted on purpose, the same way
    // `pt-9b`'s campaign test asserts both halves of its separator.
    expect(orgPrefix("acme-two").startsWith(orgPrefix(ORG))).toBe(false);
    expect("org/acme-two/x".startsWith(orgPrefix(ORG))).toBe(false);
    expect("org/acme-two/x".startsWith("org/acme")).toBe(true);
  });

  test("orgPrefix refuses a malformed org id", () => {
    for (const bad of ["", "acme/x", "..x", "acme x", "a".repeat(129)]) {
      expect(() => orgPrefix(bad)).toThrow("not a well-formed id");
    }
  });
});
