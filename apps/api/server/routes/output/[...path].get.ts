import { extname, posix } from "node:path";
import { objectStore } from "../../lib/config.js";
import { getBriefStore, getOutputStore } from "../../lib/ports/index.js";

import { requestTenant } from "../../lib/tenant.js";
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".mp4": "video/mp4",
};

/**
 * Parse a single `Range: bytes=start-end` header against a file of `size` bytes.
 * `undefined` → no (usable) range: multi-range requests are served whole (200);
 * `null` → malformed or unsatisfiable (416). Open-ended (`bytes=100-`) and
 * suffix (`bytes=-100`) forms follow RFC 9110; `end` is clamped to the last byte.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return header.includes(",") ? undefined : null;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (start >= size) return null;
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) return null;
  return { start, end };
}

/**
 * GET /output/** — stream a generated creative/proof from the output root
 * (path-traversal guarded). Honours a single byte range (Safari refuses media
 * from servers without it): 206 + Content-Range, 416 when unsatisfiable,
 * whole file for multi-range requests.
 *
 * Opens the checked target exactly once, with `O_NOFOLLOW`, and takes both the
 * size and the streamed bytes from that one handle. `resolveConfinedForRead`
 * already validated the real path, but a second lookup of that same pathname
 * (a `stat` followed by a separate `createReadStream`, as this route used to
 * do) leaves a window for the checked entry to be swapped for a symlink
 * between the two: `O_NOFOLLOW` makes a final-component swap fail the open
 * (ELOOP) instead of following the new link, and using one handle for both
 * size and bytes means whatever the path does afterward cannot desync the
 * response's Content-Length from what is actually streamed.
 *
 * Under `OBJECT_STORE=s3` this route answers 404 for EVERY request before it
 * reads anything (D204, PT-4i): the bytes come through the presigned URLs
 * `result.get` signs, so there is no output-root-relative path left to serve and
 * this route remains the fs read path.
 */
export default defineEventHandler(async (event) => {
  // The MODE, and nothing else (PT-4i, D204). This is the same rule
  // `assets.get.ts:77-83` follows and for the same reason it cannot be "the
  // store answered `missing`": `ObjectOutputStore` answers `missing` for
  // everything, so a branch written on that answer would be true by accident on
  // a deployment whose store is misconfigured, and it would put a database round
  // trip and a bucket question in front of a route that has no bytes to serve.
  // `supportsTeams` is true under s3 (it needs `STORE_BACKEND=postgres`), so
  // below this guard the route would resolve a campaign and ask about its
  // visibility on every request — which is how one class of path could tell
  // itself apart by the time its answer took. So a malformed path answers 404
  // here rather than the 400 the traversal guard gives it on fs, where the route
  // exists and that guard is its contract.
  if (objectStore() === "s3") {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }

  const rawPath = getRouterParam(event, "path") ?? "";
  const normalized = posix.normalize(rawPath);
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    setResponseStatus(event, 400);
    return { error: "Invalid path" };
  }

  const segments = normalized.split("/").filter((s) => Boolean(s) && s !== ".");
  const candidateIds: string[] = [];
  if (segments[0]) {
    candidateIds.push(segments[0]);
    if (segments[0] === "packages" && segments[1]) {
      candidateIds.push(segments[1]);
    }
  }

  const scope = requestTenant(event);
  const briefs = getBriefStore(scope);
  const campaignSegmentIndex = segments[0] === "packages" ? 1 : 0;
  const campaignSegment = segments[campaignSegmentIndex];

  // Resolve every id-shaped segment exactly once, and reuse that single
  // resolution for both the served path and the visibility check below.
  // Checking visibility against the RAW segment (the old code's separate,
  // unresolved candidateIds loop) let a uuid whose literal text collides with
  // a different campaign's slug hide a visible campaign's own output (its
  // uuid happens to equal a team-hidden campaign's slug) — campaignVisibility
  // always matches by slug, never by id. On fs the id IS the slug (D179) and
  // `supportsTeams` is false, so no lookup runs there at all, same guard
  // every other route in this PR uses.
  const resolvedSlugs = new Map<string, string>();
  if (briefs.supportsTeams) {
    for (const candidateId of candidateIds) {
      const resolved = await briefs.resolveCampaign(candidateId);
      if (resolved) resolvedSlugs.set(candidateId, resolved.slug);
    }
  }

  let resolvedPath = rawPath;
  if (campaignSegment) {
    segments[campaignSegmentIndex] = resolvedSlugs.get(campaignSegment) ?? campaignSegment;
    resolvedPath = segments.join("/");
  }

  if (briefs.supportsTeams) {
    for (const candidateId of candidateIds) {
      const slug = resolvedSlugs.get(candidateId) ?? candidateId;
      if ((await briefs.campaignVisibility(slug)) === "hidden") {
        setResponseStatus(event, 404);
        return { error: "Not found" };
      }
    }
  }

  const lookup = await getOutputStore(scope).openOutput(resolvedPath);
  if (!lookup.found) {
    if (lookup.reason === "invalid") {
      setResponseStatus(event, 400);
      return { error: "Invalid path" };
    }
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  const { file } = lookup;
  const size = file.size;
  setHeader(
    event,
    "content-type",
    CONTENT_TYPES[extname(file.name).toLowerCase()] ?? "application/octet-stream",
  );
  setHeader(event, "cache-control", "no-store");
  setHeader(event, "accept-ranges", "bytes");

  const range = parseByteRange(getRequestHeader(event, "range"), size);
  if (range === null) {
    await file.close();
    setResponseStatus(event, 416);
    setHeader(event, "content-range", `bytes */${size}`);
    return { error: "Range not satisfiable" };
  }
  if (range === undefined) {
    setHeader(event, "content-length", size);
    return sendStream(event, file.stream());
  }
  setResponseStatus(event, 206);
  setHeader(event, "content-range", `bytes ${range.start}-${range.end}/${size}`);
  setHeader(event, "content-length", range.end - range.start + 1);
  return sendStream(event, file.stream(range));
});
