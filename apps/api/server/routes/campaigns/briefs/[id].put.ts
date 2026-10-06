import { errorMessage } from "@campaignfoundry/shared";
import {
  assertRefsCopied,
  BriefRefNotFoundError,
  copyBriefRefs,
  resolveBriefAssetRefs,
} from "../../../lib/brief-asset-refs.js";
import { isErrno, SYMLINK_WRITE_ERROR } from "../../../lib/brief-files.js";
import { objectStore } from "../../../lib/config.js";
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
 *
 * **Under `s3` this route resolves and copies the brief's refs too** (PT-4k2b,
 * D210 b) — it is the web's main save path, so a ref left here is a ref the editor
 * keeps sending. Every ref becomes the id of a row this caller can see, a foreign
 * campaign's asset is COPIED into the target and remapped id→id rather than left
 * shared, and a hidden campaign, another org's, an absent row or a ref naming no
 * campaign is refused with the same `Brief "<id>" not found.` this route already
 * answers for an unknown brief. Off `s3` the route is untouched: it makes no
 * visibility check PUT has never made, and `briefToSave` is written exactly as it
 * arrived.
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
  // anyway. Since PT-4k2b the ordering has a second reason — under s3 a foreign
  // ref in the body is COPIED before the write, so this check has to stay ahead of
  // the copy for the same reason it was ahead of the write on fs.
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
      let toSave = briefToSave;
      // Gated on `s3`, not on `supportsTeams` (PT-4k2b, D210 b): off s3 the non-s3
      // `save` branch of the resolve would add a visibility check this route has never
      // made and change nothing else, so PUT must not call the helper at all there.
      if (objectStore() === "s3") {
        const resolved = await resolveBriefAssetRefs(scope, briefToSave, {
          target: slug,
          mode: "save",
        });
        // **`resolved.brief` is what gets written even when nothing is copied** (r2):
        // under s3 a path ref to the TARGET'S OWN asset has just been rewritten to its
        // id, and saving `briefToSave` would store the path — so this is not the same
        // body any more.
        toSave = resolved.brief;
        if (resolved.copyFrom.length > 0) {
          // **Both refusals come BEFORE the copy** (D211 c), and the revision one is the
          // reason the guard exists at all here: `rewriteBrief` ENOENTs a versionless
          // campaign and 409s a stale one itself, so a check after it would be a refusal
          // with the foreign campaign's assets already copied into the target for a write
          // that was never going to land. Same condition `briefs.post.ts` guards with.
          const current = await store.getRevision(slug);
          if (current === undefined) {
            const absentErr = new Error(`Brief "${slug}" not found.`);
            (absentErr as { code?: string }).code = "ENOENT";
            throw absentErr;
          }
          if (expectedRevision !== undefined && current !== expectedRevision) {
            const conflictErr = new Error("Brief was modified by another user.");
            (conflictErr as { code?: string; revision?: string }).code = "ECONFLICT";
            (conflictErr as { revision?: string }).revision = current;
            throw conflictErr;
          }
          ({ brief: toSave } = await copyBriefRefs(scope, resolved.brief, resolved.copyFrom, slug));
          // The row could have gone between the resolve and the copy; see `assertRefsCopied`.
          assertRefsCopied(toSave, resolved.foreignIds, slug);
        }
      }
      return await store.rewriteBrief(toSave, { expectedRevision, teamId });
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
    // A ref the caller may not use, refused by the resolve above (PT-4k2b). Its
    // `statusCode` is 404, but h3 would then answer with ITS OWN body shape rather than
    // this route's `{ error }` — and this route already has a 404 for a brief it cannot
    // write, so the same one is the whole point of D210(c). The body names the ROUTER
    // PARAM, never the ref and never an owner slug read out of it.
    if (error instanceof BriefRefNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${id}" not found.` };
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
