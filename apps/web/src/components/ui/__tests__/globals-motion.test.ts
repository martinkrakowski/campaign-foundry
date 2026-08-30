import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("globals.css motion contract (D27 / D28 / W2b.4)", () => {
  const cssPath = resolve(__dirname, "../../../app/globals.css");
  const cssContent = readFileSync(cssPath, "utf-8");

  test("exactly four looping animations exist in globals.css (the four motion-kind previews)", () => {
    // Matches all rules with `infinite` animation in globals.css
    const infiniteMatches = Array.from(cssContent.matchAll(/animation:\s*([a-zA-Z0-9_-]+)[^;]*infinite/g));
    const animationNames = infiniteMatches.map((m) => m[1]);

    // D27 explicitly locks the allowed looping previews to exactly these four
    const expectedLoopingAnimations = [
      "kf-ken-burns-in",
      "kf-ken-burns-out",
      "kf-headline-rise",
      "kf-accent-wipe",
    ];

    expect(animationNames.sort()).toEqual(expectedLoopingAnimations.sort());
    expect(infiniteMatches.length).toBe(4);
  });

  test("check-pop and rise-in animations are one-shot (iteration count is 1 / not infinite)", () => {
    expect(cssContent).toContain("@keyframes check-pop");
    expect(cssContent).toContain("@keyframes rise-in");

    // check-pop and rise-in must never be declared as infinite
    expect(cssContent).not.toMatch(/check-pop[^;]*infinite/);
    expect(cssContent).not.toMatch(/rise-in[^;]*infinite/);
  });

  test("reduced motion disables check-pop and rise-in without a blanket wildcard rule", () => {
    // Blanket wildcard `* { ... }` kill switch is forbidden as it would freeze spinner indicators (D28)
    expect(cssContent).not.toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*\s*\{/);

    // Reduced motion block must disable the custom animations
    const reducedMotionSection = cssContent.slice(cssContent.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotionSection).toContain(".animate-check-pop");
    expect(reducedMotionSection).toContain(".animate-rise-in");
    expect(reducedMotionSection).toContain(".stagger > *");
    expect(reducedMotionSection).toContain("animation: none !important");
  });
});
