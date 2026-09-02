import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import {
  PREVIEW_FONT_RATIO,
  PREVIEW_FONT_FLOOR_FRACTION,
  PREVIEW_ANCHOR_TOP,
  PREVIEW_ANCHOR_MIDDLE,
  PREVIEW_ANCHOR_BOTTOM,
} from "../CreativePreview";
import { LAYERS } from "@/components/ui/preview-layers";

/**
 * Preview ↔ compositor geometry parity (plan 2026-09-01, C1–C5). Both layout
 * engines must read their fractions from the one browser-safe domain leaf, so
 * constant drift between the SVG preview and the render is structurally
 * impossible. The assertions are deliberately redundant in three layers: the
 * preview's exported constants are the leaf's values, the leaf holds the
 * compositor's exact numbers, and both sources import the leaf (a future fork
 * of the constants into a private copy fails the import scan).
 */
describe("preview and compositor share one creative-geometry source", () => {
  test("the preview's fractions are the domain leaf's — references, not copies", () => {
    expect(PREVIEW_FONT_RATIO).toBe(CREATIVE_GEOMETRY.headlineTypeWidthFraction);
    expect(PREVIEW_FONT_FLOOR_FRACTION).toBe(CREATIVE_GEOMETRY.headlineTypeFloorFraction);
    // Object identity: preview-layers re-exports the leaf's shade alphas, so a
    // copy that drifts from the render cannot compile its way past this test.
    expect(LAYERS.shade.alpha).toBe(CREATIVE_GEOMETRY.shadeAlpha);
  });

  test("the preview's anchor fractions are the domain leaf's — references, not copies (T4)", () => {
    expect(PREVIEW_ANCHOR_TOP).toBe(CREATIVE_GEOMETRY.headlineAnchor.top);
    expect(PREVIEW_ANCHOR_MIDDLE).toBe(CREATIVE_GEOMETRY.headlineAnchor.middle);
    expect(PREVIEW_ANCHOR_BOTTOM).toBe(CREATIVE_GEOMETRY.headlineAnchor.bottom);
  });

  test("the leaf holds the compositor's exact numbers", () => {
    expect(CREATIVE_GEOMETRY.headlineTypeWidthFraction).toBe(0.06);
    expect(CREATIVE_GEOMETRY.headlineTypeFloorFraction).toBe(0.4);
    expect(CREATIVE_GEOMETRY.logoWidthFraction).toBe(0.16);
    expect(CREATIVE_GEOMETRY.logoMarginFraction).toBe(0.04);
    expect(CREATIVE_GEOMETRY.accentSolidHeightFraction).toBe(0.05);
    expect(CREATIVE_GEOMETRY.accentFadeHeightFraction).toBe(0.06);
    expect(CREATIVE_GEOMETRY.shadeAlpha.bold).toBe(0.7);
    expect(CREATIVE_GEOMETRY.shadeAlpha.subtle).toBe(0.4);
    // The anchor axis' fractions (T4): the frozen top/bottom literals, and the
    // safe-area centre the middle anchor centres the block on.
    expect(CREATIVE_GEOMETRY.headlineAnchor.top).toBe(0.1);
    expect(CREATIVE_GEOMETRY.headlineAnchor.bottom).toBe(0.08);
    expect(CREATIVE_GEOMETRY.headlineAnchor.middle).toBe(0.5);
  });

  test("both engines import the leaf — forking the constants fails here", () => {
    const repoRoot = resolve(__dirname, "../../../../../..");
    const leafImport = "@campaignfoundry/CampaignOrchestration/creative-geometry";
    const compositor = readFileSync(
      join(repoRoot, "packages/CreativeGeneration/src/infrastructure/adapters/NodeCanvasCompositor.ts"),
      "utf-8",
    );
    const preview = readFileSync(
      join(repoRoot, "apps/web/src/components/campaign/CreativePreview.tsx"),
      "utf-8",
    );
    expect(compositor).toContain(leafImport);
    expect(preview).toContain(leafImport);
  });
});
