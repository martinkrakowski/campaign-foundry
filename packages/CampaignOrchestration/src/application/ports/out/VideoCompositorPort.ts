import type { CompositeRequest, CompositeResult } from "./CompositorPort.js";
import type { CopyTimeline } from "../../../domain/value-objects/CopyTimeline.vo.js";
import type { MotionKind } from "../../../domain/value-objects/MotionKind.vo.js";

export interface VideoCompositeRequest extends CompositeRequest {
  readonly durationSec: number;
  readonly fps: number;
  readonly motion: MotionKind;
  readonly sampleAt: readonly number[]; // t ∈ [0,1], chosen by orchestration
  /**
   * Sequenced copy (D1/D2): which beat to show at any copy clock position.
   * Absent = the legacy single-message video path (D10). The poster always
   * samples the key beat (D7).
   */
  readonly timeline?: CopyTimeline;
  /**
   * Per-scene grounds (VE5b1), keyed by the beat's own {@link CopyBeat.background}
   * asset path — a `Record` rather than an index so the adapter maps beat →
   * bytes with no bookkeeping of its own; decoded once per distinct key in
   * `prepare`. Absent, or a beat whose `background` has no entry here, means
   * the creative's own `background` (VE-D3) — the same fallback a `timeline`
   * with no per-beat backgrounds already renders today.
   *
   * `GenerateCampaignUseCase` fills this at generation (VE5b2); this lane only
   * teaches the renderer to draw it. Stills (`CompositeRequest`) never carry
   * it — there is no timeline, so no beat to key it by.
   */
  readonly backgrounds?: Readonly<Record<string, Uint8Array>>;
}

export interface VideoCompositeResult {
  readonly video: Uint8Array;
  readonly poster: Uint8Array;
  readonly sampledFrames: readonly Uint8Array[];
  readonly logoApplied: boolean;
}

export interface VideoCompositorPort {
  compositeVideo(request: VideoCompositeRequest): Promise<VideoCompositeResult>;
  compositeFrame(request: VideoCompositeRequest, atSec: number): Promise<CompositeResult>;
}

