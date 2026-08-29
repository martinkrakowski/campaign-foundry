/**
 * The palette-shift axis: a hue rotation measured in **turns**, where `1` is a full circle.
 *
 * A browser-safe leaf, for the same reason `variation-defaults.ts` is one — the editor needs
 * to preview a shift and `VariationPolicy.vo.ts` cannot be bundled. Nothing here imports
 * anything.
 *
 * This module exists because the rotation was implemented twice: once in the compositor's
 * procedural background generator, once in the editor's swatch chip. The two disagreed about
 * negative shifts — the generator wrapped them into range, the swatch did not — so a chip
 * previewed one colour and the pipeline rendered another. One function now serves both.
 */

/** Smallest accepted shift. */
export const MIN_PALETTE_SHIFT = 0;
/**
 * Exclusive upper bound. `1` is a whole turn and therefore identical to `0`, so accepting it
 * would let a brief ask for a full rotation and silently receive none.
 */
export const MAX_PALETTE_SHIFT_EXCLUSIVE = 1;

/** True when `value` is a shift the pipeline will honour exactly as written. */
export function isPaletteShift(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PALETTE_SHIFT &&
    value < MAX_PALETTE_SHIFT_EXCLUSIVE
  );
}

/**
 * Wrap any turn count into `[0, 1)`.
 *
 * The parser refuses shifts outside that range, so in a parsed brief this is the identity.
 * It still matters for two callers the parser does not stand in front of: an editor draft,
 * which may hold anything a person has typed, and defence in depth for the renderer. Both
 * ends call this, so a preview and its render cannot disagree.
 */
export function normalizeHueTurns(turns: number): number {
  if (!Number.isFinite(turns)) return 0;
  return ((turns % 1) + 1) % 1;
}
