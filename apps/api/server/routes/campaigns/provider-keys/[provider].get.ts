import {
  getProviderKeyStore,
  isProvider,
  ProviderKeyUnavailableError,
} from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * GET /campaigns/provider-keys/:provider — one provider's registration
 * (D175, D176): provider, `last4` and `createdAt` only, never the key. 404
 * when the caller's org has no active key for it — including a provider
 * registered by another org, which this scoped store never sees, so it
 * answers exactly as "never registered" would (D166's "unowned reads as
 * absent" rule). 503, naming what's missing, when the store cannot serve
 * this at all (the fs backend has no table for it).
 */
export default defineEventHandler(async (event) => {
  const tenant = requestTenant(event);
  const provider = getRouterParam(event, "provider");
  if (!isProvider(provider)) {
    setResponseStatus(event, 400);
    return { error: "Unknown provider" };
  }
  try {
    const summary = (await getProviderKeyStore(tenant).list()).find((s) => s.provider === provider);
    if (!summary) {
      setResponseStatus(event, 404);
      return { error: `No active key for provider "${provider}".` };
    }
    return summary;
  } catch (error) {
    if (!(error instanceof ProviderKeyUnavailableError)) throw error;
    setResponseStatus(event, 503);
    return { error: error.message };
  }
});
