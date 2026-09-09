/**
 * Pinned creative template reference and materialized layer list carried by the brief (D120, D123, D128).
 *
 * A campaign renders with no library present because the brief carries the pinned reference
 * and the materialized layer list (D123). Array position is z-order; there is no order field (D128).
 */
import { ADVERTISING_UNITS, type AdvertisingUnit } from "./advertising-units.js";
import type { CampaignType } from "./campaign-types.js";
import { CAMPAIGN_TYPE_PRESETS } from "./campaign-types.js";
import {
  CANONICAL_TEMPLATES,
  CANONICAL_TEMPLATE_IDS,
  type CanonicalTemplateId,
  type CreativeTemplateLayer,
} from "./creative-templates.js";
import { CREATIVE_TYPES, type CreativeType } from "./creative-types.js";

export interface BriefTemplate {
  readonly id: CanonicalTemplateId; // the pinned reference
  readonly version: number; // pinned; a new version is a new record (D123)
  readonly creativeType: CreativeType;
  readonly unit: AdvertisingUnit;
  readonly layers: readonly CreativeTemplateLayer[]; // materialised; array position is z-order (D128)
}

/**
 * Materializes the default template for a given campaign type from the canonical library (D120, D123).
 */
export function templateFromCanonical(type: CampaignType): BriefTemplate {
  const preset = CAMPAIGN_TYPE_PRESETS[type];
  const canonical = CANONICAL_TEMPLATES[preset.creativeType];
  return {
    id: preset.template,
    version: canonical.version,
    creativeType: preset.creativeType,
    unit: preset.unit,
    layers: canonical.layers,
  };
}

/**
 * The one shape contract a persisted brief's template must satisfy (L3a).
 *
 * A type predicate, not a validator: `unknown` becomes a `BriefTemplate` only
 * through this check, and anything else is not one. `id` is a canonical member,
 * `version` a positive integer, `creativeType` and `unit` vocabulary members,
 * and `layers` an array. It is the single guard used at both storage boundaries
 * — the editor's draft restore and the run context's `cf:brief` restore — so a
 * half-written template can never be cast through and reach `toBrief`. It checks
 * shape, never content: a valid template keeps whatever layer order it was
 * serialised with (array position IS z-order, D128).
 */
export function isBriefTemplate(value: unknown): value is BriefTemplate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === "string" &&
    (CANONICAL_TEMPLATE_IDS as readonly string[]).includes(raw.id) &&
    typeof raw.version === "number" &&
    Number.isInteger(raw.version) &&
    raw.version > 0 &&
    typeof raw.creativeType === "string" &&
    (CREATIVE_TYPES as readonly string[]).includes(raw.creativeType) &&
    typeof raw.unit === "string" &&
    (ADVERTISING_UNITS as readonly string[]).includes(raw.unit) &&
    Array.isArray(raw.layers)
  );
}
