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
 * Top-level directory names under an org's output root that this org's output
 * store hides from `GET /output/**` (`fs-output-store.ts`'s `HIDDEN_AREAS`,
 * which is exactly this list, HX1/D181): the run cache, the job records, the
 * `last-opened` marker, and `orgs/`, where other tenants' roots live beneath
 * the local operator's. `packages` is NOT here — packaging output stays
 * served, even though it is also a reserved campaign id below (it is a route
 * segment too).
 */
export const RESERVED_STORE_AREAS = ["cache", "jobs", "last-opened", "orgs"] as const;

/**
 * Every static first path segment under `apps/api/server/routes/campaigns/`
 * — a file (any HTTP method, including a POST-only one) or a directory —
 * excluding a dynamic segment (`[id]`), `__tests__`, and the index route
 * itself. `apps/api/server/routes/campaigns/__tests__/route-tree.test.ts`
 * derives this list from the route tree on disk and fails CI when a new
 * route forgets to add its segment here.
 *
 * A POST-only static file must be reserved too, not just a GET one: Nitro
 * registers the method on the static path, and when a GET arrives for that
 * path h3's matcher falls through to the `[id]` GET handler, so a campaign
 * slugged the same as that segment would be addressed with an empty/wrong
 * `id` rather than 404ing cleanly (grok plan review,
 * `nitropack/dist/runtime/internal/app.mjs`, `h3/dist/index.mjs`'s router
 * `matchAll` fallback).
 */
export const RESERVED_ROUTE_SEGMENTS = [
  "assets",
  "briefs",
  "capabilities",
  "decisions",
  "generate",
  "jobs",
  "last-opened",
  "package",
  "packages",
  "plan",
  "pools",
  "preview-frame",
  "provider-keys",
  "result",
  "templates",
] as const;

/**
 * Campaign identifiers the orchestrator reserves for itself, and which cannot
 * name a campaign: the union of `RESERVED_STORE_AREAS` and
 * `RESERVED_ROUTE_SEGMENTS` (HX1/D181). Kept as one flat list — rather than
 * two separate checks at each call site — so every existing caller of
 * `isReservedCampaignId` is unchanged by the split.
 */
export const RESERVED_CAMPAIGN_IDS: readonly string[] = Array.from(
  new Set<string>([...RESERVED_STORE_AREAS, ...RESERVED_ROUTE_SEGMENTS]),
);
export type ReservedCampaignId = (typeof RESERVED_CAMPAIGN_IDS)[number];

export function isReservedCampaignId(id: string): id is ReservedCampaignId {
  return RESERVED_CAMPAIGN_IDS.includes(id);
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
