import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../lib/load-brief.js";
import { SYMLINK_WRITE_ERROR } from "../../lib/brief-files.js";
import { getBriefStore, getLastOpenedStore } from "../../lib/ports/index.js";
import { requestTenant } from "../../lib/tenant.js";

/**
 * PUT /campaigns/last-opened — record the campaign this user just opened
 * (PT-5e, D173, D180). Body `{ campaignId }`, a uuid or a slug (D178), the
 * same reference every campaign-addressed route takes; `campaignMeta` resolves
 * it and the pointer stores the real id behind it (the uuid on Postgres, the
 * slug on fs, D179), so a caller that only knows a slug still records the
 * campaign rather than a string that names nothing.
 *
 * The user is `requestTenant(event).userId` — the session's identity, never a
 * body field. A pointer is per (org, user), so two people in one org, and one
 * person on two devices, each keep their own.
 *
 * A hidden and a missing campaign answer the same 404 and write NOTHING: the
 * same `campaignMeta` gate every other campaign-addressed route uses since
 * PT-5c2, so a team-scoped campaign this caller cannot see is indistinguishable
 * from one that does not exist (D166, PT-2d). The write is the LAST thing that
 * happens, so a refused reference cannot leave a pointer behind either.
 *
 * This route is a STATIC segment beside `[id].get.ts`, and Nitro prefers it.
 * `last-opened` is in `RESERVED_CAMPAIGN_IDS` (item 0) so no campaign can hold
 * the slug this path owns — on fs that slug is the only id such a campaign
 * would have, and the shadowing would cost it `GET /campaigns/:id` entirely.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);

  let ref: string;
  try {
    const body: unknown = await readBody(event);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Body must be an object.");
    }
    const raw = (body as { campaignId?: unknown }).campaignId;
    if (typeof raw !== "string") {
      throw new Error('"campaignId" is required.');
    }
    // The same path-safety rule every campaign-addressed route applies before
    // a ref reaches a store (and the same guard `[id].get.ts` uses), checked on
    // the body field this route takes instead of a path param.
    assertSafeId(raw, "Campaign id");
    ref = raw;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const meta = await getBriefStore(scope).campaignMeta(ref);
  if (!meta) {
    setResponseStatus(event, 404);
    return { error: `Campaign "${ref}" not found.` };
  }

  try {
    const pointer = await getLastOpenedStore(scope).write(meta.campaignId, scope.userId);
    return { campaignId: pointer.campaignId, updatedAt: pointer.updatedAt };
  } catch (error) {
    // The filesystem adapter refuses a symlinked pointer directory or file
    // (a write through one could land outside the store's own directory). The
    // route maps that to 400, exactly as every other brief write does.
    if (errorMessage(error) === SYMLINK_WRITE_ERROR) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    throw error;
  }
});
