import type { AspectRatioValue } from "../../../domain/value-objects/aspect-ratios.js";
import type { DisplaySize } from "../../../domain/value-objects/display-sizes.js";
import type { SafeInsets } from "./CompositorPort.js";

/**
 * Platform profile as the composition root sees it (Distribution's profile
 * table). Injected as a resolver so orchestration never depends on Distribution:
 * the generator reads `safeInsets` (D11), the planner reads `ratio` + `formats`
 * to draw motion only where a requested platform can package a clip.
 */
export interface PlatformSafeZone {
  /** Social profiles only; a display profile carries `sizes` instead (D116). */
  readonly ratio?: AspectRatioValue;
  readonly safeInsets: SafeInsets;
  /** Output formats the platform accepts (`static` | `motion`). */
  readonly formats: readonly string[];
  /** Display profiles only (A3): the units the profile accepts, with their insets. */
  readonly sizes?: readonly { readonly size: DisplaySize; readonly insets: SafeInsets }[];
}

/** Resolve a platform id from `output.platforms`; unknown ids resolve to undefined and are ignored. */
export type PlatformSafeZoneResolver = (platformId: string) => PlatformSafeZone | undefined;
