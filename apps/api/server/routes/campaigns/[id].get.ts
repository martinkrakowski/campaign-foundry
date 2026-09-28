import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../lib/load-brief.js";
import { getBriefStore } from "../../lib/ports/index.js";
import { requestTenant } from "../../lib/tenant.js";

/**
 * GET /campaigns/:id — a campaign's display name, type and whether it has
 * any saved version (PT-5b3, D168, D177). `:id` is a uuid or a slug (D178,
 * D179): `BriefStorePort.campaignMeta` resolves either shape itself
 * (mirroring `resolveCampaign`, PT-5a) and answers `undefined` for a ref
 * that is absent or hidden by team (D166) — indistinguishable on purpose
 * (PT-2d), both 404 here.
 *
 * A campaign minted before this migration, or an fs reservation with no
 * recorded meta, answers `name: null, type: null` and is still 200: Saving a
 * version never clears these columns (item 4), and a pre-lane campaign never
 * had them to begin with.
 *
 * `id` must be path-safe (`assertSafeId`, the same guard
 * `pools/[briefId].get.ts` applies) before it ever reaches the store — a
 * lowercase uuid passes this pattern too, so a genuine uuid ref is
 * unaffected.
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
  const meta = await getBriefStore(scope).campaignMeta(id);
  if (!meta) {
    setResponseStatus(event, 404);
    return { error: `Campaign "${id}" not found.` };
  }
  return meta;
});
