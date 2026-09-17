import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { outputRoot } from "../../lib/config.js";
import { resolveConfined, resolveConfinedForRead } from "../../lib/confined-path.js";

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
  const relative = getRouterParam(event, "path") ?? "";
  const posix = relative.replace(/\\/g, "/");
  // The GenAI seed cache lives under output/cache and jobs under output/jobs, but neither is a downloadable creative.
  if (
    posix === "cache" ||
    posix.startsWith("cache/") ||
    posix === "jobs" ||
    posix.startsWith("jobs/")
  ) {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  const root = resolve(outputRoot());
  let target: string;
  if (relative === "") {
    // resolveConfined rejects the base itself; GET /output/ targets the root directory,
    // which open() happily reports — the isFile check below is what 404s it.
    target = root;
  } else {
    try {
      target = resolveConfined(root, relative);
    } catch {
      setResponseStatus(event, 400);
      return { error: "Invalid path" };
    }
    try {
      // A symlink inside the root may aim outside it; resolveConfinedForRead validates the
      // real path and returns it, so the open below re-checks the same real path, not a
      // lexical name that could have been swapped since.
      target = await resolveConfinedForRead(root, relative);
    } catch {
      setResponseStatus(event, 404);
      return { error: "Not found" };
    }
  }

  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    // Missing file, or the checked entry was swapped for a symlink before this open
    // (ELOOP) — both answer the same 404 a plain miss would, and neither streams a byte.
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  let st: Stats;
  try {
    st = await handle.stat();
  } catch {
    await handle.close();
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  if (!st.isFile()) {
    // Directories (the root itself, or any folder under it) are not downloadable creatives;
    // streaming one would fail with EISDIR after the 200 headers were already set.
    await handle.close();
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  const size = st.size;
  setHeader(
    event,
    "content-type",
    CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
  );
  setHeader(event, "cache-control", "no-store");
  setHeader(event, "accept-ranges", "bytes");

  const range = parseByteRange(getRequestHeader(event, "range"), size);
  if (range === null) {
    await handle.close();
    setResponseStatus(event, 416);
    setHeader(event, "content-range", `bytes */${size}`);
    return { error: "Range not satisfiable" };
  }
  const stream =
    range === undefined
      ? handle.createReadStream()
      : handle.createReadStream({ start: range.start, end: range.end });
  // FileHandle read streams close their handle when they end; this is belt-and-suspenders
  // for every exit, including a client abort (which destroys the stream without an 'end') —
  // calling handle.close() again once it is already closed does not throw.
  stream.on("close", () => {
    void handle.close();
  });
  if (range === undefined) {
    setHeader(event, "content-length", size);
    return sendStream(event, stream);
  }
  setResponseStatus(event, 206);
  setHeader(event, "content-range", `bytes ${range.start}-${range.end}/${size}`);
  setHeader(event, "content-length", range.end - range.start + 1);
  return sendStream(event, stream);
});
