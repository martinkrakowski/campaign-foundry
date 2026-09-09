/**
 * Canonical creative templates as data (D123, D128).
 *
 * Templates are library entities: ownerless, versioned, immutable per version.
 * Array position in `layers` is z-order, bottom first (D128); there is no separate
 * order field.
 */
import type { AdvertisingUnit } from "./advertising-units.js";
import type { LayerProps } from "./brief-template.js";
import type { CreativeType } from "./creative-types.js";
import type { LayerKind } from "./layer-kinds.js";

export const CANONICAL_TEMPLATE_IDS = [
  "canonical-image-text",
  "canonical-image-html",
  "canonical-video",
] as const;

export type CanonicalTemplateId = (typeof CANONICAL_TEMPLATE_IDS)[number];

export interface CreativeTemplateLayer {
  readonly id: string;
  readonly kind: LayerKind;
  /**
   * The layer's own props (D134): overrides of the geometry this layer already
   * reads. Optional, and absent means the resolved defaults — the canonical
   * library's own layers never carry props; only a brief's materialised copy
   * can.
   */
  readonly props?: LayerProps;
}

export interface CreativeTemplate {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly unit: AdvertisingUnit;
  readonly creativeType: CreativeType;
  readonly layers: readonly CreativeTemplateLayer[];
}

export const CANONICAL_TEMPLATES: Readonly<Record<CreativeType, CreativeTemplate>> = {
  "image-text": {
    id: "canonical-image-text",
    version: 1,
    name: "Canonical Image & Text",
    unit: "standard-web",
    creativeType: "image-text",
    layers: [
      { id: "image", kind: "image" },
      { id: "shade", kind: "shade" },
      { id: "accent", kind: "accent" },
      { id: "static-text", kind: "static-text" },
      { id: "logo", kind: "logo" },
    ],
  },
  "image-html": {
    id: "canonical-image-html",
    version: 1,
    name: "Canonical Image & HTML",
    unit: "standard-web",
    creativeType: "image-html",
    layers: [
      { id: "image", kind: "image" },
      { id: "html", kind: "html" },
      { id: "logo", kind: "logo" },
    ],
  },
  "video": {
    id: "canonical-video",
    version: 1,
    name: "Canonical Video",
    unit: "standard-web",
    creativeType: "video",
    layers: [
      { id: "video", kind: "video" },
      { id: "shade", kind: "shade" },
      { id: "animated-text", kind: "animated-text" },
      { id: "logo", kind: "logo" },
    ],
  },
};
