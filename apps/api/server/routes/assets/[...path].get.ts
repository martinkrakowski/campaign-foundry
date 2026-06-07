import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";

/** Image content types we'll serve from the assets tree (brand inputs + uploaded logos). */
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/**
 * GET /assets/** — stream a brand asset (input logo or uploaded logo) from the
 * project's `assets/` tree. Used by the brief screen to preview the current logo.
 * Path-traversal guarded (confined to `<projectRoot>/assets`) and restricted to
 * known image types, with nosniff so a served file can't be reinterpreted.
 */
export default defineEventHandler(async (event) => {
  const relativePath = getRouterParam(event, "path") ?? "";
  const root = resolve(projectRoot(), "assets");
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + sep)) {
    setResponseStatus(event, 400);
    return { error: "Invalid path" };
  }
  const type = CONTENT_TYPES[extname(target).toLowerCase()];
  if (!type) {
    setResponseStatus(event, 415);
    return { error: "Unsupported asset type" };
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  setHeader(event, "content-type", type);
  setHeader(event, "x-content-type-options", "nosniff");
  setHeader(event, "cache-control", "no-store");
  return sendStream(event, createReadStream(target));
});
