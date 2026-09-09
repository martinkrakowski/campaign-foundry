/**
 * PlatformProfile — lookup table mapping a distribution platform onto a canvas
 * (D11, D116). Packaging never re-renders; it only copies the matching-ratio
 * (social) or matching-size (display) creative. Safe insets are applied at
 * *generation*: per-ratio union of the requested social platforms, per-size
 * on a display profile (F5).
 */

export type CanvasRatio = "1:1" | "9:16" | "16:9";
export type PlatformFormat = "static" | "motion" | "html";

/**
 * Mirrors CampaignOrchestration's `DisplaySize`. Domain cannot import that
 * package (`yarn lint:arch`); the test asserts the two unions are equal.
 */
export type DisplaySize = "300x250" | "728x90" | "160x600" | "320x50" | "300x600";

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

/** One IAB unit on a display profile, with the insets that unit can actually hold. */
export interface DisplaySizeSlot {
  readonly size: DisplaySize;
  readonly insets: SafeInsets;
}

/** Which output formats the running host can produce (the API's ffmpeg probe). */
export interface PlatformCapabilities {
  readonly motion: boolean;
}

/**
 * A profile carries exactly one of `ratio` (social) or `sizes` (display).
 * Optional pair, not a `never`-discriminated union: both keys on one entry
 * must be a runtime failure so the invariant test can catch it (D116).
 */
export interface PlatformProfile {
  readonly id: string;
  readonly label: string;
  readonly ratio?: CanvasRatio;
  readonly sizes?: readonly DisplaySizeSlot[];
  readonly formats: readonly PlatformFormat[];
  readonly safeInsets: SafeInsets;
  readonly maxBytes: number;
  /** Motion profiles only — the documented clip cap the packaging check enforces. */
  readonly maxDurationSec?: number;
}

/** Narrowing helper: social profiles are the ones with a canvas ratio. */
export function isRatioProfile(
  profile: PlatformProfile,
): profile is PlatformProfile & { readonly ratio: CanvasRatio } {
  return profile.ratio !== undefined && profile.sizes === undefined;
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
/**
 * Per-size insets on display profiles (F5). 320×50 (50 px tall) and 728×90
 * (90 px tall) are zero: after type, logo and CTA compete for the short side
 * there is no remaining band that a safe area could occupy. The other three
 * units take a uniform 8 px inset — the same offset A2 recorded in the
 * display inset goldens: small enough that type stays readable on 300×250
 * and 160×600, large enough to keep chrome off the art.
 */
const DISPLAY_UNIT_INSETS: SafeInsets = { top: 8, right: 8, bottom: 8, left: 8 };

const DISPLAY_ALL_SIZES: readonly DisplaySizeSlot[] = [
  { size: "300x250", insets: DISPLAY_UNIT_INSETS },
  { size: "728x90", insets: ZERO_INSETS },
  { size: "160x600", insets: DISPLAY_UNIT_INSETS },
  { size: "320x50", insets: ZERO_INSETS },
  { size: "300x600", insets: DISPLAY_UNIT_INSETS },
];

const META_AUDIENCE_NETWORK_SIZES: readonly DisplaySizeSlot[] = [
  { size: "300x250", insets: DISPLAY_UNIT_INSETS },
  { size: "320x50", insets: ZERO_INSETS },
  { size: "300x600", insets: DISPLAY_UNIT_INSETS },
];

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
  "google-display": {
    id: "google-display",
    label: "Google Display",
    sizes: DISPLAY_ALL_SIZES,
    formats: ["static"],
    safeInsets: ZERO_INSETS,
    maxBytes: STATIC_MAX_BYTES,
  },
  "meta-audience-network": {
    id: "meta-audience-network",
    label: "Meta Audience Network",
    sizes: META_AUDIENCE_NETWORK_SIZES,
    formats: ["static"],
    safeInsets: ZERO_INSETS,
    maxBytes: STATIC_MAX_BYTES,
  },
  "display-web": {
    id: "display-web",
    label: "Display Web",
    sizes: DISPLAY_ALL_SIZES,
    formats: ["static"],
    safeInsets: ZERO_INSETS,
    maxBytes: STATIC_MAX_BYTES,
  },
};

/**
 * A profile is usable when every format it needs is available on this host.
 * `static` and `html` always are (markup assembly needs no host binary);
 * `motion` requires the ffmpeg capability.
 */
export function isPlatformVisible(profile: PlatformProfile, capabilities: PlatformCapabilities): boolean {
  return profile.formats.every((format) => format === "static" || format === "html" || capabilities.motion);
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
  const order: readonly PlatformFormat[] = ["static", "motion", "html"];
  return order.filter((f) => formats.has(f));
}

/**
 * Canvas ratios supported for motion across the given platforms.
 */
export function motionPackagedRatios(platformIds: readonly string[]): Set<CanvasRatio> {
  const ratios = new Set<CanvasRatio>();
  for (const id of platformIds) {
    const profile = PLATFORM_PROFILES[id];
    if (profile?.ratio !== undefined && profile.formats.includes("motion")) {
      ratios.add(profile.ratio);
    }
  }
  return ratios;
}

