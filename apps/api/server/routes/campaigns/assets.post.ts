import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import {
  ASSET_NAME_PATTERN,
  MAX_ASSET_BYTES,
  assetAbsPath,
  assetRelPath,
  decodeBase64,
  hasAllowedImageMagic,
  writeAssetFile,
} from "../../lib/asset-files.js";
import { pathExists } from "../../lib/brief-files.js";

/**
 * POST /campaigns/assets — store a PNG/JPEG under `assets/inputs/<briefId>/<name>`.
 *
 * Local authoring tool: writes are confined to `assets/inputs/<briefId>/` and never
 * touch demo logos at `assets/inputs/*.png`. Body `{ briefId, name, contentBase64 }`;
 * `name` is a SAFE_ID_PATTERN stem plus `.png`/`.jpg`/`.jpeg`. 400 on bad input or
 * magic, 413 over 2 MiB, 409 if the file already exists.
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
    if (typeof record.briefId !== "string" || !SAFE_ID_PATTERN.test(record.briefId)) {
      throw new Error(
        `briefId must be a path-safe slug (lowercase letters, digits, hyphens; max 64 chars); got ${JSON.stringify(record.briefId)}.`,
      );
    }
    if (typeof record.name !== "string" || !ASSET_NAME_PATTERN.test(record.name)) {
      throw new Error(
        `name must be a path-safe image basename (slug + .png/.jpg/.jpeg); got ${JSON.stringify(record.name)}.`,
      );
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
    return { error: error instanceof Error ? error.message : "Invalid asset upload" };
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
  if (await pathExists(absPath)) {
    setResponseStatus(event, 409);
    return { error: `Asset "${rel}" already exists.` };
  }

  await writeAssetFile(absPath, bytes);
  setResponseStatus(event, 201);
  return { path: rel };
});
