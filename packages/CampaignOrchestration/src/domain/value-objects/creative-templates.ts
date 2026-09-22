/**
 * Canonical creative templates as data (D123, D128).
 *
 * Templates are library entities: ownerless, versioned, immutable per version.
 * Array position in `layers` is z-order, bottom first (D128); there is no separate
 * order field.
 */
import type { AdvertisingUnit } from "./advertising-units.js";
import type { LayerProps } from "./brief-template.js";
import type { LayerFrame } from "./creative-geometry.js";
import type { CreativeType } from "./creative-types.js";
import type { LayerKind } from "./layer-kinds.js";
import type { Track } from "./tracks.js";

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
   * Whether this layer is enabled (D129). Optional, and absent means
   * enabled — every existing template and every stored brief keeps working
   * untouched. A disabled layer is preserved in the brief's layer list and
   * counts against budgets and caps (MP-D5), but will not be rendered (M3).
   * Refused if disabling would leave a required kind with no enabled instances (MP-D4).
   */
  readonly enabled?: boolean;
  /**
   * The layer's canvas-relative frame (D130). Optional, and absent means the
   * kind's default rect — `CREATIVE_GEOMETRY` / `FULL_CANVAS_RECT` for grounds,
   * exported as `LAYER_KIND_DEFAULT_RECTS`. Canonical templates never carry
   * `frame`; that absence is the mechanism that keeps goldens unedited.
   */
  readonly frame?: LayerFrame;
  /**
   * The layer's own props (D134): overrides of the geometry this layer already
   * reads. Optional, and absent means the resolved defaults — the canonical
   * library's own layers never carry props; only a brief's materialised copy
   * can.
   */
  readonly props?: LayerProps;
  /**
   * Whether this layer is a click target (D160). Optional, and absent means
   * NOT a click target — the opposite polarity of `enabled`'s absence. This is
   * a property on a layer, never a new layer kind: the destination is the
   * brief's single `clickDestination`, not a field here, and the emission is
   * AR2's compile job. Canonical templates never carry the key; that absence
   * is what keeps the compositor goldens unedited.
   */
  readonly link?: boolean;
  /**
   * The layer's own keyframe tracks (K1). Optional, and absent means no
   * motion — the canonical library's own layers never carry tracks; only a
   * brief's materialised copy can. Only a kind this compositor draws through
   * one single mechanism may carry a defined list (K1a's kind decision).
   */
  readonly tracks?: readonly Track[];
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
      { id: "shade", kind: "shade" },
      { id: "accent", kind: "accent" },
      { id: "static-text", kind: "static-text" },
      { id: "logo", kind: "logo" },
    ],
  },
  video: {
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
