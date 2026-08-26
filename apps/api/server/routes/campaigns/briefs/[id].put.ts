import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { BRIEF_YAML_EXTS, briefFileName, findBriefFile, writeBriefFile } from "../../../lib/brief-files.js";
import { parseBrief } from "../../../lib/load-brief.js";

/**
 * PUT /campaigns/briefs/:id — replace an existing YAML brief (`<id>.yaml` or `<id>.yml`).
 *
 * Path id must equal `brief.id`. 404 unless a yaml/yml file exists (JSON-only briefs
 * are updated via POST ?replace=1, which writes `<id>.yaml`). Writes stay under
 * `projectRoot()/briefs/`.
 */
export default defineEventHandler(async (event) => {
  const id = String(getRouterParam(event, "id"));
  if (!SAFE_ID_PATTERN.test(id)) {
    setResponseStatus(event, 400);
    return {
      error: `Campaign id must be a path-safe slug (lowercase letters, digits, hyphens; max 64 chars); got ${JSON.stringify(id)}.`,
    };
  }

  let brief;
  try {
    brief = parseBrief(await readBody(event));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid campaign brief" };
  }

  if (id !== brief.id) {
    setResponseStatus(event, 400);
    return { error: `Path id "${id}" does not match brief.id "${brief.id}".` };
  }

  const filePath = await findBriefFile(id, BRIEF_YAML_EXTS);
  if (!filePath) {
    setResponseStatus(event, 404);
    return { error: `Brief "${id}" not found.` };
  }

  await writeBriefFile(filePath, brief);
  return { file: briefFileName(filePath), brief };
});
