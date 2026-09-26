import { getProviderKeyStore, ProviderKeyUnavailableError } from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * GET /campaigns/provider-keys — the caller's org's registered BYOK providers
 * (D175, D176): provider, `last4` and when each was registered, never the
 * key itself. Any member may read (only `owner`/`admin` may `PUT` or
 * `DELETE`, PT-7b2). Answers 503, naming what's missing, when the store
 * cannot serve this at all (the fs backend has no table for it).
 */
export default defineEventHandler(async (event) => {
  const tenant = requestTenant(event);
  try {
    return await getProviderKeyStore(tenant).list();
  } catch (error) {
    if (!(error instanceof ProviderKeyUnavailableError)) throw error;
    setResponseStatus(event, 503);
    return { error: error.message };
  }
});
