import { describe, test, expect } from "vitest";
import {
  CLICK_TAG_EMISSION_RULE,
  CLICK_TAG_VARIABLE,
  clickDestinationProblem,
  isAbsoluteUrl,
} from "../click-destination.js";

describe("click-destination (HL2, HL-D3)", () => {
  describe("clickTag emission rule (HL-D3)", () => {
    test("states clickTag as the variable identifier", () => {
      expect(CLICK_TAG_VARIABLE).toBe("clickTag");
    });

    test("records the emission rule decisions for HL4", () => {
      expect(CLICK_TAG_EMISSION_RULE).toEqual({
        variable: "clickTag",
        prohibitsHref: true,
        requiresAbsoluteUrl: true,
        targetWindow: "_blank",
      });
    });
  });

  describe("isAbsoluteUrl", () => {
    test("accepts valid http and https URLs", () => {
      expect(isAbsoluteUrl("https://example.com")).toBe(true);
      expect(isAbsoluteUrl("http://example.com")).toBe(true);
      expect(isAbsoluteUrl("https://adobe.com/campaigns?source=ad&id=42#cta")).toBe(true);
      expect(isAbsoluteUrl("https://sub.domain.example.co.uk:8080/path")).toBe(true);
    });

    test("refuses relative URLs", () => {
      expect(isAbsoluteUrl("/relative/path")).toBe(false);
      expect(isAbsoluteUrl("landing.html")).toBe(false);
      expect(isAbsoluteUrl("../dest")).toBe(false);
      expect(isAbsoluteUrl("example.com")).toBe(false);
      expect(isAbsoluteUrl("")).toBe(false);
    });

    test("refuses non-http/https protocols (XSS surface and untrackable schemes)", () => {
      expect(isAbsoluteUrl("javascript:alert(1)")).toBe(false);
      expect(isAbsoluteUrl("mailto:user@example.com")).toBe(false);
      expect(isAbsoluteUrl("data:text/html,<h1>hi</h1>")).toBe(false);
      expect(isAbsoluteUrl("ftp://files.example.com")).toBe(false);
      expect(isAbsoluteUrl("file:///etc/passwd")).toBe(false);
    });

    test("refuses malformed URLs", () => {
      expect(isAbsoluteUrl("https://")).toBe(false);
      expect(isAbsoluteUrl("http://")).toBe(false);
      expect(isAbsoluteUrl("not a url")).toBe(false);
      expect(isAbsoluteUrl("https:// bad domain.com")).toBe(false);
    });
  });

  describe("clickDestinationProblem", () => {
    test("absent destination is valid — absence means no destination is configured", () => {
      expect(clickDestinationProblem(undefined)).toBeUndefined();
    });

    test("accepts valid absolute URLs", () => {
      expect(clickDestinationProblem("https://example.com")).toBeUndefined();
      expect(clickDestinationProblem("http://example.com/landing?id=1")).toBeUndefined();
    });

    test("refuses non-string values, reporting the offending value", () => {
      for (const value of [null, 123, true, {}, ["https://example.com"]]) {
        expect(clickDestinationProblem(value)).toEqual({
          field: "clickDestination",
          must: "be an absolute URL",
          value,
        });
      }
    });

    test("refuses invalid or relative URL strings, reporting the offending value", () => {
      for (const value of [
        "",
        "not-a-url",
        "/landing",
        "example.com",
        "javascript:void(0)",
        "ftp://example.com",
      ]) {
        expect(clickDestinationProblem(value)).toEqual({
          field: "clickDestination",
          must: "be an absolute URL",
          value,
        });
      }
    });
  });
});
