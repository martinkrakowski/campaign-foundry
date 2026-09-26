import {
  canManageProviderKeys,
  encodeFireflyPlaintext,
  getProviderKeyStore,
  isProvider,
  ProviderKeyUnavailableError,
  type Provider,
} from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/** Gemini and OpenRouter take `{ key }`; Firefly takes `{ clientId, clientSecret }`. */
function plaintextFromBody(provider: Provider, body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (provider === "firefly") {
    const { clientId, clientSecret } = body as { clientId?: unknown; clientSecret?: unknown };
    if (typeof clientId !== "string" || clientId.length === 0) return undefined;
    if (typeof clientSecret !== "string" || clientSecret.length === 0) return undefined;
    // A run needs both to authenticate (PT-7b3): sealed together as one JSON string.
    return encodeFireflyPlaintext(clientId, clientSecret);
  }
  const { key } = body as { key?: unknown };
  if (typeof key !== "string" || key.length === 0) return undefined;
  return key;
}

/**
 * PUT /campaigns/provider-keys/:provider — register or replace the caller's
 * org's BYOK key for one provider (D175, D176). Only `owner`/`admin` may
 * write — 403 for any other member. Replacing revokes the previous key in
 * the same transaction the new one is written in (`ProviderKeyPort.put`).
 * Answers 503, naming the missing setting, when no key encryption key is
 * configured (or the store cannot serve this at all, on the fs backend). The
 * plaintext is never echoed back, logged, or stored — only its sealed
 * envelope and its last 4 characters are.
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
  const body: unknown = await readBody(event);
  const plaintext = plaintextFromBody(provider, body);
  if (plaintext === undefined) {
    setResponseStatus(event, 400);
    return {
      error:
        provider === "firefly" ? "Firefly needs { clientId, clientSecret }." : "Provide { key }.",
    };
  }
  try {
    return await getProviderKeyStore(tenant).put(provider, plaintext, tenant.userId);
  } catch (error) {
    if (!(error instanceof ProviderKeyUnavailableError)) throw error;
    setResponseStatus(event, 503);
    return { error: error.message };
  }
});
