import type { CompositeRequest } from "./CompositorPort.js";
import type { MotionKind } from "../../../domain/value-objects/MotionKind.vo.js";

export interface VideoCompositeRequest extends CompositeRequest {
  readonly durationSec: number;
  readonly fps: number;
  readonly motion: MotionKind;
  readonly sampleAt: readonly number[]; // t ∈ [0,1], chosen by orchestration
}

export interface VideoCompositeResult {
  readonly video: Uint8Array;
  readonly poster: Uint8Array;
  readonly sampledFrames: readonly Uint8Array[];
  readonly logoApplied: boolean;
}

export interface VideoCompositorPort {
  compositeVideo(request: VideoCompositeRequest): Promise<VideoCompositeResult>;
}
