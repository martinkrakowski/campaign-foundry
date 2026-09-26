import type { TenantContext } from "../tenant.js";

/**
 * Org provider keys, sealed (PT-7b2, D175, D176): BYOK credentials for the
 * providers `pipeline.ts` calls, stored envelope-encrypted (PT-7b1's
 * `HostSecretKeySealer`) and write-only from the browser. `open` hands back
 * the plaintext for the run wiring only (PT-7b3); no route ever calls it.
 */
export const PROVIDERS = ["gemini", "openrouter", "firefly"] as const;

export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** What a `GET` may see: never the key, never the sealed envelope either. */
export interface ProviderKeySummary {
  readonly provider: Provider;
  readonly last4: string;
  readonly createdAt: string;
}

export interface ProviderKeyPort {
  /**
   * Register or replace an org's key for `provider`. Seals `plaintext` with
   * context `<orgId>:<provider>` and revokes the previously active key (if
   * any) in the same transaction as the insert, so a read never sees two
   * active keys for one provider. `actor` is the caller's user id, recorded
   * as `created_by`.
   */
  put(provider: Provider, plaintext: string, actor: string): Promise<ProviderKeySummary>;
  /** The org's active keys, provider and `last4` only — never the key. */
  list(): Promise<ProviderKeySummary[]>;
  /** Revoke the org's active key for `provider`. A no-op when none is active. */
  revoke(provider: Provider): Promise<void>;
  /**
   * The org's active plaintext key for `provider`, or `undefined` when none
   * is active. For the run wiring (PT-7b3) only; never exposed by a route.
   */
  open(provider: Provider): Promise<string | undefined>;
}

/**
 * Thrown when provider keys cannot be served at all right now — no key
 * encryption key configured, or the fs backend, which has no table for them.
 * Carries `statusCode`/`status` (h3 reads either) so a route that lets it
 * propagate answers 503, and its message never contains key material.
 */
export class ProviderKeyUnavailableError extends Error {
  readonly statusCode = 503;
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "ProviderKeyUnavailableError";
  }
}

/**
 * Thrown by `put` when the partial unique index on `(org_id, provider) where
 * revoked_at is null` catches two concurrent registrations for the same
 * provider (pg `23505`): the loser's revoke-then-insert raced a winner's, not
 * because either key is unusable. Carries `statusCode`/`status` 409 so a
 * route that lets it propagate answers 409, and the caller should just retry.
 */
export class ProviderKeyConflictError extends Error {
  readonly statusCode = 409;
  readonly status = 409;

  constructor(message = "replaced concurrently; retry") {
    super(message);
    this.name = "ProviderKeyConflictError";
  }
}

/** The org's `owner` and `admin` roles manage keys (register, replace, revoke); members' runs use them (PT-7b2). */
export function canManageProviderKeys(tenant: TenantContext): boolean {
  return tenant.roles.includes("owner") || tenant.roles.includes("admin");
}

/** Firefly's client id and secret, sealed together as one plaintext (item 3). */
export function encodeFireflyPlaintext(clientId: string, clientSecret: string): string {
  return JSON.stringify({ clientId, clientSecret });
}

/**
 * The last 4 characters of a plaintext key, so an owner can tell keys apart
 * without reading one back. Firefly's plaintext is `{clientId,clientSecret}`
 * as JSON (`encodeFireflyPlaintext`); every plaintext ends in `"}`, which
 * would make every Firefly `last4` identical and leak the encoding, so
 * Firefly's `last4` is its `clientSecret`'s instead.
 */
export function last4Of(provider: Provider, plaintext: string): string {
  if (provider === "firefly") {
    const decoded = JSON.parse(plaintext) as { clientSecret: string };
    return decoded.clientSecret.slice(-4);
  }
  return plaintext.slice(-4);
}
