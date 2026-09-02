import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import type { AnchorOption, LayoutOption, ToneOption } from "./CreativePreview";
import type { PreviewShowcaseProps } from "./PreviewDock";
import { STATIC_PLATFORMS, anchorAxisActive, briefStyle, type EditorState } from "./editor-state";

/** The first entry of an optional list — undefined with the list, never a crash. */
function firstOf<T>(list: readonly T[] | undefined): T | undefined {
  return list?.[0];
}

/**
 * Whether the draft's output block would survive the projection: `toBrief` emits
 * `output` only when it diverges from the absent-key default (static × the static
 * platforms) or the loaded brief declared one. Mirrored here, not imported, because
 * `isDefaultOutput` is `toBrief`'s private — if the two ever disagree, the parity
 * test in `creative-preview.fabrication.test.tsx` is the tripwire.
 */
function outputShown(state: EditorState): boolean {
  if (state.outputExplicit) return true;
  return !(
    state.formats.length === 1 &&
    state.formats[0] === "static" &&
    state.platforms.length === STATIC_PLATFORMS.length &&
    STATIC_PLATFORMS.every((platform) => state.platforms.includes(platform))
  );
}

/**
 * The state→dock mapping (D45): the one place that answers how the host wires
 * `PreviewDock`, in product code, so no test fixture is the only definition of it.
 *
 * The look is mode-aware, exactly `ReviewStep`'s rule: a Classic brief takes its
 * look from its treatments — its axes are not the projection's (`toBrief` omits
 * them) and a draft that visited Randomized carries leftovers that must not leak
 * into the classic preview — and a Randomized brief takes the first value of each
 * axis. Motion is real: the first picked kind, only when the draft actually asked
 * for video. The ratio is left as the dock's own hint-unset default, mirroring
 * `ReviewStep`'s `derivePreviewRatio(platformId, undefined)` — the platform's own
 * ratio wins, a square otherwise (L7); the shape chips never feed the preview.
 *
 * A draft with nothing to draw answers explicitly: no product, no dock (`null`) —
 * `hasProduct` is the house rule, and a fabricated colour would be exactly the
 * invention D26 forbids.
 */
export function previewDockProps(
  state: EditorState,
  stepIndex: number,
  stepCount: number,
): PreviewShowcaseProps | null {
  const product = state.products[0];
  if (product === undefined) return null;
  const treatment = state.mode === "brief" ? state.treatments[0] : undefined;
  const layout: LayoutOption | undefined =
    treatment !== undefined
      ? (treatment.layout as LayoutOption)
      : state.mode === "variation"
        ? (firstOf(state.variation.layout) as LayoutOption | undefined)
        : undefined;
  const tone: ToneOption | undefined =
    treatment !== undefined
      ? (treatment.tone as ToneOption)
      : state.mode === "variation"
        ? (firstOf(state.variation.tone) as ToneOption | undefined)
        : undefined;
  // The anchor axis (T4): a variation-axis value, so the classic treatment look
  // carries none. It is passed only while the saved brief will carry the axis —
  // a selection still sitting on the derived top/bottom pair means the axis is
  // absent and the preview must derive from `layout`, exactly as the render
  // does. The dock must not disagree with the render (D45).
  const anchor: AnchorOption | undefined =
    treatment !== undefined
      ? undefined
      : state.mode === "variation" && anchorAxisActive(state)
        ? (firstOf(state.variation.anchor) as AnchorOption | undefined)
        : undefined;
  const wantsMotion = state.mode === "variation" && state.formats.includes("motion");
  const motion: MotionKind | undefined =
    wantsMotion && state.motion.length > 0 ? (state.motion[0] as MotionKind) : undefined;
  return {
    campaignName: state.campaignName,
    headline: state.campaignMessage,
    primaryColor: product.primaryColor,
    layout,
    tone,
    anchor,
    motion,
    // The brief's style (T5) — exactly what toBrief will emit (D45: the dock
    // and the saved brief cannot disagree about the typography it shows).
    style: briefStyle(state),
    platformId: outputShown(state) ? firstOf(state.platforms) : undefined,
    // The wizard readout (M2): where the walk stands, not a position in the creative set.
    step: stepIndex + 1,
    stepCount,
  };
}
