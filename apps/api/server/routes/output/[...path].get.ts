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

/** GET /output/** — stream a generated creative/proof from the output root (path-traversal guarded). */
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
  try {
    await stat(target);
  } catch {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  setHeader(event, "content-type", CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream");
  setHeader(event, "cache-control", "no-store");
  return sendStream(event, createReadStream(target));
});
