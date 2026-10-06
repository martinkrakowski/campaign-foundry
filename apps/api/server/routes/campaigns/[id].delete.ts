import { errorMessage } from "@campaignfoundry/shared";
import { purgeGraceHours, storeBackend } from "../../lib/config.js";
import { database } from "../../lib/db/database.js";
import {
  UnsafeCampaignPathError,
  deleteCampaignOnFileStore,
} from "../../lib/deletion/purge-campaign-fs.js";
import { requestCampaignDeletion } from "../../lib/deletion/request.js";
import { assertSafeId } from "../../lib/load-brief.js";
import { canAssignTeam } from "../../lib/ownership.js";
import { getBriefStore } from "../../lib/ports/index.js";
import { requestTenant } from "../../lib/tenant.js";

/**
 * DELETE /campaigns/:id — tombstone a campaign and queue its purge (D231,
 * D234, D235). `:id` is a uuid or a slug; a hidden, tombstoned, other-org or
 * absent campaign is one 404 (D166, D233). 202 `{ deletionId }`: the campaign
 * is hidden at once and `yarn purge:sweep` frees its bytes and rows. 403: the
 * caller can see the campaign but may not delete it (a member, org-wide
 * campaign). 409 `{ error, jobId }`: a run is active (Q3: refuse, never
 * cancel). On the file store the delete is synchronous (PT-9n, Q9): 200 `{
 * deleted: true }`, the same 403/404/409 bodies, and 400 for a symlinked
 * storage path.
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

  const tenant = requestTenant(event);
  const notFound = () => {
    setResponseStatus(event, 404);
    return { error: `Campaign "${id}" not found.` };
  };

  if (storeBackend() !== "postgres") {
    // File store (PT-9n, Q9): synchronous, under the campaign's own locks. The file store
    // has no team column, so every campaign is org-wide: an owner or admin may delete it,
    // a member is refused (403), exactly as for an org-wide campaign on Postgres.
    if ((await getBriefStore(tenant).campaignMeta(id)) === undefined) return notFound();
    if (!canAssignTeam(tenant, null)) {
      setResponseStatus(event, 403);
      return { error: `You may not delete campaign "${id}".` };
    }
    try {
      const outcome = await deleteCampaignOnFileStore(tenant, id);
      switch (outcome.outcome) {
        case "deleted":
          return { deleted: true };
        case "active-job":
          setResponseStatus(event, 409);
          return { error: `Campaign "${id}" has a run in progress.`, jobId: outcome.jobId };
        case "not-found":
          return notFound();
      }
    } catch (error) {
      if (error instanceof UnsafeCampaignPathError) {
        setResponseStatus(event, 400);
        return { error: error.message };
      }
      throw error;
    }
  }

  const resolved = await getBriefStore(tenant).resolveCampaign(id);
  if (!resolved) return notFound();

  const result = await requestCampaignDeletion(database(), {
    orgId: tenant.orgId,
    campaignId: resolved.campaignId,
    requestedBy: tenant.userId,
    mayDelete: (teamId) => canAssignTeam(tenant, teamId),
    graceHours: purgeGraceHours(),
  });
  switch (result.outcome) {
    case "requested":
      setResponseStatus(event, 202);
      return { deletionId: result.deletionId };
    case "forbidden":
      setResponseStatus(event, 403);
      return { error: `You may not delete campaign "${id}".` };
    case "active-job":
      setResponseStatus(event, 409);
      return { error: `Campaign "${id}" has a run in progress.`, jobId: result.jobId };
    case "gone":
      return notFound();
  }
});
