import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../lib/load-brief.js";
import { ASSET_NAME_PATTERN, assetContentType } from "../../lib/asset-files.js";
import { campaignKnown } from "../../lib/ownership.js";
import { getAssetStore, getBriefStore } from "../../lib/ports/index.js";

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
  }

  // See result.get.ts: resolve a uuid to its slug on a backend that has one
  // (D178), pass a slug through unchanged otherwise — an unsaved draft has no
  // campaign row yet (assets are routinely uploaded before a brief is saved),
  // and on fs the id IS the slug (D179), so no lookup runs there. The reads
  // below already answer their own "not found" for a genuinely unknown ref.
  const briefs = getBriefStore(scope);
  const resolved = briefs.supportsTeams ? await briefs.resolveCampaign(briefId) : undefined;
  const slug = resolved?.slug ?? briefId;

  if (name !== undefined) {
    // D166 (PT-2c): a campaign hidden from this caller by team answers the same
    // "Asset ... not found" 404 as a missing asset, so the body never says which
    // applies. Only team visibility is checked here, not the listing: an unsaved
    // draft has no stored brief, and listing every asset just to read one lets an
    // unrelated file's disappearance turn a readable request into a 500.
    if (briefs.supportsTeams && (await briefs.campaignVisibility(slug)) === "hidden") {
      setResponseStatus(event, 404);
      return { error: `Asset "${name}" not found.` };
    }
    const bytes = await getAssetStore(scope).readAsset(slug, name);
    if (!bytes) {
      setResponseStatus(event, 404);
      return { error: `Asset "${name}" not found.` };
    }
    setHeader(event, "content-type", assetContentType(name));
    setHeader(event, "cache-control", "no-store");
    setHeader(event, "content-length", bytes.length);
    return bytes;
  }

  await campaignKnown(scope, slug, "asset");

  try {
    const assets = await getAssetStore(scope).listAssets(slug);
    return { assets };
  } catch (error) {
    console.warn(`[assets] could not read assets for brief ${slug}: ${errorMessage(error)}`);
    return { assets: [] };
  }
});
