import type { AssetEntry } from "@/lib/briefs-api";
import * as messages from "@/components/campaign/messages";

/**
 * The one shape rule the web asks about a brief's stored asset reference.
 *
 * D203: an asset reference is an ASSET ID or a PATH, and nothing else decides
 * which — not a backend probe, not a prefix heuristic, not the layer that happens
 * to hold the ref. A bare uuid is the id; anything carrying a `/` is a path.
 *
 * The pattern below is the API's own, copied rather than re-derived from
 * `apps/api/server/lib/ports/asset-store.port.ts` (`ASSET_ID_PATTERN`, whose
 * `isAssetId` doc comment says the same). A second DECISION here is how an id and
 * a path end up told apart two different ways — the editor would render a uuid
 * where the API reads a name, or store a path where the API reads an id — and
 * `lib/__tests__/asset-refs.test.ts` drives both functions from one table so the
 * copy cannot drift.
 *
 * It is deliberately the narrowest shape that is still the id: lower-case
 * canonical only. An UPPER-case uuid and a path whose last segment happens to be a
 * uuid are both NOT ids, because the server's own pattern refuses them and a ref
 * the server would read as a path must not be displayed as one.
 */
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a brief's stored ref is an asset id rather than a path (D203). */
export function isAssetId(ref: string): boolean {
  return ASSET_ID_PATTERN.test(ref);
}

/** The path an asset had under the filesystem backend — today's string, exactly. */
function pathRefFor(briefId: string, name: string): string {
  return `assets/inputs/${briefId}/${name}`;
}

/**
 * The ref to STORE for an asset: its id when the backend answered with one, the
 * path otherwise.
 *
 * Under s3 `assets.post` echoes the asset row's uuid and `listAssets` carries it on
 * every entry, so a pick or an upload stores the id and the server's own resolver
 * reads it back. Under fs no answer ever carries an id, so this returns the
 * identical path string the editor wrote before — which is what keeps every
 * fs-shaped fixture and every fs request sequence byte-identical.
 *
 * A malformed `id` is treated as absent rather than trusted: storing a ref the
 * server would read as a path is the failure this lane exists to remove, and the
 * path is always a ref the server accepts.
 */
export function assetRefFor(entry: AssetEntry, briefId: string): string {
  return entry.id !== undefined && isAssetId(entry.id) ? entry.id : pathRefFor(briefId, entry.name);
}

/**
 * Whether `ref` names this entry — the rule the Asset Bin's highlight is made of.
 *
 * An id matches on the id alone. A path matches on the campaign's own path or on
 * the bare filename, which is what today's `AssetPickerDrawer` does and what a ref
 * typed into the screen-reader mirror can be. All three clauses are load-bearing:
 * under s3 a stored ref is an id (no path and no filename left to match), and
 * under fs it is still a path (no id to match), so dropping either clause loses the
 * highlight on one backend or the other.
 */
export function refMatchesAsset(
  ref: string | undefined,
  entry: AssetEntry,
  briefId: string,
): boolean {
  if (ref === undefined) return false;
  if (entry.id !== undefined && ref === entry.id) return true;
  return ref === pathRefFor(briefId, entry.name) || ref === entry.name;
}

/** How a ref is known to be resolvable, from the listing alone. */
export type AssetRefState = "path" | "found" | "pending" | "unavailable";

/**
 * What to SHOW for a ref, given the campaign's asset listing.
 *
 * The one rule this exists to keep: an id ref NEVER renders as its uuid. A uuid in
 * the logo tile or on a beat chip is unreadable, and it is the shape the user can
 * do nothing with — no extension to read, no size, no preview. So an id is resolved
 * through the listing to a name, or the field says plainly that it cannot be.
 *
 * A path ref is untouched — its basename is its label and it carries no thumbnail
 * and no size, exactly as `LogoField` and `TimelineSection` render it today. Only a
 * backend that hands back ids gets the resolved states, and the decision is made
 * here once rather than at each of the four call sites.
 *
 * `listing === undefined` means "not fetched yet", which is a different claim from
 * an empty listing: an empty listing HAS been fetched and says the asset is gone.
 * A failed fetch resolves to `[]` for the same reason — an unknown asset is
 * unknown, and must not read "Loading…" forever.
 */
export function describeAssetRef(
  ref: string,
  listing: readonly AssetEntry[] | undefined,
): { label: string; thumbnailUrl?: string; size?: number; state: AssetRefState } {
  if (!isAssetId(ref)) {
    // The ref with no `/` is its own basename — today's `value.includes("/")`
    // branch in `LogoField` and `beat.background.split("/").pop()` in
    // `TimelineSection`, both of which are this expression.
    return { label: ref.slice(ref.lastIndexOf("/") + 1), state: "path" };
  }
  if (listing === undefined) return { label: messages.assetPending, state: "pending" };
  const entry = listing.find((candidate) => candidate.id === ref);
  if (entry === undefined) return { label: messages.assetUnavailable, state: "unavailable" };
  return {
    label: entry.name,
    thumbnailUrl: entry.thumbnailUrl,
    size: entry.size,
    state: "found",
  };
}
