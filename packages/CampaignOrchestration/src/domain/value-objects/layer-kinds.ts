/**
 * Creative layer kinds fixed vocabulary (D119).
 *
 * A layer kind owns one drawing responsibility and its own props (§2.1, §2.5).
 *
 * `fill` entered the vocabulary at L1 and stayed undrawn until L11 (D131); it
 * now resolves a brand role and `image-text` accepts it.
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
