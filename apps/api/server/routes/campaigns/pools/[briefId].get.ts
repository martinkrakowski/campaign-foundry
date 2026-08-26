import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../../lib/load-brief.js";
import { InvalidCopyPoolError, readPool } from "../../../lib/pools.js";

/**
 * GET /campaigns/pools/:briefId — return the persisted copy pool, or 404. A
 * hand-edited file that is not a pool is a 422 naming the file and the problem.
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

  let pool;
  try {
    pool = await readPool(briefId);
  } catch (error) {
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
  if (!pool) {
    setResponseStatus(event, 404);
    return { error: `Copy pool for brief "${briefId}" not found.` };
  }
  return { pool };
});
