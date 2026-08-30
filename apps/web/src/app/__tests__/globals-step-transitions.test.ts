import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The W7 additions to the animation budget (D27, D28).
 *
 * `globals-motion.test.ts` guards the four looping previews this file must never
 * outgrow; this one guards what W7 added on top of it: the step-card slide, the
 * refusal nudge and the ready ring. Every one of them is a one-shot, and every one
 * is named in the reduced-motion block rather than swept up by a wildcard — a
 * blanket `* { animation: none }` freezes `animate-spin` mid-ring while `Button`
 * has already swapped its label for the spinner, which is a control stuck forever.
 */
describe("globals.css — the step transitions (W7.2, W7.4)", () => {
  const css = readFileSync(resolve(__dirname, "../globals.css"), "utf-8");
  const reduceBlock = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

  const NEW_CLASSES = [
    "animate-nudge",
    "animate-ready-ring",
    "step-enter-r",
    "step-enter-l",
    "step-exit-l",
    "step-exit-r",
  ];

  const declaration = (cls: string): string => {
    const rule = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
    return rule?.[1] ?? "";
  };

  test("each new animation is declared, and is a one-shot", () => {
    for (const cls of NEW_CLASSES) {
      const body = declaration(cls);
      // The rule has to exist at all: a class no stylesheet knows about is the
      // defect lane W0 existed to fix, wearing a different hat.
      expect(body, `.${cls} is not declared`).toContain("animation:");
      expect(body).not.toContain("infinite");
    }
  });

  test("each new animation has its keyframes", () => {
    for (const name of [
      "nudge",
      "ready-ring",
      "step-enter-r",
      "step-enter-l",
      "step-exit-l",
      "step-exit-r",
    ]) {
      expect(css).toContain(`@keyframes ${name}`);
    }
  });

  test("W7 added no loop: the budget is still the four motion-kind previews", () => {
    const loops = Array.from(css.matchAll(/animation:\s*[^;]*infinite[^;]*;/g));
    expect(loops).toHaveLength(4);
    expect(css).not.toContain("animation-iteration-count: infinite");
  });

  test("reduced motion names every new class, and never with a wildcard", () => {
    expect(css).not.toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*\s*\{/);
    for (const cls of NEW_CLASSES) {
      expect(reduceBlock, `.${cls} is not named in the reduced-motion block`).toContain(`.${cls}`);
    }
    expect(reduceBlock).toContain("animation: none !important");
  });

  test("reduced motion does not paint the outgoing card at all", () => {
    // The leaving card exists only to be animated out. Killing the animation but
    // leaving the card in place drops it, fully opaque, over the card that replaced
    // it — so the exit pair is not merely still, it is gone.
    for (const cls of ["step-exit-l", "step-exit-r"]) {
      const rule = reduceBlock.match(new RegExp(`\\.${cls}[^{]*\\{([^}]*)\\}`));
      expect(rule?.[1]).toContain("animation: none !important");
      expect(rule?.[1]).toContain("display: none !important");
    }
  });
});
