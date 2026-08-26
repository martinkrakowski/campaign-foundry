import type { AspectRatioValue, PlatformSafeZoneResolver, PlanInput } from "@campaignfoundry/CampaignOrchestration";
import { platformProfile } from "@campaignfoundry/Distribution";

/**
 * Distribution's profile table as orchestration sees it: the generator reads the
 * safe insets (D11), the planner the ratio + formats (motion draws only where a
 * requested platform can package a clip).
 */
export const platformZones: PlatformSafeZoneResolver = (platformId) => {
  const profile = platformProfile(platformId);
  return profile ? { ratio: profile.ratio, safeInsets: profile.safeInsets, formats: profile.formats } : undefined;
};

/**
 * Ratios a clip can be packaged for: those of the requested motion-capable
 * platforms. No `output.platforms` leaves the draw unrestricted; platforms that
 * are all static yield `[]`, so a brief that cannot ship a clip anywhere never
 * renders one.
 */
export function motionRatiosFor(platformIds: readonly string[] | undefined): Pick<PlanInput, "motionRatios"> {
  if (!platformIds) return {};
  const motionRatios = new Set<AspectRatioValue>();
  for (const id of platformIds) {
    const zone = platformZones(id);
    if (zone?.formats.includes("motion")) motionRatios.add(zone.ratio);
  }
  return { motionRatios: [...motionRatios] };
}
