import { extname } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../lib/load-brief.js";
import { ASSET_NAME_PATTERN } from "../../lib/asset-files.js";
import { getAssetStore } from "../../lib/ports/index.js";

/**
 * GET /campaigns/assets?briefId=&name= — list assets or stream asset content.
 *
 * When `name` is omitted:
 * - Returns `{ assets: AssetEntry[] }` listing assets under `assets/inputs/<briefId>/`.
 * - Each entry has `name`, `type`, `size`, and `thumbnailUrl` (fetchable endpoint URL).
 * - Missing/unreadable directory returns `{ assets: [] }` (200 OK).
 *
 * When `name` is supplied:
 * - Returns raw image binary with matching `content-type` (image/png or image/jpeg).
 * - Missing asset returns 404.
 * - Invalid briefId or name returns 400.
 */
export default defineEventHandler(async (event) => {
  let briefId: string;
  try {
    const raw = getQuery(event).briefId;
    const value = Array.isArray(raw) ? raw[0] : raw;
    assertSafeId(value, "briefId");
    briefId = value;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const rawName = getQuery(event).name;
  const name = Array.isArray(rawName) ? rawName[0] : rawName;

  if (name !== undefined) {
    if (typeof name !== "string" || !ASSET_NAME_PATTERN.test(name)) {
      setResponseStatus(event, 400);
      return { error: "Invalid asset name." };
    }
    const bytes = await getAssetStore().readAsset(briefId, name);
    if (!bytes) {
      setResponseStatus(event, 404);
      return { error: `Asset "${name}" not found.` };
    }
    const ext = extname(name).toLowerCase();
    const contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    setHeader(event, "content-type", contentType);
    setHeader(event, "cache-control", "no-store");
    setHeader(event, "content-length", bytes.length);
    return bytes;
  }

  try {
    const assets = await getAssetStore().listAssets(briefId);
    return { assets };
  } catch (error) {
    console.warn(`[assets] could not read assets for brief ${briefId}: ${errorMessage(error)}`);
    return { assets: [] };
  }
});
