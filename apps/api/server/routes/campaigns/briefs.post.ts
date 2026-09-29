import { isReservedCampaignId, type CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { extractSourceAssetBriefIds, rewriteAssetPaths } from "../../lib/asset-files.js";
import { isExistsError, isErrno, SYMLINK_WRITE_ERROR } from "../../lib/brief-files.js";
import { parseBrief } from "../../lib/load-brief.js";
import { getAssetStore, getBriefStore, TeamsNotSupportedError } from "../../lib/ports/index.js";
import { assertSourceVisible, CampaignNotFoundError, canAssignTeam } from "../../lib/ownership.js";

import { requestTenant } from "../../lib/tenant.js";

/**
 * POST /campaigns/briefs — persist a campaign brief.
 *
 * Body is a brief (same validator as generate). Lookup is by `brief.id`, not
 * filename. The target campaign must already be KNOWN (PT-5c2: `POST /campaigns`
 * is the only path that mints one now) — for a NON-reserved id, a hidden and a
 * missing target answer the identical 404, and nothing is written for either
 * (D181 fix round 3: for a RESERVED id, both instead answer the identical 400
 * "reserved" — see the `hasGenuineReservation`/PT-2d comment below; a 404
 * here would leak that a hidden campaign exists under that slug). A known
 * target already carrying a version 409s unless `?replace=1` (repeated `replace` still counts;
 * the first value wins); a KNOWN but versionless target (a blank `POST /campaigns`
 * create) accepts this write as its first Save either way. Replace rewrites that
 * same file in its own format. Creates use exclusive `wx` writes under
 * `projectRoot()/briefs/`.
 *
 * Save as… copies any brief-scoped assets from source brief IDs (`assets/inputs/<from>/*`)
 * into `assets/inputs/<brief.id>/*` and rewrites both logoPath and inputAsset paths,
 * while leaving root-level shared assets (`assets/inputs/*.png`) untouched (L5.5).
 *
 * `teamId` (D166, PT-2c item 3) is an optional sibling of the brief fields in
 * the same JSON body, never part of `CampaignBrief` itself — it names a
 * Postgres `campaign` column, not a brief property, and stripping it before
 * `parseBrief` keeps it out of the persisted `body`/revision (a PT-8 import
 * already cannot keep brief revisions; adding storage metadata to the hashed
 * bytes would only widen that gap). Absent means "no team" (null, the
 * default). Present, it must be a string the caller may assign — `owner`/
 * `admin`, or a member of that team — or the answer is 403; on the fs
 * backend, which has no team column (item 5), the store itself throws
 * `TeamsNotSupportedError`, mapped below to 400.
 *
 * D166 item 2: a "Save as…" `logoPath`/`inputAsset` may name ANY campaign id
 * as its asset source — `extractSourceAssetBriefIds` reads it straight off
 * the request body, not off anything this caller is known to own. Each
 * source id is checked with `assertSourceVisible` before any `copyAssets`
 * runs, so naming a campaign hidden by team 404s instead of exfiltrating its
 * assets into the new one.
 *
 * D166 item 3 / PT-5c2: the target id's own state is checked with
 * `campaignMeta`, before any copy or write, rather than relying on
 * `createBrief`'s eventual EEXIST — an unknown or existing-but-hidden target
 * must never have its asset directory written into ahead of that refusal.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  const store = getBriefStore(scope);
  let brief: CampaignBrief;
  let teamId: string | undefined;
  let replace: boolean;
  try {
    const rawBody: unknown = await readBody(event);
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      throw new Error("Campaign brief must be an object.");
    }
    const { teamId: rawTeamId, ...briefBody } = rawBody as Record<string, unknown>;
    if (rawTeamId !== undefined && typeof rawTeamId !== "string") {
      throw new Error('"teamId" must be a string.');
    }
    teamId = rawTeamId as string | undefined;
    brief = parseBrief(briefBody);
    const rawReplace = getQuery(event).replace;
    replace = (Array.isArray(rawReplace) ? rawReplace[0] : rawReplace) === "1";
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  // D181 fix round 2 (S2): kept OUT of the body-parse try/catch above, which
  // exists for validation errors only — a `hasGenuineReservation` storage
  // failure must surface as a 500, never folded into this route's 400 with
  // raw error text.
  //
  // D181 fix round 2 (Fable, PT-2d): `hasGenuineReservation` is visible-only
  // (Postgres) and evidence-only (fs, never a bare directory another write
  // path could have created — see its own doc comment) — a hidden campaign
  // under a reserved slug therefore answers the SAME 400 "reserved" message a
  // genuinely missing one does, never the 404 a hidden NON-reserved target
  // gets. Distinguishing them would let a caller learn that another team
  // holds a campaign under that slug, exactly the oracle PT-2d exists to
  // close.
  const reserved = isReservedCampaignId(brief.id);
  if (!replace && reserved && !(await store.hasGenuineReservation(brief.id))) {
    setResponseStatus(event, 400);
    return { error: `"${brief.id}" is reserved; choose another campaign id.` };
  }

  // Checked before canAssignTeam, and — the point of this order (D166, PT-2c,
  // coderabbit thread U_YF) — before ANY of the Save-as asset copying below:
  // on the fs backend (item 5), copying first and only then hitting
  // createBrief/replaceBrief's own TeamsNotSupportedError left orphaned files
  // in a campaign that was never created.
  if (teamId !== undefined && !store.supportsTeams) {
    setResponseStatus(event, 400);
    return { error: new TeamsNotSupportedError().message };
  }
  if (teamId !== undefined && !canAssignTeam(scope, teamId)) {
    setResponseStatus(event, 403);
    return { error: `Not authorized to assign team "${teamId}".` };
  }

  const rawRevision = getQuery(event).revision;
  const expectedRevision = Array.isArray(rawRevision) ? rawRevision[0] : rawRevision;
  try {
    const stored = await store.withBriefLock(brief.id, async () => {
      // PT-5c2: `POST /campaigns/briefs` no longer creates a campaign that
      // does not exist — Create is `POST /campaigns` now, so the target must
      // be KNOWN (`campaignMeta` defined, on both backends) before any asset
      // copy or write below runs, never after, which would let a copy land
      // ahead of the eventual refusal. `campaignMeta` answers undefined for
      // absent AND hidden alike (PT-2d), so both answer the SAME 404 here —
      // the old hidden-target 409 (D166 item 3, EEXIST) retires with it: a
      // hidden campaign is no longer distinguishable from a missing one at
      // this route.
      //
      // D177 (PT-5b2): a `POST /campaigns` blank create leaves a campaign row
      // with no version yet — `campaignMeta` still answers it (unlike
      // `campaignVisibility`/`resolveCampaign`, which miss a versionless row
      // on fs), so `hasVersion` is what tells "this Save is that row's
      // first" (not a collision, `store.createBrief` below adds version 1 to
      // it) apart from "already taken" (refused unless `?replace=1`).
      const meta = await store.campaignMeta(brief.id);
      if (!meta) {
        throw new CampaignNotFoundError(brief.id);
      }
      if (meta.hasVersion && !replace) {
        const existErr = new Error(`Brief "${brief.id}" already exists.`);
        (existErr as { code?: string }).code = "EEXIST";
        throw existErr;
      }

      // Copy any brief-scoped assets and rewrite paths only after validation succeeds (Save as…)
      const sourceBriefIds = extractSourceAssetBriefIds(brief, brief.id);
      if (sourceBriefIds.length > 0) {
        // D166 item 2: each source id must not be hidden from THIS caller by
        // team before its assets are copied — a request can name any campaign
        // id in a logoPath/inputAsset, including another team's real
        // campaign. Checked before the copy loop, and before the revision
        // guard below, so a hidden source 404s without copying anything.
        for (const fromId of sourceBriefIds) {
          await assertSourceVisible(scope, fromId);
        }
        if (replace && expectedRevision !== undefined) {
          const currentRev = await store.getRevision(brief.id);
          if (currentRev !== expectedRevision) {
            const conflictErr = new Error("Brief was modified by another user.");
            (conflictErr as { code?: string; revision?: string }).code = "ECONFLICT";
            (conflictErr as { revision?: string }).revision = currentRev;
            throw conflictErr;
          }
        }
        for (const fromId of sourceBriefIds) {
          const pathMap = await getAssetStore(scope).copyAssets(fromId, brief.id);
          brief = rewriteAssetPaths(brief, fromId, brief.id, pathMap);
        }
      }

      if (replace) {
        // teamId undefined here means "leave the campaign's team as it is" —
        // never `?? null`, which would reset an already-assigned team to
        // org-wide on every plain re-save. The fs backend throws
        // TeamsNotSupportedError if teamId is anything but undefined.
        return await store.replaceBrief(brief, { expectedRevision, teamId });
      }
      return await store.createBrief(brief, { teamId });
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
    if (error instanceof CampaignNotFoundError) {
      setResponseStatus(event, 404);
      return { error: error.message };
    }
    if (error instanceof TeamsNotSupportedError) {
      setResponseStatus(event, 400);
      return { error: error.message };
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
    if (isErrno(error, "EFORBIDDEN")) {
      setResponseStatus(event, 403);
      return { error: errorMessage(error) };
    }
    // D181 fix round 3 (Fable, client-reachable 500): a reserved id can
    // reach this catch via `replaceBrief`'s ENOENT-falls-to-`createBrief`
    // path when `?replace=1` skipped the early gate above entirely (the
    // gate only ever runs `!replace`) — same status and body either way,
    // never a 500 for the same client state a plain POST answers 400.
    if (isErrno(error, "ERESERVED")) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    throw error;
  }
});
