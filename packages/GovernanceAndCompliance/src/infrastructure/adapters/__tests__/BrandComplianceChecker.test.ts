import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { BrandComplianceChecker } from "../BrandComplianceChecker.js";

/** A solid-colour PNG buffer for density sampling. */
const solidPng = (hex: string, w = 20, h = 20): Uint8Array => {
  const c = createCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = hex;
  g.fillRect(0, 0, w, h);
  return c.toBuffer("image/png");
};

const checker = new BrandComplianceChecker();

describe("BrandComplianceChecker — legal gate", () => {
  test("passes clean copy", async () => {
    expect((await checker.validateLegalCopy("Stay wild, stay hydrated")).passed).toBe(true);
  });

  test("fails on prohibited terms and names every hit", async () => {
    const r = await checker.validateLegalCopy("Our miracle cure");
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/miracle/);
    expect(r.reason).toMatch(/cure/);
  });

  test("matches prohibited terms case-insensitively", async () => {
    expect((await checker.validateLegalCopy("GUARANTEED results")).passed).toBe(false);
  });

  test("reports every hit when copy contains several prohibited terms", async () => {
    const r = await checker.validateLegalCopy("Guaranteed risk-free miracle cure");
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/guaranteed/);
    expect(r.reason).toMatch(/risk-free/);
    expect(r.reason).toMatch(/miracle/);
    expect(r.reason).toMatch(/cure/);
  });

  describe("zero-tolerance table — must still halt (true positives)", () => {
    // Inflections, multi-word terms, and each bare term: the anchored matcher
    // must not lose a single one of these.
    const mustHalt = [
      "Results guaranteed.",
      "A miracle cure.",
      "Miracle cures for tired skin.",
      "It cured my acne.",
      "Risk-free trial.",
      "100% safe for children.",
      "No side effects.",
      "Clinically proven results.",
      "The best in the world.",
      "Guaranteed",
      "Miracle",
      "Cure",
      "Risk-free",
      "100% safe",
      "No side effects",
      "Clinically proven",
      "Best in the world",
    ];
    for (const text of mustHalt) {
      test(`halts: "${text}"`, async () => {
        const r = await checker.validateLegalCopy(text);
        expect(r.passed).toBe(false);
        expect(r.reason).toMatch(/Prohibited terminology/);
      });
    }
  });

  describe("known term-list limitation — under-matching, not a matcher defect", () => {
    // "Curing" alters the stem: it is not "cure" + suffix, so the anchored
    // matcher (like the includes()-based matcher before it) cannot reach it.
    // This test PINS the current pass, documenting the gap rather than hiding
    // it. The remedy is adding stems ("curing", "curative") to PROHIBITED_TERMS
    // — a product and legal decision, explicitly out of scope here. Do not
    // "fix" this test without that decision.
    test('passes: "Curing what ails you." — known gap, pinned', async () => {
      const r = await checker.validateLegalCopy("Curing what ails you.");
      expect(r.passed).toBe(true);
      expect(r.reason).toBeUndefined();
    });
  });

  describe("zero-tolerance table — must now pass (false positives)", () => {
    // Ordinary copy whose only "hit" was a substring inside an unrelated word
    // (secure, procurement, obscure, manicure): the gate must no longer halt.
    const mustPass = [
      "Secure your seat at Berlin Design Week.",
      "Procurement Lead — apply now.",
      "Obscure venues, unforgettable nights.",
      "Join our secure payments team.",
      "Manicure and pedicure, walk-ins welcome.",
      "Insecure by default? Never.",
    ];
    for (const text of mustPass) {
      test(`passes: "${text}"`, async () => {
        const r = await checker.validateLegalCopy(text);
        expect(r.passed).toBe(true);
        expect(r.reason).toBeUndefined();
      });
    }
  });
});

describe("BrandComplianceChecker — brand-colour density", () => {
  test("a solid brand-colour image clears the threshold at ~full density", async () => {
    const r = await checker.validateBrandColorDensity(solidPng("#1473E6"), "#1473E6");
    expect(r.passed).toBe(true);
    expect(r.score).toBeGreaterThan(0.99);
    expect(r.reason).toBeUndefined();
  });

  test("an off-brand image fails below the threshold with a reason", async () => {
    const r = await checker.validateBrandColorDensity(solidPng("#000000"), "#1473E6");
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.reason).toMatch(/below the 0.02 threshold/);
  });

  test("counts pixels within the ±10 per-channel tolerance", async () => {
    // #1473E6 = (20,115,230); #1C6BDF = (28,107,223) is within ±10 on each channel.
    const r = await checker.validateBrandColorDensity(solidPng("#1C6BDF"), "#1473E6");
    expect(r.passed).toBe(true);
  });

  test("expands a 3-digit shorthand brand hex", async () => {
    // "#14e" → (17,68,238); a solid #1144ee image is an exact match.
    const r = await checker.validateBrandColorDensity(solidPng("#1144ee"), "#14e");
    expect(r.passed).toBe(true);
  });
});
