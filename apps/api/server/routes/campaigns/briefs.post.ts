import { briefFileName, briefYamlPath, pathExists, writeBriefFile } from "../../lib/brief-files.js";
import { parseBrief } from "../../lib/load-brief.js";

/**
 * POST /campaigns/briefs — persist a campaign brief as `briefs/<id>.yaml`.
 *
 * Body is a brief (same validator as generate). 409 if that yaml already exists
 * unless `?replace=1`. Path-safe ids only (`SAFE_ID_PATTERN` via parseBrief); writes
 * never leave `projectRoot()/briefs/`.
 */
export default defineEventHandler(async (event) => {
  let brief;
  try {
    brief = parseBrief(await readBody(event));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid campaign brief" };
  }

  const filePath = briefYamlPath(brief.id);
  if ((await pathExists(filePath)) && getQuery(event).replace !== "1") {
    setResponseStatus(event, 409);
    return { error: `Brief "${brief.id}.yaml" already exists.` };
  }

  await writeBriefFile(filePath, brief);
  setResponseStatus(event, 201);
  return { file: briefFileName(filePath), brief };
});
