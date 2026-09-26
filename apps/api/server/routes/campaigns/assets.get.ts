import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../lib/load-brief.js";
import { ASSET_NAME_PATTERN, assetContentType } from "../../lib/asset-files.js";
import { campaignKnown } from "../../lib/ownership.js";
import { getAssetStore } from "../../lib/ports/index.js";

import { requestTenant } from "../../lib/tenant.js";
/**
 * GET /campaigns/assets?briefId=&name= — list assets or stream asset content.
 *
 * When `name` is omitted:
 * - Returns `{ assets: AssetEntry[] }` listing assets under `assets/inputs/<briefId>/`.
 * - Each entry has `name`, `type`, `size`, and `thumbnailUrl` (fetchable endpoint URL).
 * - Missing/unreadable directory returns `{ assets: [] }` (200 OK) for owned campaigns.
 * - Missing or unowned campaign returns 404 (PT-2b).
 *
 * When `name` is supplied:
 * - Returns raw binary with matching `content-type` (image/png, image/jpeg, audio/mpeg,
 *   or audio/mp4 — VE3b2).
 * - Missing asset or unowned campaign returns 404.
 * - Invalid briefId or name returns 400.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
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
    // D166 (PT-2c, thread greptile Uiug): a campaign hidden from this caller
    // by team must 404 a named-asset fetch exactly like the listing path
    // below, not stream the bytes to anyone who knows the campaign id and the
    // asset's filename.
    await campaignKnown(scope, briefId, "asset");
    const bytes = await getAssetStore(scope).readAsset(briefId, name);
    if (!bytes) {
      setResponseStatus(event, 404);
      return { error: `Asset "${name}" not found.` };
    }
    setHeader(event, "content-type", assetContentType(name));
    setHeader(event, "cache-control", "no-store");
    setHeader(event, "content-length", bytes.length);
    return bytes;
  }

  await campaignKnown(scope, briefId, "asset");

  try {
    const assets = await getAssetStore(scope).listAssets(briefId);
    return { assets };
  } catch (error) {
    console.warn(`[assets] could not read assets for brief ${briefId}: ${errorMessage(error)}`);
    return { assets: [] };
  }
});
