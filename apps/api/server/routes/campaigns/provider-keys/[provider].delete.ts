import {
  canManageProviderKeys,
  getProviderKeyStore,
  isProvider,
  ProviderKeyUnavailableError,
} from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * DELETE /campaigns/provider-keys/:provider — revoke the caller's org's
 * active BYOK key for one provider (D175). Only `owner`/`admin` may revoke —
 * 403 for any other member. Revoking an already-revoked or never-registered
 * provider is a no-op, not an error: there is nothing left to lock this
 * caller out of. Answers 503, naming what's missing, when the store cannot
 * serve this at all (the fs backend has no table for it).
 */
export default defineEventHandler(async (event) => {
  const tenant = requestTenant(event);
  const provider = getRouterParam(event, "provider");
  if (!isProvider(provider)) {
    setResponseStatus(event, 400);
    return { error: "Unknown provider" };
  }
  if (!canManageProviderKeys(tenant)) {
    setResponseStatus(event, 403);
    return { error: "Only an owner or admin may manage provider keys." };
  }
  try {
    await getProviderKeyStore(tenant).revoke(provider);
    return { revoked: true };
  } catch (error) {
    if (!(error instanceof ProviderKeyUnavailableError)) throw error;
    setResponseStatus(event, 503);
    return { error: error.message };
  }
});
