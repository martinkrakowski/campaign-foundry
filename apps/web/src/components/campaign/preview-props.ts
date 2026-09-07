import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import type { AnchorOption, CreativePreviewProps, LayoutOption, ToneOption } from "./CreativePreview";
import type { PreviewShowcaseProps } from "./PreviewDock";
import { anchorAxisActive, briefStyle, isDefaultOutput, type EditorState } from "./editor-state";

/** The first entry of an optional list — undefined with the list, never a crash. */
function firstOf<T>(list: readonly T[] | undefined): T | undefined {
  return list?.[0];
}

/**
 * Whether the draft's output block would survive the projection: `toBrief` emits
 * `output` only when it diverges from the absent-key default (static × the static
 * platforms) or the loaded brief declared one. The default check is `toBrief`'s
 * own `isDefaultOutput`, which already runs the D99 classic-format gate — a
 * local mirror of `state.formats` would show a platform the brief omits.
 */
function outputShown(state: EditorState): boolean {
  if (state.outputExplicit) return true;
  return !isDefaultOutput(state);
}

/**
 * The look a composed preview draws, derived from the draft (D45): the one
 * place that answers how a preview surface is fed, shared by the rail's dock
 * and the Layout step's own frame (T7) — two hosts, one derivation, so they can
 * never disagree about the same brief.
 *
 * The look is mode-aware, exactly `ReviewStep`'s rule: a Classic brief takes its
 * look from its treatments — its axes are not the projection's (`toBrief` omits
 * them) and a draft that visited Randomized carries leftovers that must not leak
 * into the classic preview — and a Randomized brief takes the first value of each
 * axis. Motion is real: the first picked kind, only when the draft actually asked
 * for video. The ratio is left to the caller, which derives it once with
 * `derivePreviewRatio` (§6 question 4: never derive twice).
 *
 * A draft with nothing to draw answers explicitly: no product, or a product
 * whose id is still the blank placeholder, `null` — `hasProduct` is the house
 * rule (`product.id.length > 0`), and a fabricated colour would be exactly the
 * invention D26 forbids.
 */
export interface PreviewLook {
  readonly layout: LayoutOption | undefined;
  readonly tone: ToneOption | undefined;
  readonly anchor: AnchorOption | undefined;
  readonly motion: MotionKind | undefined;
  readonly primaryColor: string;
  readonly headline: string;
  readonly style: CreativePreviewProps["style"];
  readonly platformId: string | undefined;
}

export function previewLook(state: EditorState): PreviewLook | null {
  const product = state.products[0];
  if (product === undefined || product.id.length === 0) return null;
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
    layout,
    tone,
    anchor,
    motion,
    primaryColor: product.primaryColor,
    headline: state.campaignMessage,
    // The brief's style (T5) — exactly what toBrief will emit (D45: the preview
    // and the saved brief cannot disagree about the typography it shows).
    style: briefStyle(state),
    platformId: outputShown(state) ? firstOf(state.platforms) : undefined,
  };
}

/**
 * The state→dock mapping (D45): the one place that answers how the host wires
 * `PreviewDock`, in product code, so no test fixture is the only definition of it.
 * The look itself is `previewLook`, shared with the Layout step's frame.
 */
export function previewDockProps(
  state: EditorState,
  stepIndex: number,
  stepCount: number,
): PreviewShowcaseProps | null {
  const look = previewLook(state);
  if (look === null) return null;
  return {
    campaignName: state.campaignName,
    ...look,
    // The wizard readout (M2): where the walk stands, not a position in the creative set.
    step: stepIndex + 1,
    stepCount,
  };
}
