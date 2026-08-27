/**
 * The aspect ratios the pipeline renders, in display order.
 *
 * Re-exported from the domain rather than restated: `RATIO_VALUES` is the set
 * `AspectRatio.create` accepts and `VariationPolicy` enumerates, so a list
 * written here would be a second source of truth that drifts the first time the
 * set changes — which is exactly what this module's previous comment promised
 * it prevented, while the domain gained its own list beside it. Kept as a
 * `@/lib` module so existing importers do not need to reach into the package.
 */
export { RATIO_VALUES as ASPECT_RATIOS } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
