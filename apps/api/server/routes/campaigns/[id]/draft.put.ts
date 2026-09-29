import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../../lib/load-brief.js";
import { SYMLINK_WRITE_ERROR } from "../../../lib/brief-files.js";
import { getBriefStore, getDraftStore } from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * PUT /campaigns/:id/draft — store or replace the caller's own autosave
 * draft for this campaign (PT-5d, D173, D177). `BriefEditor` calls this
 * debounced, at most once per second, with `{ state, baseRevision }`: `state`
 * is the editor-state blob, opaque to the server — `parseBrief` never runs
 * against it, because a draft is not a brief. `baseRevision` is the
 * campaign's published revision the draft was taken against (from
 * `StoredBrief.revision`), `null` for a versionless campaign (D177: "no
 * published version" is itself the value this carries).
 *
 * A hidden and a missing campaign answer the same 404 (`campaignMeta`, the
 * same gate every other `/campaigns/:id/*` route uses since PT-5c2). A
 * `baseRevision` that no longer matches the campaign's CURRENT revision — a
 * Save landed (this tab or another) since the caller last read it — answers
 * 409 and leaves the stored draft untouched, rather than writing over a
 * fresher one with content computed against a stale baseline.
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

  const scope = requestTenant(event);
  const briefs = getBriefStore(scope);
  const meta = await briefs.campaignMeta(id);
  if (!meta) {
    setResponseStatus(event, 404);
    return { error: `Campaign "${id}" not found.` };
  }

  const body: unknown = await readBody(event);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    setResponseStatus(event, 400);
    return { error: "Draft body must be an object." };
  }
  const { state, baseRevision } = body as { state?: unknown; baseRevision?: unknown };
  if (state === undefined) {
    setResponseStatus(event, 400);
    return { error: '"state" is required.' };
  }
  if (baseRevision !== null && typeof baseRevision !== "string") {
    setResponseStatus(event, 400);
    return { error: '"baseRevision" must be a string or null.' };
  }

  // The campaign's own current revision — `getRevision` keys by slug (as
  // every BriefStorePort method other than campaignMeta/resolveCampaign
  // does), and answers undefined for a versionless campaign, the same shape
  // `baseRevision` takes as `null`.
  const currentRevision = (await briefs.getRevision(meta.slug)) ?? null;
  if (baseRevision !== currentRevision) {
    setResponseStatus(event, 409);
    return { error: "This campaign has a newer saved version.", revision: currentRevision };
  }

  try {
    const stored = await getDraftStore(scope).writeDraft(
      meta.campaignId,
      scope.userId,
      state,
      baseRevision,
    );
    return { draft: stored };
  } catch (error) {
    if (errorMessage(error) === SYMLINK_WRITE_ERROR) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    throw error;
  }
});
