import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";

/** Max accepted logo size (decoded). Logos are small; this caps abuse/memory. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Allowed image mimes → file extension. PNG/JPEG/WebP only (no SVG: script vector). */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Magic-byte signatures so we store a real image, not arbitrary base64 labelled as one. */
function sniff(buffer: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * POST /assets/logo — accept a base64 data URL for a logo image, validate it, and
 * store it under `assets/uploads/<uuid>.<ext>`. Returns the repo-relative path, which
 * the brief screen drops straight into a product's `logoPath` (so the existing
 * assets-confined resolveAssetPath accepts it unchanged at composite time).
 *
 * Shared-mode: uploads land in a shared directory, consistent with the rest of the app.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ dataUrl?: unknown }>(event);
  const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    setResponseStatus(event, 400);
    return { error: "Expected a base64 data URL for a PNG, JPEG, or WebP image." };
  }

  const declaredMime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0) {
    setResponseStatus(event, 400);
    return { error: "Empty image." };
  }
  if (buffer.length > MAX_BYTES) {
    setResponseStatus(event, 413);
    return { error: `Logo exceeds the ${MAX_BYTES / 1024 / 1024} MB limit.` };
  }
  // Trust the bytes, not the label: the sniffed type must be allowed and agree.
  const actualMime = sniff(buffer);
  if (!actualMime || actualMime !== declaredMime) {
    setResponseStatus(event, 400);
    return { error: "File is not a valid PNG, JPEG, or WebP image." };
  }

  const dir = resolve(projectRoot(), "assets", "uploads");
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${EXT_BY_MIME[actualMime]}`;
  await writeFile(resolve(dir, filename), buffer);
  return { path: `assets/uploads/${filename}` };
});
