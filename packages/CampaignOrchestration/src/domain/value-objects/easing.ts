/**
 * Easing (K-D7, K-D8): `easeOutCubic` moved out of the compositor
 * (`NodeCanvasCompositor.ts`, formerly unexported) so the domain's track
 * model and the compositor read one function instead of each holding its own
 * copy of "the same curve" by coincidence. The move is byte-neutral — the
 * expression below is copied verbatim, and the compositor now imports this
 * instead of defining it; K1's "no compositor change" means no compositor
 * *behaviour* change, so the goldens must not move.
 */

/**
 * The one easing every draw path already shares (the keyframing plan's §0,
 * "The question the retired plan did not answer").
 */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * A stop's easing vocabulary (K-D8): the default is `easeOutCubic`, and
 * `linear` is the one override a stop may name instead — added because a
 * per-stop override with no second value to override *to* is nothing to
 * validate, not because a second curve is wanted for its own sake. Do not add
 * a third: an unread vocabulary member is the D134 mistake repeated.
 */
export const EASING_KINDS = ["ease-out-cubic", "linear"] as const;

export type EasingKind = (typeof EASING_KINDS)[number];

/** The easing a stop resolves to when it names none (K-D8). */
export const DEFAULT_EASING: EasingKind = "ease-out-cubic";
