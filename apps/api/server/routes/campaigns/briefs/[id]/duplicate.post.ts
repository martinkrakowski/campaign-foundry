import { basename } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import {
  extractSourceAssetBriefIds,
  rewriteAssetPaths,
} from "../../../../lib/asset-files.js";
import {
  briefYamlPath,
  createBriefFile,
  findBriefById,
  isExistsError,
} from "../../../../lib/brief-files.js";
import { assertSafeId } from "../../../../lib/load-brief.js";
import { getAssetStore } from "../../../../lib/ports/index.js";

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

  const source = await findBriefById(id);
  if (!source) {
    setResponseStatus(event, 404);
    return { error: `Brief "${id}" not found.` };
  }

  if (await findBriefById(newId)) {
    setResponseStatus(event, 409);
    return { error: `Brief "${newId}" already exists.` };
  }

  // Copy assets from source brief to new brief, and any referenced brief-scoped assets
  await getAssetStore().copyAssets(id, newId);
  let brief = rewriteAssetPaths({ ...source.brief, id: newId }, id, newId);
  const additionalSourceIds = extractSourceAssetBriefIds(brief, newId);
  for (const fromId of additionalSourceIds) {
    await getAssetStore().copyAssets(fromId, newId);
    brief = rewriteAssetPaths(brief, fromId, newId);
  }

  const destPath = briefYamlPath(newId);
  try {
    await createBriefFile(destPath, brief);
  } catch (error) {
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return { error: `Brief "${newId}" already exists.` };
    }
    throw error;
  }

  setResponseStatus(event, 201);
  return { file: basename(destPath), brief };
});
