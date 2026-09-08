import type { AspectRatioValue, PlatformSafeZoneResolver, PlanInput } from "@campaignfoundry/CampaignOrchestration";
import { platformProfile } from "@campaignfoundry/Distribution";

/**
 * Distribution's profile table as orchestration sees it: the generator reads the
 * safe insets (D11), the planner the ratio + formats (motion draws only where a
 * requested platform can package a clip). Display profiles carry a `sizes` list
 * instead of a ratio (D116): the run path renders their units with the per-size
 * insets (F5), and the compositor's per-ratio union has nothing to join a
 * display id onto.
 */
export const platformZones: PlatformSafeZoneResolver = (platformId) => {
  const profile = platformProfile(platformId);
  if (profile === undefined) return undefined;
  if (profile.ratio !== undefined) {
    return { ratio: profile.ratio, safeInsets: profile.safeInsets, formats: profile.formats };
  }
  // Without a ratio a profile is a display one (D116's invariant test asserts
  // exactly one of the two keys); its per-size insets ride the optional field,
  // so a corrupt table entry degrades to a zone nothing unions from.
  return {
    safeInsets: profile.safeInsets,
    formats: profile.formats,
    sizes: profile.sizes,
  };
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
    if (zone?.formats.includes("motion") && zone.ratio !== undefined) motionRatios.add(zone.ratio);
  }
  return { motionRatios: [...motionRatios] };
}
