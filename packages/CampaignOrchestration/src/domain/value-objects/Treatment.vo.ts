/** Where the headline and logo are anchored within the creative. */
export const LAYOUT_VALUES = ["headline-bottom", "headline-top"] as const;
export type LayoutKind = (typeof LAYOUT_VALUES)[number];

/** Visual intensity of the message/brand overlay. */
export const TONE_VALUES = ["bold", "subtle"] as const;
export type ToneKind = (typeof TONE_VALUES)[number];

/**
 * Brief identifiers — product ids and treatment ids — are used as filesystem path
 * segments (`<product>/<ratio>/<treatment>.png`) and as the stable asset identity,
 * so they must be path-safe slugs: lowercase letters, digits, and hyphens; max 64
 * chars. Enforced at the brief boundary (load-brief) and again in the use case
 * (defense-in-depth for callers that bypass parsing).
 */
export const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
