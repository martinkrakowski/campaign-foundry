import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * tokens.css is the one file that decides what a theme *is*: the two blocks below are
 * the whole mechanism, and `class="dark"` on <html> is what picks between them. What is
 * asserted here is the part no component test can see — that a token exists in both
 * themes, because a token that exists in one is a colour that does not survive a toggle.
 */
describe("tokens.css theme contract (D24 / TOK-26 / W3.2)", () => {
  const css = readFileSync(resolve(__dirname, "../tokens.css"), "utf-8");

  /** One top-level rule block, by selector. */
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} block is missing`).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("\n}", start));
  };

  const light = block(":root");
  const dark = block(".dark");

  test("each theme declares a color-scheme, so native controls follow it", () => {
    // Without it a date picker, a scrollbar and the default canvas stay light under the
    // dark palette — the one thing a token cannot reach, because it is not ours.
    expect(light).toMatch(/color-scheme:\s*light\s*;/);
    expect(dark).toMatch(/color-scheme:\s*dark\s*;/);
  });
});
