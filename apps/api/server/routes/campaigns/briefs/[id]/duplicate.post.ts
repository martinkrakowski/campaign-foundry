import { errorMessage } from "@campaignfoundry/shared";
import {
  extractSourceAssetBriefIds,
  rewriteAssetPaths,
} from "../../../../lib/asset-files.js";
import { isExistsError } from "../../../../lib/brief-files.js";
import { assertSafeId } from "../../../../lib/load-brief.js";
import { getAssetStore, getBriefStore } from "../../../../lib/ports/index.js";

/**
 * POST /campaigns/briefs/:id/duplicate — copy a yaml/yml/json brief to `briefs/<newId>.yaml`.
 *
 * Body `{ newId }` must be path-safe. Source is looked up by `brief.id` (filename
 * may differ). 404 if the source is missing, 409 if any file already has `newId`.
 * The copy gets `id: newId`; writes stay under `projectRoot()/briefs/`.
 * Copies any brief-scoped assets (`assets/inputs/<id>/*`) into `assets/inputs/<newId>/*`
 * and rewrites logoPath and inputAsset, while leaving shared root assets untouched (L5.5).
 */
export default defineEventHandler(async (event) => {
  let id: string;
  try {
    id = String(getRouterParam(event, "id"));
    assertSafeId(id, "Campaign id");
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  let newId: string;
  try {
    const body: unknown = await readBody(event);
    const value =
      typeof body === "object" && body !== null ? (body as { newId?: unknown }).newId : undefined;
    assertSafeId(value, "newId");
    newId = value;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const source = await getBriefStore().findBriefById(id);
  if (!source) {
    setResponseStatus(event, 404);
    return { error: `Brief "${id}" not found.` };
  }

  try {
    const created = await getBriefStore().withBriefLock(newId, async () => {
      if (await getBriefStore().findBriefById(newId)) {
        const existErr = new Error(`Brief "${newId}" already exists.`);
        (existErr as { code?: string }).code = "EEXIST";
        throw existErr;
      }

      // Copy assets from source brief to new brief, and any referenced brief-scoped assets
      const sourceMap = await getAssetStore().copyAssets(id, newId);
      let brief = rewriteAssetPaths({ ...source.brief, id: newId }, id, newId, sourceMap);
      const additionalSourceIds = extractSourceAssetBriefIds(brief, newId);
      for (const fromId of additionalSourceIds) {
        const addMap = await getAssetStore().copyAssets(fromId, newId);
        brief = rewriteAssetPaths(brief, fromId, newId, addMap);
      }

      return await getBriefStore().createBrief(brief);
    });
    setResponseStatus(event, 201);
    return { file: created.file, brief: created.brief };
  } catch (error) {
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return { error: `Brief "${newId}" already exists.` };
    }
    throw error;
  }
});
