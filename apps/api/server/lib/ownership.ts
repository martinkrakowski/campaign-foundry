import type { StorageScope } from "./run-environment.js";
import type { StoredBrief } from "./ports/brief-store.port.js";
import { getBriefStore } from "./ports/index.js";

/**
 * Thrown when an operation is requested on a campaign that does not exist
 * or does not belong to the caller's tenant (D166 / PT-2b).
 * Carries statusCode 404 so Nitro / h3 maps it to HTTP 404 Not Found.
 */
export class CampaignNotFoundError extends Error {
  readonly statusCode = 404;
  readonly status = 404;
  readonly campaignId: string;

  constructor(campaignId: string) {
    super(`Campaign "${campaignId}" not found`);
    this.name = "CampaignNotFoundError";
    this.campaignId = campaignId;
  }
}

/**
 * Assert that the campaign exists and belongs to the given tenant scope.
 * Built on the brief store's existing findBriefById (fs: the brief exists
 * under the tenant root; pg: a campaign row for org_id).
 *
 * Throws a typed CampaignNotFoundError (HTTP 404) if the campaign is not found.
 */
export async function assertOwnedCampaign(
  scope: StorageScope,
  campaignId: string,
): Promise<StoredBrief> {
  const brief = await getBriefStore(scope).findBriefById(campaignId);
  if (!brief) {
    throw new CampaignNotFoundError(campaignId);
  }
  return brief;
}
