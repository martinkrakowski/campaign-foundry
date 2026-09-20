import {
  resolveCanvas,
  type CanvasSpec,
} from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import {
  copyMotionTracks,
  groundMotionTracks,
} from "@campaignfoundry/CampaignOrchestration/motion-tracks";
import {
  TEXT_LAYER_KINDS,
  TRACKABLE_LAYER_KINDS,
  type Track,
} from "@campaignfoundry/CampaignOrchestration/tracks";

/**
 * The cell whose preset expansion the editor can honestly show (TL7, D140).
 *
 * D140 is a refusal before it is a feature: `copyMotionTracks(motion, height)`
 * is **per canvas**, and `motion` is a **per cell** axis value, so "the
 * preset's stops" is not one list across a variation run — presenting a
 * per-cell expansion as a single document list "would be a lie the operator
 * cannot check".
 *
 * The rail resolves that. It already composes exactly ONE cell and publishes
 * that cell's `motion` and `ratio`, so the expansion shown here is the one
 * belonging to the creative on screen — and it is labelled with both, which is
 * the rest of what D140 asks for.
 */
export interface PresetCell {
  readonly motion: MotionKind;
  /**
   * The canvas the preview draws, as a `CanvasSpec` rather than a ratio.
   *
   * A ratio would have been wrong twice: the previewed canvas may be a display
   * SIZE (a leaderboard is not any of the three social ratios), and the ratio
   * is not on the look at all - `preview-props.ts` says so outright, because
   * it is derived once by `derivePreviewSpec` and `studio-editor.md` §6 question 4 is "never
   * derive twice". So the caller hands over the spec it already has.
   */
  readonly canvas: CanvasSpec;
}

/**
 * What a preset motion kind expands to for one layer on one cell — the same
 * functions the compositor folds, called rather than restated (K2, TL5's rule).
 *
 * Which expander applies is a property of the layer kind, and the two families
 * are read from the domain's own lists rather than spelled out here — D121: no
 * campaign file restates the layer vocabulary, which my first draft did and a
 * test caught. **Ground means "trackable but not text"**, which is exactly what
 * those two lists mean together today. `TRACKABLE_LAYER_KINDS`' own comment
 * names the one way that could change — `accent`, if K2 ever gives the wipe a
 * representable property — and that widening needs a decision here rather than
 * silently inheriting the ground expansion.
 *
 * **Text effects are deliberately absent.** `studio-editor.md` §4.4 rule 8 is about preset *motion
 * kinds*, and `textEffectTracks` needs the cell's `TextEffectKind`, which the
 * rail does not publish — so showing one would mean guessing which effect the
 * previewed cell drew. That is the lie D140 refuses, in the other direction.
 */
export function presetTracksFor(kind: LayerKind, cell: PresetCell | null): readonly Track[] {
  if (cell === null) return [];
  // Not trackable ⇒ nothing to show beside nothing: `layerTracksProblem`
  // refuses authored tracks on these kinds too.
  if (!TRACKABLE_LAYER_KINDS.includes(kind)) return [];
  return TEXT_LAYER_KINDS.includes(kind)
    ? // Through `resolveCanvas`, never by indexing the dimension table: that
      // resolver is the one reader of pixel dimensions, and a domain test
      // enforces it precisely so a second reader cannot drift from the canvas
      // the compositor actually draws.
      copyMotionTracks(cell.motion, resolveCanvas(cell.canvas).height)
    : groundMotionTracks(cell.motion);
}
