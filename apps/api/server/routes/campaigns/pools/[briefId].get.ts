import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../../lib/load-brief.js";
import { InvalidCopyPoolError, readPool } from "../../../lib/pools.js";

/**
 * GET /campaigns/pools/:briefId — return the persisted copy pool with the
 * revision of the bytes it was read from, or 404. A hand-edited file that is
 * not a pool is a 422 naming the file and the problem. The revision is what
 * PATCH sends back to write conditionally (API E1.0, for pools).
 */
export default defineEventHandler(async (event) => {
  let briefId: string;
  try {
    briefId = String(getRouterParam(event, "briefId"));
    assertSafeId(briefId, "briefId");
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  let stored;
  try {
    stored = await readPool(briefId);
  } catch (error) {
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
  if (!stored) {
    setResponseStatus(event, 404);
    return { error: `Copy pool for brief "${briefId}" not found.` };
  }
  return { pool: stored.pool, revision: stored.revision };
});
