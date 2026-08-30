import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("globals.css motion contract (D27 / D28 / W2b.4)", () => {
  const cssPath = resolve(__dirname, "../../../app/globals.css");
  const cssContent = readFileSync(cssPath, "utf-8");

  test("exactly four looping animations exist in globals.css (the four motion-kind previews)", () => {
    // Matches all rules with `infinite` animation in globals.css
    // Catch every way a loop can be written, not just `animation: <name> … infinite`:
    // the name may follow `infinite` in the shorthand, and the count may be set on its
    // own property. A guard that only knows one spelling is a guard a refactor walks past.
    const shorthand = Array.from(cssContent.matchAll(/animation:\s*([^;]*infinite[^;]*);/g));
    const longhand = Array.from(cssContent.matchAll(/animation-iteration-count:\s*infinite/g));
    expect(longhand, "a loop declared via animation-iteration-count bypasses the shorthand guard").toHaveLength(0);
    const animationNames = shorthand.map((m) => {
      const token = m[1].split(/\s+/).find((t) => /^kf-|^[a-z][a-z0-9-]*$/.test(t) && t !== "infinite" && !/^\d/.test(t) && !t.endsWith("s") && !t.startsWith("cubic-") && !t.startsWith("ease") && t !== "both" && t !== "linear" && t !== "alternate");
      return token ?? m[1];
    });
    const infiniteMatches = shorthand;

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
