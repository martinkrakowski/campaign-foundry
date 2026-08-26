import { errorMessage } from "@campaignfoundry/shared";
import {
  ASSET_NAME_PATTERN,
  MAX_ASSET_BYTES,
  assetAbsPath,
  assetRelPath,
  decodeBase64,
  hasAllowedImageMagic,
  writeAssetFile,
} from "../../lib/asset-files.js";
import { isExistsError } from "../../lib/brief-files.js";
import { assertSafeId } from "../../lib/load-brief.js";

/**
 * POST /campaigns/assets — store a PNG/JPEG under `assets/inputs/<briefId>/<name>`.
 *
 * Local authoring tool: writes are confined to `assets/inputs/<briefId>/` and never
 * touch demo logos at `assets/inputs/*.png`. Body `{ briefId, name, contentBase64 }`;
 * `name` is a SAFE_ID_PATTERN stem plus `.png`/`.jpg`/`.jpeg`. 400 on bad input or
 * magic, 413 over 2 MiB (checked before decode and again after), 409 if the file
 * already exists.
 */
export default defineEventHandler(async (event) => {
  let briefId: string;
  let name: string;
  let bytes: Buffer;
  try {
    const body: unknown = await readBody(event);
    if (typeof body !== "object" || body === null) {
      throw new Error("Asset upload must be an object.");
    }
    const record = body as Record<string, unknown>;
    assertSafeId(record.briefId, "briefId");
    if (typeof record.name !== "string" || !ASSET_NAME_PATTERN.test(record.name)) {
      throw new Error(
        `name must be a path-safe image basename (slug + .png/.jpg/.jpeg); got ${JSON.stringify(record.name)}.`,
      );
    }
    if (typeof record.contentBase64 !== "string") {
      throw new Error("contentBase64 must be standard base64.");
    }
    if (record.contentBase64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4) {
      setResponseStatus(event, 413);
      return { error: "Asset exceeds the 2 MiB size limit." };
    }
    const decoded = decodeBase64(record.contentBase64);
    if (!decoded) {
      throw new Error("contentBase64 must be standard base64.");
    }
    briefId = record.briefId;
    name = record.name;
    bytes = decoded;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  if (bytes.length > MAX_ASSET_BYTES) {
    setResponseStatus(event, 413);
    return { error: "Asset exceeds the 2 MiB size limit." };
  }
  if (!hasAllowedImageMagic(bytes)) {
    setResponseStatus(event, 400);
    return { error: "Asset must be a PNG or JPEG image." };
  }

  const absPath = assetAbsPath(briefId, name);
  const rel = assetRelPath(briefId, name);
  try {
    await writeAssetFile(absPath, bytes);
  } catch (error) {
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return { error: `Asset "${rel}" already exists.` };
    }
    throw error;
  }
  setResponseStatus(event, 201);
  return { path: rel };
});
