import { errorMessage } from "@campaignfoundry/shared";
import { isErrno, SYMLINK_WRITE_ERROR } from "../../../lib/brief-files.js";
import { assertSafeId, parseBrief } from "../../../lib/load-brief.js";
import { getBriefStore, TeamsNotSupportedError } from "../../../lib/ports/index.js";
import {
  CampaignNotFoundError,
  canAssignTeam,
  resolveCampaignRef,
} from "../../../lib/ownership.js";

import { requestTenant } from "../../../lib/tenant.js";
/**
 * PUT /campaigns/briefs/:id — replace the briefs/ file whose `brief.id` equals the
 * path id (yaml, yml, or json). Path id must equal `brief.id`. 404 if no file has
 * that id. The file is rewritten in its own format; YAML comments are lost.
 *
 * `teamId` (D166, PT-2c item 3): see `briefs.post.ts`'s docstring — same
 * sibling-of-the-brief shape, same permission and backend rules. Absent means
 * "leave the campaign's team exactly as it is" (a plain save must not reset
 * an assigned team to org-wide). `null` (item 5) clears an assigned team back
 * to org-wide, under the same `canAssignTeam` permission.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  let id: string;
  try {
    id = String(getRouterParam(event, "id"));
    assertSafeId(id, "Campaign id");
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  let brief;
  let teamId: string | null | undefined;
  try {
    const rawBody: unknown = await readBody(event);
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      throw new Error("Campaign brief must be an object.");
    }
    const { teamId: rawTeamId, ...briefBody } = rawBody as Record<string, unknown>;
    if (rawTeamId !== undefined && rawTeamId !== null && typeof rawTeamId !== "string") {
      throw new Error('"teamId" must be a string or null.');
    }
    teamId = rawTeamId as string | null | undefined;
    brief = parseBrief(briefBody);
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const store = getBriefStore(scope);
  // Checked before canAssignTeam, matching briefs.post.ts (D166, PT-2c,
  // coderabbit thread U_YF): an fs backend (item 5) answers 400 for any
  // teamId, rather than 403 for one this caller could not have assigned
  // anyway. PUT does no Save-as asset copying, so this is a consistency fix
  // here, not an orphan-file one — the ordering keeps the two routes' rules
  // identical rather than diverging only because PUT has nothing to copy.
  // Kept ahead of the ref resolve below too, matching this route's order
  // before campaign refs existed (D178/D179 must not move a validation a
  // caller already depends on behind an existence check it didn't have).
  if (teamId !== undefined && !store.supportsTeams) {
    setResponseStatus(event, 400);
    return { error: new TeamsNotSupportedError().message };
  }
  if (teamId !== undefined && !canAssignTeam(scope, teamId)) {
    setResponseStatus(event, 403);
    return {
      error:
        teamId === null
          ? "Not authorized to clear this campaign's team."
          : `Not authorized to assign team "${teamId}".`,
    };
  }

  // Resolve a uuid to its slug (D178). On fs the id IS the slug (D179): no
  // store lookup is needed or performed — `supportsTeams` is false there,
  // same guard the existing hidden-campaign checks already use.
  let slug = id;
  if (store.supportsTeams) {
    try {
      slug = await resolveCampaignRef(scope, id);
    } catch (error) {
      if (error instanceof CampaignNotFoundError) {
        setResponseStatus(event, 404);
        return { error: `Brief "${id}" not found.` };
      }
      throw error;
    }
  }

  if (brief.id !== id && brief.id !== slug) {
    setResponseStatus(event, 400);
    return { error: `Path id "${id}" does not match brief.id "${brief.id}".` };
  }
  const briefToSave = brief.id === slug ? brief : { ...brief, id: slug };

  const rawRevision = getQuery(event).revision;
  const expectedRevision = Array.isArray(rawRevision) ? rawRevision[0] : rawRevision;

  try {
    const stored = await store.withBriefLock(slug, async () => {
      return await store.rewriteBrief(briefToSave, { expectedRevision, teamId });
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
    if (error instanceof TeamsNotSupportedError) {
      setResponseStatus(event, 400);
      return { error: error.message };
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
    if (isErrno(error, "EFORBIDDEN")) {
      setResponseStatus(event, 403);
      return { error: errorMessage(error) };
    }
    throw error;
  }
});
