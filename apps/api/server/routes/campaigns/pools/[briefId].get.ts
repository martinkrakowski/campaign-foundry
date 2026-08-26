import { errorMessage } from "@campaignfoundry/shared";
import { assertSafeId } from "../../../lib/load-brief.js";
import { readPool } from "../../../lib/pools.js";

/**
 * GET /campaigns/pools/:briefId — return the persisted copy pool, or 404.
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

  const pool = await readPool(briefId);
  if (!pool) {
    setResponseStatus(event, 404);
    return { error: `Copy pool for brief "${briefId}" not found.` };
  }
  return { pool };
});
