/**
 * The brief's click destination and the clickTag emission rule (HL2, HL-D3).
 *
 * The click destination is a first-class brief field (`clickDestination`),
 * validated as an absolute URL at the boundary. An ad that cannot be clicked
 * is not an ad, and an ad whose destination is not validated at the boundary
 * produces broken units at packaging or serve time.
 *
 * The clickTag emission rule (HL-D3):
 * Ad servers require the standard `clickTag` variable convention to wrap and
 * measure clicks; an `<a href>` produces an ad that renders and does not track,
 * which is the worst failure mode because it looks fine.
 *
 * For HL4 markup assembly:
 * 1. The brief's `clickDestination`, when present, emits as a standard `clickTag`
 *    variable declaration (e.g. `var clickTag = "<destination>";`), NEVER as an `<a href>`.
 * 2. Interactive elements (or an overlay) navigate via the `clickTag` variable
 *    (e.g. `window.open(window.clickTag)`).
 * 3. Absent destination means no `clickTag` variable is emitted in the unit.
 */

/**
 * The standard ad server click-tracking variable name (HL-D3).
 *
 * Ad servers (Google Campaign Manager, DV360, IAB standard) require the ad unit
 * to declare `clickTag` so the serving engine can detect, wrap and track clicks.
 */
export const CLICK_TAG_VARIABLE = "clickTag" as const;

/**
 * The clickTag emission rule (HL-D3, HL2).
 *
 * Recorded by HL2 so HL4 (markup assembler) implements an established decision
 * rather than inventing one:
 *
 * 1. Target: The brief's `clickDestination` field, validated as an absolute URL
 *    at the boundary, provides the default fallback destination URL.
 * 2. Emission format: When `clickDestination` is present on the brief, HL4 emits
 *    a script declaration in the HTML `<head>`:
 *      `var clickTag = "<destination>";`
 *    The ad server overwrites or wraps this variable when serving the unit.
 * 3. Navigation interaction: Clickable elements (or an overlay container) navigate
 *    via `window.open(window.clickTag)` (or `clickTag`), NEVER via `<a href="...">`.
 *    A hardcoded `href` bypasses ad-server click tracking, which is the failure
 *    mode HL-D3 forbids.
 * 4. Absent destination: If `clickDestination` is absent from the brief, no `clickTag`
 *    variable is emitted in the markup, and no interactive navigation handler is wired.
 */
export const CLICK_TAG_EMISSION_RULE = {
  variable: CLICK_TAG_VARIABLE,
  prohibitsHref: true,
  requiresAbsoluteUrl: true,
  targetWindow: "_blank",
} as const;

/**
 * Evaluates whether a string is a valid absolute URL with http or https protocol.
 */
export function isAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Why a brief's `clickDestination` is not a shape the brief may carry (HL2); undefined when it is. */
export interface ClickDestinationProblem {
  /** The field name the problem names — always "clickDestination". */
  readonly field: "clickDestination";
  /** The requirement, phrased to follow "must" in a `Campaign brief field …` message. */
  readonly must: string;
  /** The offending value, for the message's `got <JSON>` clause. */
  readonly value: unknown;
}

/**
 * The one click destination decision both boundaries read (HL2), in the shape of
 * `layerPropsProblem` (D134) and `layerEnabledProblem` (D129). Absent `clickDestination`
 * is always fine: absence means no destination is configured. When present, it must be
 * an absolute URL (with http: or https: scheme).
 */
export function clickDestinationProblem(
  destination: unknown,
): ClickDestinationProblem | undefined {
  if (destination === undefined) return undefined;
  if (typeof destination !== "string" || !isAbsoluteUrl(destination)) {
    return {
      field: "clickDestination",
      must: "be an absolute URL",
      value: destination,
    };
  }
  return undefined;
}
