import type { AspectRatioValue } from "../../../domain/value-objects/AspectRatio.vo.js";
import type { SafeInsets } from "./CompositorPort.js";

/**
 * Platform profile as the composition root sees it (Distribution's profile
 * table). Injected as a resolver so orchestration never depends on Distribution:
 * the generator reads `safeInsets` (D11), the planner reads `ratio` + `formats`
 * to draw motion only where a requested platform can package a clip.
 */
export interface PlatformSafeZone {
  readonly ratio: AspectRatioValue;
  readonly safeInsets: SafeInsets;
  /** Output formats the platform accepts (`static` | `motion`). */
  readonly formats: readonly string[];
}

/** Resolve a platform id from `output.platforms`; unknown ids resolve to undefined and are ignored. */
export type PlatformSafeZoneResolver = (platformId: string) => PlatformSafeZone | undefined;
