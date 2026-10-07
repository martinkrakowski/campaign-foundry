import { errorMessage } from "@campaignfoundry/shared";
import { ASSET_NAME_PATTERN, collectRefs } from "../../lib/asset-files.js";
import { assertSafeId } from "../../lib/load-brief.js";
import { parseStoredInputRef } from "../../lib/object-store/object-input-assets.js";
import { isAssetId, type AssetEntry } from "../../lib/ports/asset-store.port.js";
import { getAssetStore, getBriefStore, getDraftStore } from "../../lib/ports/index.js";
import { requestTenant } from "../../lib/tenant.js";

/**
 * Whether any string a draft's editor state carries, as a value or as a key, names the
 * asset. The state is an editor blob, not a brief, so `collectRefs` cannot read it. Any
 * string counts, so an unrelated field whose text equals the file name also refuses the
 * delete: the safe direction.
 */
function namesAsset(value: unknown, names: (ref: string) => boolean): boolean {
  if (typeof value === "string") return names(value);
  if (Array.isArray(value)) return value.some((item) => namesAsset(item, names));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, item]) => names(key) || namesAsset(item, names));
  }
  return false;
}

/**
 * DELETE /campaigns/assets?briefId=&id= (or &name=) — remove ONE uploaded asset (PT-9o,
 * Q10). Exactly one of `id` (an asset uuid, s3 only) and `name` (a file name). 200
 * `{ deleted: true }`. 400 bad parameters. 404: a campaign hidden from the caller, absent,
 * deleted or another org's, and an unknown asset, ONE body for all of them (D166, D210 c).
 * 409: a saved version, a version of the caller's draft, or (s3) any stored version names
 * the asset; the body never says which. The asset is freed through
 * `freeUnreferencedAssets`, whose own outcome is read back by listing again. On the file
 * store the free is best-effort and reports nothing: a file the OS refused to remove is
 * still listed and answers this same 409, the fail-safe reading of "still there".
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  const query = getQuery(event);

  let briefId: string;
  try {
    const rawBriefId: unknown = query.briefId;
    assertSafeId(rawBriefId, "briefId");
    briefId = rawBriefId;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  // A repeated `id` or `name` query parameter arrives as an array; this route
  // takes exactly one string each, so refuse rather than silently drop one side.
  if (Array.isArray(query.id) || Array.isArray(query.name)) {
    setResponseStatus(event, 400);
    return { error: "Give exactly one of id or name." };
  }

  const id = typeof query.id === "string" ? query.id : undefined;
  const name = typeof query.name === "string" ? query.name : undefined;
  if ((id === undefined) === (name === undefined)) {
    setResponseStatus(event, 400);
    return { error: "Give exactly one of id or name." };
  }
  if (id !== undefined && !isAssetId(id)) {
    setResponseStatus(event, 400);
    return { error: "Invalid asset id." };
  }
  if (name !== undefined && !ASSET_NAME_PATTERN.test(name)) {
    setResponseStatus(event, 400);
    return { error: "Invalid asset name." };
  }

  const sent = id ?? name;
  const notFound = () => {
    setResponseStatus(event, 404);
    return { error: `Asset "${sent}" not found.` };
  };

  const briefs = getBriefStore(scope);
  // Same gate as `assets.post.ts`: on fs no lookup runs (an unsaved draft's asset
  // directory has no brief file), on Postgres an unresolved ref is hidden, deleted,
  // absent or another org's, and all four answer the one 404 below.
  const resolved = briefs.supportsTeams ? await briefs.resolveCampaign(briefId) : undefined;
  if (briefs.supportsTeams && resolved === undefined) return notFound();
  const slug = resolved?.slug ?? briefId;
  const campaignId = resolved?.campaignId ?? briefId;
  const assetStore = getAssetStore(scope);

  // The save and draft routes take this same lock on the slug.
  return briefs.withBriefLock(slug, async () => {
    const entries = await assetStore.listAssets(slug);
    const entry = entries.find((candidate) =>
      id === undefined ? candidate.name === name : candidate.id === id,
    );
    if (entry === undefined) return notFound();

    const inUse = () => {
      setResponseStatus(event, 409);
      return { error: `Asset "${entry.name}" is in use.` };
    };
    // Every form a ref can take: the asset's id, its bare name (the web's own rule),
    // or a PATH that reads this file. A path goes through `parseStoredInputRef`, the
    // normaliser the renderer uses, so `./assets/inputs/<slug>/x.png` and
    // `assets/inputs/other/../<slug>/x.png` count as the file they read.
    const names = (ref: string): boolean => {
      if (ref === entry.name || ref === entry.id) return true;
      const parsed = parseStoredInputRef(ref);
      return parsed !== undefined && parsed.slug === slug && parsed.name === entry.name;
    };

    // Fail closed on a brief the store holds but cannot read. Postgres rejects by
    // itself; the file store answers `undefined` for a file that does not parse, the
    // same answer an unsaved campaign gives, and `findBriefFile` tells them apart.
    const stored = await briefs.findBriefById(slug);
    if (stored === undefined && (await briefs.findBriefFile(slug)) !== undefined) {
      throw new Error(`Brief "${slug}" exists but could not be read; nothing was freed.`);
    }
    if (stored !== undefined && collectRefs(stored.brief).some(names)) return inUse();
    const draft = await getDraftStore(scope).readDraft(campaignId, scope.userId);
    if (draft !== undefined && namesAsset(draft.state, names)) return inUse();

    await assetStore.freeUnreferencedAssets(slug, [entry.id ?? entry.name]);

    // A tombstone (D231) can land between the route's first resolve and the free —
    // the purge takes its own lock on the campaign row just before it. Re-resolve
    // now: a tombstoned campaign answers the same 404 and its bytes stay put,
    // because they belong to the purge, never to this route.
    if (briefs.supportsTeams && (await briefs.resolveCampaign(briefId)) === undefined) {
      return notFound();
    }

    // `freeUnreferencedAssets` answers void and, under s3, keeps an asset that ANY stored
    // version names. Success is what a second listing says, never what the call implied.
    const same = (candidate: AssetEntry) =>
      entry.id === undefined ? candidate.name === entry.name : candidate.id === entry.id;
    if ((await assetStore.listAssets(slug)).some(same)) return inUse();

    setResponseStatus(event, 200);
    return { deleted: true };
  });
});
