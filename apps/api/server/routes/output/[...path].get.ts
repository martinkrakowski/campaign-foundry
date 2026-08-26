import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { outputRoot } from "../../lib/config.js";
import { resolveConfined } from "../../lib/confined-path.js";

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
 */
export default defineEventHandler(async (event) => {
  const relative = getRouterParam(event, "path") ?? "";
  const posix = relative.replace(/\\/g, "/");
  // The GenAI seed cache lives under output/cache but is not a downloadable creative.
  if (posix === "cache" || posix.startsWith("cache/")) {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  const root = resolve(outputRoot());
  let target: string;
  if (relative === "") {
    // resolveConfined rejects the base itself; GET /output/ is the root path and 404s via stat.
    target = root;
  } else {
    try {
      target = resolveConfined(root, relative);
    } catch {
      setResponseStatus(event, 400);
      return { error: "Invalid path" };
    }
  }
  let size: number;
  try {
    size = (await stat(target)).size;
  } catch {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  setHeader(event, "content-type", CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream");
  setHeader(event, "cache-control", "no-store");
  setHeader(event, "accept-ranges", "bytes");

  const range = parseByteRange(getRequestHeader(event, "range"), size);
  if (range === null) {
    setResponseStatus(event, 416);
    setHeader(event, "content-range", `bytes */${size}`);
    return { error: "Range not satisfiable" };
  }
  if (range === undefined) {
    setHeader(event, "content-length", size);
    return sendStream(event, createReadStream(target));
  }
  setResponseStatus(event, 206);
  setHeader(event, "content-range", `bytes ${range.start}-${range.end}/${size}`);
  setHeader(event, "content-length", range.end - range.start + 1);
  return sendStream(event, createReadStream(target, { start: range.start, end: range.end }));
});
