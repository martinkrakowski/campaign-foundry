import { getBriefStore, getLastOpenedStore } from "../../lib/ports/index.js";
import { requestTenant } from "../../lib/tenant.js";

/**
 * GET /campaigns/last-opened — the campaign this user last opened (PT-5e,
 * D173, D180), or `null` when there is none to hand back.
 *
 * This is a POINTER, never an address (D37, unchanged by the move off
 * `localStorage`): the URL still names which campaign a page shows, and this
 * only decides where a BARE url goes. The user is
 * `requestTenant(event).userId`, the session's own identity, never a query
 * parameter — which is what makes the answer the same on another device.
 *
 * Item 4: a campaign that has been DELETED and one that is merely hidden by
 * team answer the SAME body, byte for byte, and neither is an error. The
 * deletion case needs no work of its own (the pointer's FK cascades with the
 * campaign, `0015_last_opened.sql`), so both cases arrive here as one: a
 * pointer this caller can no longer resolve through `campaignMeta`, which
 * answers `undefined` for hidden and missing alike (PT-2d). Answering them
 * differently — a 404 for the hidden one, say — would disclose that a campaign
 * by that name exists, which is exactly what D166 forbids.
 *
 * This route is a STATIC segment beside `[id].get.ts`, and Nitro prefers it.
 * That is why `last-opened` is in `RESERVED_CAMPAIGN_IDS` (item 0): a campaign
 * slugged `last-opened` would otherwise have its own `GET /campaigns/:id`
 * shadowed, and on the file backend that slug is the only id it has (D179).
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  const pointer = await getLastOpenedStore(scope).read(scope.userId);
  if (!pointer) return { campaignId: null };

  // A pointer this caller can no longer see is reported as no pointer at all,
  // identically to a caller who never opened anything — same status, same
  // body.
  const meta = await getBriefStore(scope).campaignMeta(pointer.campaignId);
  if (!meta) return { campaignId: null };
  return { campaignId: meta.campaignId };
});
