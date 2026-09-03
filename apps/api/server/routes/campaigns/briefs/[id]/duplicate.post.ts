import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import {
  extractSourceAssetBriefIds,
  rewriteAssetPaths,
} from "../../../../lib/asset-files.js";
import { isExistsError, SYMLINK_WRITE_ERROR } from "../../../../lib/brief-files.js";
import { assertSafeId, parseBrief } from "../../../../lib/load-brief.js";
import { copyPool, InvalidCopyPoolError, isPoolDirSymlink, withPoolLock } from "../../../../lib/pools.js";
import { getAssetStore, getBriefStore } from "../../../../lib/ports/index.js";

/** The duplicate contract's overrides: `targetRegion` and `targetAudience` only. */
function overrideValues(overrides: unknown): Record<string, unknown> {
  if (overrides === undefined || overrides === null) return {};
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error('"overrides" must be an object.');
  }
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== "targetRegion" && key !== "targetAudience") {
      throw new Error('"overrides" accepts "targetRegion" and "targetAudience" only.');
    }
    picked[key] = value;
  }
  return picked;
}

/**
 * POST /campaigns/briefs/:id/duplicate — copy a yaml/yml/json brief to `briefs/<newId>.yaml`.
 *
 * Body `{ newId, overrides? }` must be path-safe; `overrides` accepts
 * `targetRegion` and `targetAudience` only (D71) and wins over the source.
 * Source is looked up by `brief.id` (filename may differ). 404 if the source
 * is missing, 409 if any file already has `newId`. The copy gets `id: newId`;
 * writes stay under `projectRoot()/briefs/`.
 * Copies any brief-scoped assets (`assets/inputs/<id>/*`) into `assets/inputs/<newId>/*`
 * and rewrites logoPath and inputAsset, while leaving shared root assets untouched (L5.5).
 * The copy pool is copied too (D71/C9), rewritten to name the new brief — a
 * duplicated `pool://copy` source otherwise plans against a file that never existed.
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
  let overrides: unknown;
  try {
    const body: unknown = await readBody(event);
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
    const value = record?.newId;
    assertSafeId(value, "newId");
    newId = value;
    overrides = record?.overrides;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const source = await getBriefStore().findBriefById(id);
  if (!source) {
    setResponseStatus(event, 404);
    return { error: `Brief "${id}" not found.` };
  }

  if (await isPoolDirSymlink(newId)) {
    setResponseStatus(event, 400);
    return { error: SYMLINK_WRITE_ERROR };
  }

  // D71 — overrides are merged and validated HERE, before the lock, in their own
  // try/catch, so parseBrief's answer is a 400. A failure inside withBriefLock
  // surfaces through the outer catch below as a 500 (only EEXIST is mapped there,
  // and briefs.test.ts pins that 500 for the write-failure path) — validation
  // never moves inside it. `mode` is deliberately NOT an override: a classic
  // source overridden to "variation" needs a `variation.count` that parseBrief
  // requires and that is an editor default ("12"), not this route's to invent;
  // the reverse direction leaves the source's `variation` block in the file,
  // structurally valid but inert. The copy inherits the source's mode.
  let brief: CampaignBrief;
  try {
    brief = parseBrief({ ...source.brief, ...overrideValues(overrides), id: newId });
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
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
      brief = rewriteAssetPaths(brief, id, newId, sourceMap);
      const additionalSourceIds = extractSourceAssetBriefIds(brief, newId);
      for (const fromId of additionalSourceIds) {
        const addMap = await getAssetStore().copyAssets(fromId, newId);
        brief = rewriteAssetPaths(brief, fromId, newId, addMap);
      }

      // The pool copy runs under withPoolLock(newId) as well as the brief lock
      // above: they are different maps (lib/pools vs the brief store), so without
      // it a concurrent POST /campaigns/pools/:newId could interleave with the
      // copy. The source pool needs no lock: writePool renames atomically.


      await withPoolLock(newId, () => copyPool(id, newId));

      return await getBriefStore().createBrief(brief);
    });
    setResponseStatus(event, 201);
    return { file: created.file, brief: created.brief };
  } catch (error) {
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return { error: `Brief "${newId}" already exists.` };
    }
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
});
