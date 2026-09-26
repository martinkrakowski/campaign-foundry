import {
  canManageProviderKeys,
  encodeFireflyPlaintext,
  getProviderKeyStore,
  isProvider,
  ProviderKeyConflictError,
  ProviderKeyUnavailableError,
  type Provider,
} from "../../../lib/ports/index.js";
import { requestTenant } from "../../../lib/tenant.js";

/**
 * A plaintext secret's trimmed length must be at least this long: below it,
 * `last4Of`'s `.slice(-4)` returns the *whole* value (a 1-4 character key's
 * "last4" is the entire key), which a `GET` then hands back to any member.
 * Whitespace-only input trims to an empty string and fails this the same way.
 */
const MIN_SECRET_LENGTH = 8;
/** A sane upper bound so an oversized body can't be stored as a "key" at all. */
const MAX_SECRET_LENGTH = 4096;

function isValidSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SECRET_LENGTH &&
    value.trim().length >= MIN_SECRET_LENGTH
  );
}

/** Gemini and OpenRouter take `{ key }`; Firefly takes `{ clientId, clientSecret }`. */
function plaintextFromBody(provider: Provider, body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (provider === "firefly") {
    const { clientId, clientSecret } = body as { clientId?: unknown; clientSecret?: unknown };
    if (!isValidSecret(clientId) || !isValidSecret(clientSecret)) return undefined;
    // A run needs both to authenticate (PT-7b3): sealed together as one JSON string.
    return encodeFireflyPlaintext(clientId, clientSecret);
  }
  const { key } = body as { key?: unknown };
  if (!isValidSecret(key)) return undefined;
  return key;
}

/**
 * PUT /campaigns/provider-keys/:provider — register or replace the caller's
 * org's BYOK key for one provider (D175, D176). Only `owner`/`admin` may
 * write — 403 for any other member. A secret's trimmed length must be
 * `MIN_SECRET_LENGTH`-`MAX_SECRET_LENGTH` characters — 400 otherwise, and
 * nothing is stored — so a too-short key never leaks itself whole through
 * `last4`. Replacing revokes the previous key in the same transaction the new
 * one is written in (`ProviderKeyPort.put`); if a second, concurrent PUT for
 * the same provider races that transaction, the loser gets 409, not 500 (the
 * caller should retry). Answers 503, naming the missing setting, when no key
 * encryption key is configured, or it is malformed (or the store cannot
 * serve this at all, on the fs backend). The plaintext is never echoed back,
 * logged, or stored — only its sealed envelope and its last 4 characters are.
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
        provider === "firefly"
          ? `Firefly needs { clientId, clientSecret }, each ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters.`
          : `Provide { key }, ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters.`,
    };
  }
  try {
    return await getProviderKeyStore(tenant).put(provider, plaintext, tenant.userId);
  } catch (error) {
    if (error instanceof ProviderKeyConflictError) {
      setResponseStatus(event, 409);
      return { error: error.message };
    }
    if (!(error instanceof ProviderKeyUnavailableError)) throw error;
    setResponseStatus(event, 503);
    return { error: error.message };
  }
});
