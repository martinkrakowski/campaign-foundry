/** Where the headline and logo are anchored within the creative. */
export const LAYOUT_VALUES = ["headline-bottom", "headline-top"] as const;
export type LayoutKind = (typeof LAYOUT_VALUES)[number];

/** Visual intensity of the message/brand overlay. */
export const TONE_VALUES = ["bold", "subtle"] as const;
export type ToneKind = (typeof TONE_VALUES)[number];

/**
 * Brief identifiers — product ids and treatment ids — are used as filesystem path
 * segments (`<product>/<ratio>/<treatment>.png`) and as the stable asset identity,
 * so they must be path-safe slugs: lowercase letters, digits, and hyphens; max 64
 * chars. Enforced at the brief boundary (load-brief) and again in the use case
 * (defense-in-depth for callers that bypass parsing).
 */
export const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Top-level directory names under an org's output root that are reserved by
 * the orchestrator or infrastructure and cannot be used as campaign identifiers.
 */
export const RESERVED_CAMPAIGN_IDS = ["cache", "jobs", "orgs", "packages"] as const;
export type ReservedCampaignId = (typeof RESERVED_CAMPAIGN_IDS)[number];

export function isReservedCampaignId(id: string): id is ReservedCampaignId {
  return (RESERVED_CAMPAIGN_IDS as readonly string[]).includes(id);
}

/**
 * Derive a campaign slug from a display name (D178: the server derives the
 * slug at Create). Mirrored from `apps/web/src/components/campaign/editor-state.ts:220`
 * — the web imports only type-level from this package's root (the barrel
 * pulls `node:fs` into the client bundle via `project-root.ts`, the same
 * reason `RESERVED_CAMPAIGN_IDS` is mirrored in `apps/web/.../validate.ts`),
 * so it keeps its own copy rather than importing this one; `Treatment.vo.test.ts`
 * pins the same cases both copies must agree on. Lowercase, a run of
 * non-`[a-z0-9]` becomes one hyphen, leading/trailing hyphens trimmed, cut to
 * 64 characters, and — because the cut can land mid-hyphen-run — trimmed
 * again. An input with no letter or digit answers `""`; the caller decides
 * what that means (PT-5b2: a 400).
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/**
 * Treatment — a named creative treatment (layout + tone) the campaign requests.
 *
 * The pipeline produces one creative per product × aspect ratio × treatment, so
 * the compositor stays data-driven: layout and tone are *inputs*, never hardcoded.
 * "Generate variations" is therefore a function of the brief.
 */
export interface Treatment {
  readonly id: string;
  readonly layout: LayoutKind;
  readonly tone: ToneKind;
}

/** The single treatment used when a brief specifies none — preserves prior behaviour. */
export const DEFAULT_TREATMENT: Treatment = {
  id: "default",
  layout: "headline-bottom",
  tone: "bold",
};
