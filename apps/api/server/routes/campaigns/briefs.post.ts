import { errorMessage } from "@campaignfoundry/shared";
import {
  extractSourceAssetBriefIds,
  rewriteAssetPaths,
} from "../../lib/asset-files.js";
import {
  isExistsError,
  isErrno,
  SYMLINK_WRITE_ERROR,
} from "../../lib/brief-files.js";
import { parseBrief } from "../../lib/load-brief.js";
import { getAssetStore, getBriefStore } from "../../lib/ports/index.js";

/**
 * POST /campaigns/briefs — persist a campaign brief.
 *
 * Body is a brief (same validator as generate). Lookup is by `brief.id`, not
 * filename: 409 if any briefs/ file already has that id, unless `?replace=1`
 * (repeated `replace` still counts; the first value wins). Replace rewrites that
 * same file in its own format. Creates use exclusive `wx` writes under
 * `projectRoot()/briefs/`.
 *
 * Save as… copies any brief-scoped assets from source brief IDs (`assets/inputs/<from>/*`)
 * into `assets/inputs/<brief.id>/*` and rewrites both logoPath and inputAsset paths,
 * while leaving root-level shared assets (`assets/inputs/*.png`) untouched (L5.5).
 */
export default defineEventHandler(async (event) => {
  let brief;
  try {
    brief = parseBrief(await readBody(event));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const rawReplace = getQuery(event).replace;
  const replace = (Array.isArray(rawReplace) ? rawReplace[0] : rawReplace) === "1";
  const rawRevision = getQuery(event).revision;
  const expectedRevision = Array.isArray(rawRevision) ? rawRevision[0] : rawRevision;
  const existing = await getBriefStore().findBriefFileById(brief.id);
  if (existing && !replace) {
    setResponseStatus(event, 409);
    return { error: `Brief "${brief.id}" already exists.` };
  }

  // Copy any brief-scoped assets and rewrite paths before writing the new brief (Save as…)
  const sourceBriefIds = extractSourceAssetBriefIds(brief, brief.id);
  for (const fromId of sourceBriefIds) {
    await getAssetStore().copyAssets(fromId, brief.id);
    brief = rewriteAssetPaths(brief, fromId, brief.id);
  }

  try {
    const stored = await getBriefStore().withBriefLock(brief.id, async () => {
      if (replace) {
        return await getBriefStore().replaceBrief(brief, { expectedRevision });
      }
      return await getBriefStore().createBrief(brief);
    });
    setResponseStatus(event, 201);
    return { file: stored.file, brief: stored.brief };
  } catch (error) {
    if (errorMessage(error) === SYMLINK_WRITE_ERROR) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return { error: `Brief "${brief.id}" already exists.` };
    }
    if (isErrno(error, "ECONFLICT")) {
      setResponseStatus(event, 409);
      return {
        error: "Brief was modified by another user.",
        revision: (error as { revision?: string }).revision,
      };
    }
    throw error;
  }
});
