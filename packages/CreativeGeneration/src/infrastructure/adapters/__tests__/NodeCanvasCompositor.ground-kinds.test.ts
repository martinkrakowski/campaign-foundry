import { describe, test, expect } from "vitest";
import {
  GROUND_LAYER_KINDS,
  FULL_CANVAS_RECT,
  isGroundLayerKind,
} from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { LAYER_KINDS, type LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * CE2 — the anti-drift guard behind the web's whole-canvas hit regions.
 *
 * `PreviewHitRegions` gives a ground layer a region over the entire frame. The
 * claim that makes that TRUE rather than a guess is a fact about this file:
 * every kind in `GROUND_LAYER_KINDS` dispatches to `paintBackground`, and
 * `paintBackground` draws at `(0, 0, width, height)`. The web must not hold its
 * own copy of that list — so the list lives in the domain leaf, and this is the
 * test that keeps the leaf honest about the compositor.
 *
 * What it catches: giving `video` a drawer of its own (the region would then
 * describe a box the clip's drawer may not fill), pointing a third kind at
 * `paintBackground` without adding it to the set (that kind silently loses its
 * region), or adding a kind to the set that this compositor draws some other
 * way (a region over a box nothing painted). Each of those is invisible in the
 * web's own suite, which can only see the set it is handed.
 *
 * The table is reached through the TS-private seam the order suite already
 * uses: the `@generated` barrel `export *`s this file, so exporting the table
 * would leak `SKRSContext2D` from the package surface.
 */
const layerTable = (): Record<string, (c: unknown) => void> =>
  (NodeCanvasCompositor as unknown as { layerDrawers: Record<string, (c: unknown) => void> })
    .layerDrawers;

describe("GROUND_LAYER_KINDS names exactly the kinds paintBackground draws (CE2)", () => {
  test("the kinds sharing the image layer's drawer ARE the ground kinds — no more, no fewer", () => {
    const table = layerTable();
    const groundDrawer = table.image;
    // A drawer must actually be there, or the comparison below is between two
    // undefineds and says nothing.
    expect(typeof groundDrawer).toBe("function");

    const sharing = Object.keys(table).filter((kind) => table[kind] === groundDrawer);
    expect([...sharing].sort()).toEqual([...GROUND_LAYER_KINDS].sort());
  });

  test("every ground kind has a drawer, and every non-ground kind's drawer is a different one", () => {
    const table = layerTable();
    const groundDrawer = table.image;
    for (const kind of LAYER_KINDS as readonly LayerKind[]) {
      const drawer = table[kind];
      if (isGroundLayerKind(kind)) {
        expect(drawer, `${kind} is a ground kind and must dispatch to paintBackground`).toBe(
          groundDrawer,
        );
      } else {
        // `fill` (D131) has no drawer at all — nothing draws it, which is
        // exactly why it gets no hit region either.
        expect(drawer, `${kind} must not share the ground drawer`).not.toBe(groundDrawer);
      }
    }
  });

  test("the rect the web paints a ground region with is the whole canvas, in fractions", () => {
    // Stated as numbers here, not as a reference: the compositor's own call is
    // `drawImage(image, 0, 0, width, height)`, and these four are what that is
    // once divided through by the canvas.
    expect(FULL_CANVAS_RECT).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  test("every ground kind is a member of the layer vocabulary", () => {
    for (const kind of GROUND_LAYER_KINDS) {
      expect(LAYER_KINDS as readonly string[]).toContain(kind);
    }
  });
});
