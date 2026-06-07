import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { outputRoot } from "../../lib/config.js";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".json": "application/json",
};

/** GET /output/** — stream a generated creative/proof from the output root (path-traversal guarded). */
export default defineEventHandler(async (event) => {
  const relative = getRouterParam(event, "path") ?? "";
  const root = resolve(outputRoot());
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    setResponseStatus(event, 400);
    return { error: "Invalid path" };
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
