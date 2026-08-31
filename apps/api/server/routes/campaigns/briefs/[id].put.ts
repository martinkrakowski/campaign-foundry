import { errorMessage } from "@campaignfoundry/shared";
import { isErrno, SYMLINK_WRITE_ERROR } from "../../../lib/brief-files.js";
import { assertSafeId, parseBrief } from "../../../lib/load-brief.js";
import { getBriefStore } from "../../../lib/ports/index.js";

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

  const rawRevision = getQuery(event).revision;
  const expectedRevision = Array.isArray(rawRevision) ? rawRevision[0] : rawRevision;

  try {
    const stored = await getBriefStore().withBriefLock(id, async () => {
      return await getBriefStore().rewriteBrief(brief, { expectedRevision });
    });
    // The new revision rides along: the editor dispatches it into its source, so the
    // next save guards conditionally instead of replaying the load-time revision and
    // getting an untrue "Brief was modified by another user."
    return { file: stored.file, brief: stored.brief, revision: stored.revision };
  } catch (error) {
    if (errorMessage(error) === SYMLINK_WRITE_ERROR) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    if (isErrno(error, "ENOENT")) {
      setResponseStatus(event, 404);
      return { error: `Brief "${id}" not found.` };
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
