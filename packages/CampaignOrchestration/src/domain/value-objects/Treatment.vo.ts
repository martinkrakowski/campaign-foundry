/** Where the headline and logo are anchored within the creative. */
export const LAYOUT_VALUES = ["headline-bottom", "headline-top"] as const;
export type LayoutKind = (typeof LAYOUT_VALUES)[number];

/** Visual intensity of the message/brand overlay. */
export const TONE_VALUES = ["bold", "subtle"] as const;
export type ToneKind = (typeof TONE_VALUES)[number];

/**
 * A treatment id is used as a filesystem path segment (`<product>/<ratio>/<id>.png`)
 * and as the stable asset identity, so it must be a path-safe slug — lowercase
 * letters, digits, and hyphens; max 64 chars. Enforced at the brief boundary and
 * again in the use case (defense-in-depth for callers that bypass parsing).
 */
export const TREATMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Treatment — a named creative treatment (layout + tone) the campaign requests.
 *
 * The pipeline produces one creative per product × aspect ratio × treatment, so
 * the compositor stays data-driven: layout and tone are *inputs*, never hardcoded.
 * "Generate variations" is therefore a function of the brief.
 */
export interface Treatment {
  readonly id: string;
  readonly layout: LayoutKind;
  readonly tone: ToneKind;
}

/** The single treatment used when a brief specifies none — preserves prior behaviour. */
export const DEFAULT_TREATMENT: Treatment = {
  id: "default",
  layout: "headline-bottom",
  tone: "bold",
};
