import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import {
  BRIEF_SOURCE_EXTS,
  briefFileName,
  briefYamlPath,
  findBriefFile,
  pathExists,
  writeBriefFile,
} from "../../../../lib/brief-files.js";
import { loadBrief } from "../../../../lib/load-brief.js";

/**
 * POST /campaigns/briefs/:id/duplicate — copy a yaml/yml/json brief to `briefs/<newId>.yaml`.
 *
 * Body `{ newId }` must be path-safe. 404 if the source is missing, 409 if the
 * target yaml already exists. The copy gets `id: newId`; writes stay under
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

  let newId: string;
  try {
    const body: unknown = await readBody(event);
    const value =
      typeof body === "object" && body !== null ? (body as { newId?: unknown }).newId : undefined;
    if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
      throw new Error(
        `newId must be a path-safe slug (lowercase letters, digits, hyphens; max 64 chars); got ${JSON.stringify(value)}.`,
      );
    }
    newId = value;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: error instanceof Error ? error.message : "Invalid duplicate request" };
  }

  const sourcePath = await findBriefFile(id, BRIEF_SOURCE_EXTS);
  if (!sourcePath) {
    setResponseStatus(event, 404);
    return { error: `Brief "${id}" not found.` };
  }

  const destPath = briefYamlPath(newId);
  if (await pathExists(destPath)) {
    setResponseStatus(event, 409);
    return { error: `Brief "${newId}.yaml" already exists.` };
  }

  let brief;
  try {
    brief = { ...(await loadBrief(sourcePath)), id: newId };
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  await writeBriefFile(destPath, brief);
  setResponseStatus(event, 201);
  return { file: briefFileName(destPath), brief };
});
