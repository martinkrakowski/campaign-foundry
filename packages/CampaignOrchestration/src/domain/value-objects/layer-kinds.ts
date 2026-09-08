/**
 * Creative layer kinds fixed vocabulary (D119).
 *
 * A layer kind owns one drawing responsibility and its own props (§2.1, §2.5).
 *
 * `fill` is in the vocabulary from L1 and accepted by no creative type until
 * L11 draws it (D131).
 */
export const LAYER_KINDS = [
  "image",
  "fill",
  "static-text",
  "animated-text",
  "html",
  "video",
  "logo",
  "accent",
  "shade",
] as const;

export type LayerKind = (typeof LAYER_KINDS)[number];
