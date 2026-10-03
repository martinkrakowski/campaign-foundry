import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../lib/load-brief.js";
import { ASSET_NAME_PATTERN, assetContentType } from "../../lib/asset-files.js";
import { objectStore } from "../../lib/config.js";
import { campaignKnown } from "../../lib/ownership.js";
import { getAssetStore, getBriefStore } from "../../lib/ports/index.js";
import { inputAssetRedirect } from "../../lib/signed-urls.js";

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
 * - On `OBJECT_STORE=fs`: returns raw binary with matching `content-type` (image/png,
 *   image/jpeg, audio/mpeg, or audio/mp4 — VE3b2).
 * - On `OBJECT_STORE=s3`: answers 302 to a freshly presigned location (PT-4f, D209b);
 *   no bytes are read here.
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
  // (D178), pass a ref through unchanged otherwise. On fs the id IS the slug
  // (D179) and an unsaved draft has no row at all, so no lookup runs there and
  // the reads below answer their own "not found" for a ref that names no
  // directory. On Postgres every campaign is a minted row (PT-5c2), so the
  // lookup always has something to resolve and a ref that does not resolve is
  // a ref that does not exist — which is what `campaignKnown` and the `readAsset`
  // below already say, with no extra check here.
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
    // D204/D209b: under `s3` a browser never gets bucket bytes through this
    // route — it gets a 302 to a location this request just signed. The listing's
    // `thumbnailUrl` IS this URL (both adapters spell it out, unchanged), which
    // is what makes the listing cost no presign per asset and gives it no expiry.
    //
    // The branch is `objectStore() === "s3"` and NOTHING else. It cannot be
    // "the store answered `undefined` for the key": fs answers that for every
    // asset because it has no keys at all, so that test would ask fs a question
    // whose "no" means "no bucket", and pg with `OBJECT_STORE=fs` would then
    // redirect to a URL for a deployment that has none. The mode is the
    // deployment's own switch, the same one the asset store's registry is built
    // on, and it is read before any store is asked.
    if (objectStore() === "s3") {
      // A rejection PROPAGATES out of here and answers 500, like every other
      // store failure: an asset whose row exists must not read as absent, or the
      // UI reports a file nobody deleted and an operator goes looking for one.
      const redirect = await inputAssetRedirect(scope, slug, name);
      if (redirect.kind === "missing") {
        setResponseStatus(event, 404);
        return { error: `Asset "${name}" not found.` };
      }
      // `no-store` because the `location` is signed with a window, and a cached
      // 302 would outlive it: a browser replaying a cached redirect minutes later
      // would land on a 403 with nothing to tell it why.
      setResponseStatus(event, 302);
      setHeader(event, "location", redirect.location);
      setHeader(event, "cache-control", "no-store");
      // No body and NO BYTES READ: the store answers whether the object is there,
      // once the browser follows this. An object gone from under a row that exists
      // is its 404 rather than this route's, which is a deliberate change from
      // `readAsset`'s.
      return "";
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
