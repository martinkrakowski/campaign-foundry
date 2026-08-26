import { basename } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import { findBriefFileById, hashFile, rewriteBriefFile, SYMLINK_WRITE_ERROR } from "../../../lib/brief-files.js";
import { assertSafeId, parseBrief } from "../../../lib/load-brief.js";

/**
 * PUT /campaigns/briefs/:id — replace the briefs/ file whose `brief.id` equals the
 * path id (yaml, yml, or json). Path id must equal `brief.id`. 404 if no file has
 * that id. The file is rewritten in its own format; YAML comments are lost.
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

  let brief;
  try {
    brief = parseBrief(await readBody(event));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  if (id !== brief.id) {
    setResponseStatus(event, 400);
    return { error: `Path id "${id}" does not match brief.id "${brief.id}".` };
  }

  const filePath = await findBriefFileById(id);
  if (!filePath) {
    setResponseStatus(event, 404);
    return { error: `Brief "${id}" not found.` };
  }

  const rawRevision = getQuery(event).revision;
  const expectedRevision = Array.isArray(rawRevision) ? rawRevision[0] : rawRevision;
  if (expectedRevision) {
    const currentRevision = await hashFile(filePath);
    if (currentRevision !== expectedRevision) {
      setResponseStatus(event, 409);
      return { error: "Brief was modified by another user.", revision: currentRevision };
    }
  }

  try {
    await rewriteBriefFile(filePath, brief);
  } catch (error) {
    if (errorMessage(error) === SYMLINK_WRITE_ERROR) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    throw error;
  }

  return { file: basename(filePath), brief };
});
