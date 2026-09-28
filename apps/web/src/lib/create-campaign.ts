"use client";

import type { CampaignType } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { createCampaign as postCampaign } from "./briefs-api";

/**
 * D177, D178 (PT-5c1) — create is a POST, not a seam any more. The dialog
 * hands the two create answers — a campaign name and a campaign type (D108)
 * — plus, from W2, an optional source, to `createCampaign`, which mints the
 * campaign on the server (`POST /campaigns`) and answers its id. The server
 * derives the slug from `name`; the caller never picks one (D178) — the id
 * this function answers is the ONLY id a create may ever carry from here on.
 *
 * `cf:create-seed` and its whole publish/spend cycle (`publishSeed`/
 * `takeSeed`, W1's `subscribeToSeed`) retired with this lane: a blank create
 * used to hand the blank-route editor a seed through `localStorage` because
 * nothing existed server-side to load yet. Now `POST /campaigns` always
 * mints something first — even a blank create has a campaign row (with no
 * version) the instant this call answers — so `/brief/<campaignId>` has a
 * real campaign to fetch and seed itself from (`GET /campaigns/:id`,
 * PT-5b3). A rejected call rejects; there is no longer a "blocked local
 * store" contract to report through a null return.
 */
export interface CreateCampaignInput {
  readonly name: string;
  /** The campaign type (D108) — resolved through `CAMPAIGN_TYPE_PRESETS` on arrival. */
  readonly type: CampaignType;
  /**
   * W2 (D71) — a source campaign's id (uuid or slug): its latest version
   * becomes version 1 of the new campaign. Absent means a blank create.
   */
  readonly source?: string;
}

export interface CreateCampaignResult {
  readonly campaignId: string;
}

export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  const created = await postCampaign({
    name: input.name,
    type: input.type,
    ...(input.source !== undefined ? { source: input.source } : {}),
  });
  return { campaignId: created.campaignId };
}
