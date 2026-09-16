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
   * The music bed's encoded bytes (any container/codec ffmpeg can decode —
   * e.g. mp3/wav/m4a), muxed as a second input and re-encoded to AAC. Absent
   * (the only value VE3a's interim refusal lets through today) leaves the
   * args array and the output bytes exactly what they are without this field
   * (VE-D3). VE3b2 fills this in from an upload; nothing populates it yet.
   */
  readonly audio?: Uint8Array;
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

