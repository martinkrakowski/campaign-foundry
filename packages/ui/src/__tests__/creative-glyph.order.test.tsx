import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { CreativeGlyph } from "../creative-glyph";
import { PREVIEW_LAYER_ORDER } from "../preview-layers";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration";

/**
 * The point of L2b: the glyph paints the compositor's resolved stack order
 * (`PREVIEW_LAYER_ORDER`, D121) because it iterates it — so any drift between
 * the two breaks here.
 *
 * The expected sequence below is deliberately spelled out, not derived from
 * `PREVIEW_LAYER_ORDER` (deriving it from the same source would make this test
 * mutation-proof and worthless): it pins the composition the canonical
 * image-text template resolves to — image → shade → accent → static-text
 * (painted; the skipped `logo` kind is asserted separately).
 */

/** How the glyph identifies each painted kind in document order. The fade rect
 * has no kind of its own — it is the accent kind's accent-wipe layer — and the
 * two text bars are one static-text kind, so consecutive repeats are collapsed. */
const rectKind = (rect: Element): LayerKind => {
  if (rect.classList.contains("fill-text-muted")) return "image";
  if (rect.classList.contains("glyph-fade") || rect.classList.contains("fill-brand-primary")) return "accent";
  if ((rect.getAttribute("fill") ?? "").startsWith("url(#creative-glyph-shade-")) return "shade";
  return "static-text";
};

const paintedKinds = (container: HTMLElement): LayerKind[] => {
  const kinds: LayerKind[] = [];
  for (const kind of Array.from(container.querySelectorAll("rect")).map(rectKind)) {
    if (kinds[kinds.length - 1] !== kind) kinds.push(kind);
  }
  return kinds;
};

/** Kinds the miniature paints — everything else in the order is skipped, not thrown. */
const PAINTED: readonly LayerKind[] = ["image", "shade", "accent", "static-text"];

describe("CreativeGlyph iterates the compositor's layer order (L2b, D121)", () => {
  test("the glyphs' painted kinds, in document order, are exactly PREVIEW_LAYER_ORDER's painted kinds — in its sequence", () => {
    const { container } = render(<CreativeGlyph />);
    const seen = paintedKinds(container);
    expect(seen).toEqual(["image", "shade", "accent", "static-text"]);
    expect(PREVIEW_LAYER_ORDER.filter((kind) => PAINTED.includes(kind))).toEqual(seen);
    // The deterministic order the template resolves to — pin the full list too.
    expect(PREVIEW_LAYER_ORDER).toEqual(["image", "shade", "accent", "static-text", "logo"]);
  });

  test("a skipped kind leaves no element behind: the logo draws nothing here", () => {
    const { container } = render(<CreativeGlyph />);
    // logo has no renderer in the miniature — absent means skipped (see GlyphPainting).
    expect(container.querySelectorAll(".glyph-logo")).toHaveLength(0);
    expect(container.querySelectorAll("rect")).toHaveLength(6);
  });

  test("headline-bottom paints the same kinds in the same order, mirrored", () => {
    const { container } = render(<CreativeGlyph layout="headline-bottom" />);
    expect(paintedKinds(container)).toEqual(["image", "shade", "accent", "static-text"]);
  });
});
