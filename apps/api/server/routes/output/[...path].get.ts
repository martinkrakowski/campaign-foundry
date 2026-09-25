import { extname } from "node:path";
import { getOutputStore } from "../../lib/ports/index.js";

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
 */
export default defineEventHandler(async (event) => {
  const lookup = await getOutputStore(requestTenant(event)).openOutput(getRouterParam(event, "path") ?? "");
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
