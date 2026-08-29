/**
 * PlatformProfile — lookup table mapping a distribution platform onto one of the
 * three existing canvases (D11). Packaging never re-renders; it only copies the
 * matching-ratio creative. Safe insets are applied at *generation* as the
 * per-ratio union of the requested platforms.
 */

export type CanvasRatio = "1:1" | "9:16" | "16:9";
export type PlatformFormat = "static" | "motion";

/**
 * Structurally identical to CampaignOrchestration's `CompositeRequest.safeInsets`
 * (`SafeInsets` on the compositor port). The domain layer cannot import another
 * package, so the test asserts the two types are equal instead.
 */
export interface SafeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Which output formats the running host can produce (the API's ffmpeg probe). */
export interface PlatformCapabilities {
  readonly motion: boolean;
}

export interface PlatformProfile {
  readonly id: string;
  readonly label: string;
  readonly ratio: CanvasRatio;
  readonly formats: readonly PlatformFormat[];
  readonly safeInsets: SafeInsets;
  readonly maxBytes: number;
  /** Motion profiles only — the documented clip cap the packaging check enforces. */
  readonly maxDurationSec?: number;
}

/** Static canvases keep classic geometry (zeros are a no-op in the compositor). */
const ZERO_INSETS: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
/**
 * 9:16 (1080 × 1920) UI chrome to keep headline and logo clear of. Documented
 * guidance per platform, not a live API; the compositor treats them as offsets.
 */
const VERTICAL_STORY_INSETS: SafeInsets = { top: 250, right: 0, bottom: 340, left: 0 };
const TIKTOK_INSETS: SafeInsets = { top: 250, right: 120, bottom: 400, left: 0 };
const SHORTS_INSETS: SafeInsets = { top: 200, right: 0, bottom: 360, left: 0 };

/** Documented static-ish cap (8 MiB). Not a live platform API. */
const STATIC_MAX_BYTES = 8 * 1024 * 1024;
/** Documented motion-ish cap (100 MiB). */
const MOTION_MAX_BYTES = 100 * 1024 * 1024;

export const PLATFORM_PROFILES: Readonly<Record<string, PlatformProfile>> = {
  "instagram-feed": {
    id: "instagram-feed",
    label: "Instagram Feed",
    ratio: "1:1",
    formats: ["static"],
    safeInsets: ZERO_INSETS,
    maxBytes: STATIC_MAX_BYTES,
  },
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    ratio: "1:1",
    formats: ["static"],
    safeInsets: ZERO_INSETS,
    maxBytes: STATIC_MAX_BYTES,
  },
  x: {
    id: "x",
    label: "X",
    ratio: "16:9",
    formats: ["static"],
    safeInsets: ZERO_INSETS,
    maxBytes: STATIC_MAX_BYTES,
  },
  "instagram-story": {
    id: "instagram-story",
    label: "Instagram Story",
    ratio: "9:16",
    formats: ["motion"],
    safeInsets: VERTICAL_STORY_INSETS,
    maxBytes: MOTION_MAX_BYTES,
    maxDurationSec: 60,
  },
  "instagram-reel": {
    id: "instagram-reel",
    label: "Instagram Reel",
    ratio: "9:16",
    formats: ["motion"],
    safeInsets: VERTICAL_STORY_INSETS,
    maxBytes: MOTION_MAX_BYTES,
    maxDurationSec: 90,
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    ratio: "9:16",
    formats: ["motion"],
    safeInsets: TIKTOK_INSETS,
    maxBytes: MOTION_MAX_BYTES,
    maxDurationSec: 600,
  },
  "youtube-short": {
    id: "youtube-short",
    label: "YouTube Short",
    ratio: "9:16",
    formats: ["motion"],
    safeInsets: SHORTS_INSETS,
    maxBytes: MOTION_MAX_BYTES,
    maxDurationSec: 60,
  },
};

/** A profile is usable when every format it needs is available on this host. */
export function isPlatformVisible(profile: PlatformProfile, capabilities: PlatformCapabilities): boolean {
  return profile.formats.every((format) => format === "static" || capabilities.motion);
}

/** Ids a caller may request: static canvases always, motion ones when the probe says so. */
export function visiblePlatformIds(capabilities: PlatformCapabilities): readonly string[] {
  return Object.values(PLATFORM_PROFILES)
    .filter((profile) => isPlatformVisible(profile, capabilities))
    .map((profile) => profile.id);
}

/** Lookup; unknown ids return undefined (the use case turns that into err). */
export function platformProfile(id: string): PlatformProfile | undefined {
  return PLATFORM_PROFILES[id];
}

/**
 * Formats packaged by the given platforms, in canonical order ("static" first).
 * Empty when platforms is empty or no valid platforms match.
 */
export function formatsFor(platformIds: readonly string[]): PlatformFormat[] {
  const formats = new Set<PlatformFormat>();
  for (const id of platformIds) {
    const profile = PLATFORM_PROFILES[id];
    if (profile) {
      for (const format of profile.formats) {
        formats.add(format);
      }
    }
  }
  const order: readonly PlatformFormat[] = ["static", "motion"];
  return order.filter((f) => formats.has(f));
}

/**
 * Canvas ratios supported for motion across the given platforms.
 */
export function motionPackagedRatios(platformIds: readonly string[]): Set<CanvasRatio> {
  const ratios = new Set<CanvasRatio>();
  for (const id of platformIds) {
    const profile = PLATFORM_PROFILES[id];
    if (profile && profile.formats.includes("motion")) {
      ratios.add(profile.ratio);
    }
  }
  return ratios;
}

