import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * tokens.css is the one file that decides what a theme *is*: the two blocks below are
 * the whole mechanism, and `class="dark"` on <html> is what picks between them. What is
 * asserted here is the part no component test can see — that a token exists in both
 * themes, because a token that exists in one is a colour that does not survive a toggle.
 */
const css = readFileSync(resolve(__dirname, "../tokens.css"), "utf-8");

/** One top-level rule block, by selector. */
const block = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block is missing`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("\n}", start));
};

const light = block(":root");
const dark = block(".dark");

describe("tokens.css theme contract (D24 / TOK-26 / W3.2)", () => {
  test("each theme declares a color-scheme, so native controls follow it", () => {
    // Without it a date picker, a scrollbar and the default canvas stay light under the
    // dark palette — the one thing a token cannot reach, because it is not ours.
    expect(light).toMatch(/color-scheme:\s*light\s*;/);
    expect(dark).toMatch(/color-scheme:\s*dark\s*;/);
  });

  test("the semantic state colours are stated in both themes, not inherited", () => {
    // A state colour is painted two ways — as text on its own 20% tint, and as a solid
    // ground behind white text — and one value cannot do both jobs across two themes.
    // Light used to inherit the dark set, which is why every revived tint measured
    // 1.7–3.1:1 on a light ground. Stating both is what keeps that from regressing.
    const stateTokens = ["success", "warning", "error", "info", "modified"];
    for (const token of stateTokens) {
      expect(light, `--color-${token} is missing from :root`).toContain(`--color-${token}:`);
      expect(dark, `--color-${token} is missing from .dark`).toContain(`--color-${token}:`);
    }
  });

  test("the two themes differ where they must: every surface, text and state token", () => {
    // Not a value test — the palette is a design decision and moves. What cannot move is
    // a theme that silently shares a value with the other one and so never appears.
    const perTheme = ["background", "surface", "surface-2", "border", "text-primary", "text-emphasis"];
    for (const token of perTheme) {
      expect(light, `--color-${token} is missing from :root`).toContain(`--color-${token}:`);
      expect(dark, `--color-${token} is missing from .dark`).toContain(`--color-${token}:`);
    }
  });
});

/**
 * WCAG 2.1 relative luminance and contrast, the arithmetic the contrast audits ran by
 * hand. `bg-X/20` composites in sRGB over an opaque ground and lands on an 8-bit
 * framebuffer, so the tint is quantised the way the browser actually paints it — the
 * same rounding the recorded audit numbers were measured with.
 */
const RGB = (hex: string): [number, number, number] => {
  const digits = hex.replace("#", "");
  return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
};
const linearise = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = (hex: string): number => {
  const [r, g, b] = RGB(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
};
const contrast = (a: string, b: string): number => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
/** The ground `bg-state/alpha` composites to: `alpha` of the state over the ground. */
const tinted = (state: string, alpha: number, ground: string): string =>
  `#${RGB(state)
    .map((c, i) => Math.round(alpha * c + (1 - alpha) * RGB(ground)[i]))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
/** Hue in degrees, 0–360. The state colours are chromatic, so there is no grey case. */
const hueOf = (hex: string): number => {
  const [r, g, b] = RGB(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const segment = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  return 60 * (((segment % 6) + 6) % 6);
};
const hexValue = (blockText: string, token: string): string => {
  const match = blockText.match(new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6})`));
  expect(match, `--color-${token} carries no hex value`).not.toBeNull();
  return (match as RegExpMatchArray)[1];
};

describe("the state-tint contract (the carried dark-theme contrast audit)", () => {
  const darkGrounds = { background: "#0f0f0f", surface: "#1c1c1c", "surface-2": "#262626" };
  const lightGrounds = { background: "#ffffff", surface: "#f8fafc", "surface-2": "#f1f5f9" };

  test("dark error and info clear 4.5:1 as text on their own 20% tint, on every ground chips are painted on", () => {
    // The harness itself, pinned at the one contrast everyone knows: black on white
    // is the WCAG maximum, exactly 21:1.
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 0);

    // The carried finding, pinned so the numbers it was raised with stay executable:
    // the values this pair replaced measured, on each dark ground in turn —
    expect(contrast("#ef4444", tinted("#ef4444", 0.2, "#0f0f0f"))).toBeCloseTo(4.12, 1);
    expect(contrast("#ef4444", tinted("#ef4444", 0.2, "#1c1c1c"))).toBeCloseTo(3.63, 1);
    expect(contrast("#ef4444", tinted("#ef4444", 0.2, "#262626"))).toBeCloseTo(3.24, 1);
    expect(contrast("#3b82f6", tinted("#3b82f6", 0.2, "#0f0f0f"))).toBeCloseTo(4.13, 1);
    expect(contrast("#3b82f6", tinted("#3b82f6", 0.2, "#1c1c1c"))).toBeCloseTo(3.6, 1);
    expect(contrast("#3b82f6", tinted("#3b82f6", 0.2, "#262626"))).toBeCloseTo(3.21, 1);

    // The fix, asserted against the file as it stands: small text needs 4.5:1, and the
    // chip idiom is painted over all three grounds, so the worst ground decides.
    for (const token of ["error", "info"]) {
      const value = hexValue(dark, token);
      for (const [ground, hex] of Object.entries(darkGrounds)) {
        expect(contrast(value, tinted(value, 0.2, hex)), `dark --color-${token} on its tint over ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("light error and info still clear 4.5:1 on their own tint — untouched, but guarded", () => {
    // Light's ramp-dark values were measured in W3.2 and are not re-tuned here; the
    // darkest light ground gives the darkest tint, so it is the worst case.
    for (const token of ["error", "info"]) {
      const value = hexValue(light, token);
      expect(contrast(value, tinted(value, 0.2, lightGrounds["surface-2"])), `light --color-${token} on its tint over surface-2`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the chip states stay colour-distinct (UE-D11)", () => {
    // Hue is what tells the chip states apart, and the failing pair was repaired by
    // lightening, not re-hueing — so every pair of state colours keeps a hue gap that
    // reads as a different colour, the same 30°+ separation the palette has always had.
    const values = ["success", "warning", "error", "info", "modified"].map((token) => ({
      token,
      hue: hueOf(hexValue(dark, token)),
    }));
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        const gap = Math.abs(values[i].hue - values[j].hue);
        expect(gap > 180 ? 360 - gap : gap, `${values[i].token} vs ${values[j].token}`).toBeGreaterThanOrEqual(30);
      }
    }
  });
});

describe("the solid error ground keeps readable ink in both palettes (WCAG 4.5:1)", () => {
  // One dark value cannot serve both of a state colour's jobs (the tint retune above
  // proved the bound), so the destructive button's ink is its own token and flips
  // with the ground: white on the deep light-mode red, near-black on the bright
  // dark-mode one — where white measures 2.25:1 (pinned so the number that forced
  // the token stays executable).
  test("white on the retuned dark error ground is the failure the token exists for", () => {
    expect(contrast("#ffffff", hexValue(dark, "error"))).toBeCloseTo(2.25, 1);
  });
  test("on-error over error clears 4.5:1 in both palettes", () => {
    expect(contrast(hexValue(light, "on-error"), hexValue(light, "error")), "light").toBeGreaterThanOrEqual(4.5);
    expect(contrast(hexValue(dark, "on-error"), hexValue(dark, "error")), "dark").toBeGreaterThanOrEqual(4.5);
  });
});
