import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The global chrome is the one stylesheet no component can opt out of, so what it
// states has to stay on the tokens: a literal here does not follow a theme change
// (DESIGN.md §1.1) and there is no second theme in which it was ever checked.
describe("globals.css token contract (W2a.3 / SHELL-57)", () => {
  const cssPath = resolve(__dirname, "../globals.css");
  const css = readFileSync(cssPath, "utf-8");

  /** The base layer, where the app-wide rules live. */
  const baseLayer = css.slice(css.indexOf("@layer base"), css.indexOf("/* Creative glyph motion"));

  test("one focus-visible ring is declared for the whole app, on the brand token", () => {
    const rules = baseLayer.match(/:focus-visible\s*\{[^}]*\}/g) ?? [];
    expect(rules).toHaveLength(1);

    const ring = rules[0];
    expect(ring).toContain("outline: 2px solid");
    expect(ring).toContain("var(--color-brand-primary)");
    expect(ring).toContain("outline-offset: 2px");
  });

  test("selection is derived from the brand token with color-mix, not a literal", () => {
    const selection = baseLayer.match(/::selection\s*\{[^}]*\}/g) ?? [];
    expect(selection).toHaveLength(1);
    expect(selection[0]).toContain("color-mix(in srgb, var(--color-brand-primary)");
  });

  test("every scrollbar colour is a token, on both the WebKit and the standard track", () => {
    // `scrollbar-color` is the standards-track pair (thumb, track) — the engines that
    // never see the ::-webkit- rules, which is why the tokens are restated there.
    const standard = baseLayer.match(/scrollbar-color:\s*([^;]+);/);
    expect(standard).not.toBeNull();
    for (const colour of standard?.[1].trim().split(/\s+/) ?? []) {
      expect(colour === "transparent" || colour.startsWith("var(--color-")).toBe(true);
    }

    const webkitColours = Array.from(baseLayer.matchAll(/background:\s*([^;]+);/g))
      .map((m) => m[1].trim())
      .filter((value) => value !== "transparent");
    expect(webkitColours.length).toBeGreaterThan(0);
    for (const colour of webkitColours) expect(colour.startsWith("var(--color-")).toBe(true);
  });

  test("no literal colour or stock Tailwind colour appears anywhere in the file", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgb\(/);
    expect(css).not.toMatch(/\b(white|black|red-400|red-500)\b/);
  });
});
