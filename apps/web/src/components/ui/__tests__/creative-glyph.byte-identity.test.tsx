import { test, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CreativeGlyph, type LayoutOption, type ToneOption } from "../creative-glyph";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";

/**
 * W9.1 — the preview-layers refactor must not change a single byte of the
 * miniature's markup. Each combo's output is pinned against
 * `fixtures/creative-glyph.golden.json` (captured from the pre-refactor glyph;
 * see `__capture-glyph-golden.test.tsx`, deleted after capture).
 */

const LAYOUTS: readonly LayoutOption[] = ["headline-top", "headline-bottom"];
const TONES: readonly ToneOption[] = ["bold", "subtle"];
const MOTIONS: readonly (MotionKind | undefined)[] = [
  undefined,
  "ken-burns-in",
  "ken-burns-out",
  "headline-rise",
  "accent-wipe",
];

/**
 * useId emits `_r_<base36-counter>_` with a process-wide counter (React 19), so the
 * exact token varies by test order and process. Pin the ids order-stable so the
 * rendered markup is comparable to the golden fixture across runs.
 */
const normalizeIds = (html: string): string => {
  const seen = new Map<string, string>();
  let next = 0;
  return html.replace(/_r_[0-9a-z]+_/g, (id) => {
    if (!seen.has(id)) seen.set(id, `glyph-id-${next++}`);
    return seen.get(id)!;
  });
};

const combos = LAYOUTS.flatMap((layout) =>
  TONES.flatMap((tone) => MOTIONS.map((motion) => ({ layout, tone, motion }))),
);

const key = (combo: (typeof combos)[number]): string =>
  `${combo.layout}:${combo.tone}:${combo.motion ?? "undefined"}`;

const golden = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "creative-glyph.golden.json"), "utf8"),
) as Record<string, string>;

test.each(combos)(
  "renders $layout/$tone/$motion byte-identical to the pre-refactor glyph",
  (combo) => {
    const expected = golden[key(combo)];
    expect(expected).toBeDefined();
    expect(normalizeIds(render(<CreativeGlyph {...combo} />).container.innerHTML)).toBe(expected);
  },
);