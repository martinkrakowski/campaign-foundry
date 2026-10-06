import { errorMessage } from "@campaignfoundry/shared";
import { purgeGraceHours, storeBackend } from "../../lib/config.js";
import { database } from "../../lib/db/database.js";
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
 * cancel). 501 on the file store until PT-9n (Q9).
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

  if (storeBackend() !== "postgres") {
    setResponseStatus(event, 501);
    return { error: "Deleting a campaign needs STORE_BACKEND=postgres." };
  }

  const tenant = requestTenant(event);
  const resolved = await getBriefStore(tenant).resolveCampaign(id);
  const notFound = () => {
    setResponseStatus(event, 404);
    return { error: `Campaign "${id}" not found.` };
  };
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
