/**
 * PlatformProfile — lookup table mapping a distribution platform onto one of the
 * three existing canvases (D11). Packaging never re-renders; it only copies the
 * matching-ratio static. Safe insets are zeros here (applied at generation later).
 */

export type CanvasRatio = "1:1" | "9:16" | "16:9";
export type PlatformFormat = "static" | "motion";

export interface SafeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface PlatformProfile {
  readonly id: string;
  readonly label: string;
  readonly ratio: CanvasRatio;
  readonly formats: readonly PlatformFormat[];
  readonly visible: boolean;
  readonly safeInsets: SafeInsets;
  readonly maxBytes: number;
}

/** Applied at generation later (D11); packaging records them but does not crop. */
const ZERO_INSETS: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Documented static-ish cap (8 MiB). Not a live platform API. */
const STATIC_MAX_BYTES = 8 * 1024 * 1024;
/** Documented motion-ish cap (100 MiB). Hidden until Phase 4. */
const MOTION_MAX_BYTES = 100 * 1024 * 1024;

export const PLATFORM_PROFILES: Readonly<Record<string, PlatformProfile>> = {
  "instagram-feed": {
    id: "instagram-feed",
    label: "Instagram Feed",
    ratio: "1:1",
    formats: ["static"],
    visible: true,
    safeInsets: ZERO_INSETS,
    maxBytes: STATIC_MAX_BYTES,
  },
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    ratio: "1:1",
    formats: ["static"],
    visible: true,
    safeInsets: ZERO_INSETS,
    maxBytes: STATIC_MAX_BYTES,
  },
  x: {
    id: "x",
    label: "X",
    ratio: "16:9",
    formats: ["static"],
    visible: true,
    safeInsets: ZERO_INSETS,
    maxBytes: STATIC_MAX_BYTES,
  },
  "instagram-story": {
    id: "instagram-story",
    label: "Instagram Story",
    ratio: "9:16",
    formats: ["motion"],
    visible: false,
    safeInsets: ZERO_INSETS,
    maxBytes: MOTION_MAX_BYTES,
  },
  "instagram-reel": {
    id: "instagram-reel",
    label: "Instagram Reel",
    ratio: "9:16",
    formats: ["motion"],
    visible: false,
    safeInsets: ZERO_INSETS,
    maxBytes: MOTION_MAX_BYTES,
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    ratio: "9:16",
    formats: ["motion"],
    visible: false,
    safeInsets: ZERO_INSETS,
    maxBytes: MOTION_MAX_BYTES,
  },
  "youtube-short": {
    id: "youtube-short",
    label: "YouTube Short",
    ratio: "9:16",
    formats: ["motion"],
    visible: false,
    safeInsets: ZERO_INSETS,
    maxBytes: MOTION_MAX_BYTES,
  },
};

/** Ids a caller may request in this wave (static canvases only). */
export function visiblePlatformIds(): readonly string[] {
  return Object.values(PLATFORM_PROFILES)
    .filter((profile) => profile.visible)
    .map((profile) => profile.id);
}

/** Lookup; unknown ids return undefined (the use case turns that into err). */
export function platformProfile(id: string): PlatformProfile | undefined {
  return PLATFORM_PROFILES[id];
}
