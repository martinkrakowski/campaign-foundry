/**
 * Pinned creative template reference and materialized layer list carried by the brief (D120, D123, D128).
 *
 * A campaign renders with no library present because the brief carries the pinned reference
 * and the materialized layer list (D123). Array position is z-order; there is no order field (D128).
 */
import type { AdvertisingUnit } from "./advertising-units.js";
import type { CampaignType } from "./campaign-types.js";
import { CAMPAIGN_TYPE_PRESETS } from "./campaign-types.js";
import type { CanonicalTemplateId, CreativeTemplateLayer } from "./creative-templates.js";
import { CANONICAL_TEMPLATES } from "./creative-templates.js";
import type { CreativeType } from "./creative-types.js";

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
