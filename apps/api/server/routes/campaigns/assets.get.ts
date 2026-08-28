import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../lib/load-brief.js";
import { getAssetStore } from "../../lib/ports/index.js";

/**
 * GET /campaigns/assets?briefId= — list the assets stored under `assets/inputs/<briefId>/`.
 *
 * Each asset entry contains:
 * - name: file basename (e.g. "brand-logo.png")
 * - type: MIME type (e.g. "image/png", "image/jpeg")
 * - size: byte count
 * - thumbnailUrl: data URL thumbnail representation
 *
 * Missing/unreadable brief asset directory returns `{ assets: [] }`.
 * Invalid briefId returns 400.
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

  try {
    const assets = await getAssetStore().listAssets(briefId);
    return { assets };
  } catch (error) {
    console.warn(`[assets] could not read assets for brief ${briefId}: ${errorMessage(error)}`);
    return { assets: [] };
  }
});
