import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
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
  let brief: CampaignBrief;
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
  try {
    const stored = await getBriefStore().withBriefLock(brief.id, async () => {
      const existing = await getBriefStore().findBriefFileById(brief.id);
      if (existing && !replace) {
        const existErr = new Error(`Brief "${brief.id}" already exists.`);
        (existErr as { code?: string }).code = "EEXIST";
        throw existErr;
      }

      // Copy any brief-scoped assets and rewrite paths only after validation succeeds (Save as…)
      const sourceBriefIds = extractSourceAssetBriefIds(brief, brief.id);
      if (sourceBriefIds.length > 0) {
        if (replace && expectedRevision !== undefined) {
          const currentRev = await getBriefStore().getRevision(brief.id);
          if (currentRev !== expectedRevision) {
            const conflictErr = new Error("Brief was modified by another user.");
            (conflictErr as { code?: string; revision?: string }).code = "ECONFLICT";
            (conflictErr as { revision?: string }).revision = currentRev;
            throw conflictErr;
          }
        }
        for (const fromId of sourceBriefIds) {
          const pathMap = await getAssetStore().copyAssets(fromId, brief.id);
          brief = rewriteAssetPaths(brief, fromId, brief.id, pathMap);
        }
      }

      if (replace) {
        return await getBriefStore().replaceBrief(brief, { expectedRevision });
      }
      return await getBriefStore().createBrief(brief);
    });
    setResponseStatus(event, 201);
    // The stored revision rides along: the editor dispatches it into its source so the
    // next save of this brief guards conditionally instead of sending a stale
    // load-time revision and getting an untrue 409.
    return { file: stored.file, brief: stored.brief, revision: stored.revision };
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
