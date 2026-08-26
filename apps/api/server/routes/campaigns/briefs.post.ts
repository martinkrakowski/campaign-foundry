import { basename } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import {
  briefYamlPath,
  createBriefFile,
  findBriefFileById,
  isExistsError,
  replaceBriefFile,
  SYMLINK_WRITE_ERROR,
} from "../../lib/brief-files.js";
import { parseBrief } from "../../lib/load-brief.js";

/**
 * POST /campaigns/briefs — persist a campaign brief.
 *
 * Body is a brief (same validator as generate). Lookup is by `brief.id`, not
 * filename: 409 if any briefs/ file already has that id, unless `?replace=1`
 * (repeated `replace` still counts; the first value wins). Replace rewrites that
 * same file in its own format. Creates use exclusive `wx` writes under
 * `projectRoot()/briefs/`.
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
  const existing = await findBriefFileById(brief.id);
  if (existing && !replace) {
    setResponseStatus(event, 409);
    return { error: `Brief "${brief.id}" already exists.` };
  }

  const filePath = existing ?? briefYamlPath(brief.id);
  try {
    if (replace) await replaceBriefFile(filePath, brief);
    else await createBriefFile(filePath, brief);
  } catch (error) {
    if (errorMessage(error) === SYMLINK_WRITE_ERROR) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return { error: `Brief "${brief.id}" already exists.` };
    }
    throw error;
  }

  setResponseStatus(event, 201);
  return { file: basename(filePath), brief };
});
