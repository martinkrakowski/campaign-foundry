import { keyEncryptionSettings, type KeyEncryptionSettings } from "../config.js";
import type { SqlClient } from "../db/sql-client.js";
import { HostSecretKeySealer } from "../keys/host-secret-key-sealer.js";
import type { SealedKey } from "../keys/key-sealer.port.js";
import {
  last4Of,
  ProviderKeyConflictError,
  ProviderKeyUnavailableError,
  type Provider,
  type ProviderKeyPort,
  type ProviderKeySummary,
} from "./provider-key.port.js";

/**
 * `keyEncryptionSettings()` throws a plain `Error` for a malformed
 * `KEY_ENCRYPTION_KEYS`/`KEY_ENCRYPTION_KEY_CURRENT` (wrong key length,
 * duplicate version, current version missing from the keyring): a config
 * mistake, not an unexpected failure, so it must answer 503 like "not
 * configured at all" rather than an unhandled 500. Its messages never
 * include raw key material — only version names and byte counts — so
 * re-wrapping the message here is still safe to surface.
 */
function toUnavailable(error: unknown): ProviderKeyUnavailableError {
  const detail = error instanceof Error ? error.message : "unknown error";
  return new ProviderKeyUnavailableError(`KEY_ENCRYPTION_KEYS is misconfigured: ${detail}`);
}

/** `error.code`, when `error` has one (pg and PGlite both attach the SQLSTATE as a string). */
function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === "string" ? code : undefined;
}

/**
 * The sealer for this call, built fresh from the current settings (PT-7b1):
 * settings are read once, at the composition root (`config.ts`), never
 * cached here, so a rotation (a new `KEY_ENCRYPTION_KEY_CURRENT`) takes
 * effect on the next call with no restart. `list` and `revoke` need no
 * sealer, so only `put` and `open` call this — a host with no KEK configured
 * can still list and revoke, and only writing or opening a key answers 503.
 */
function sealer(): HostSecretKeySealer {
  let settings: KeyEncryptionSettings | undefined;
  try {
    settings = keyEncryptionSettings();
  } catch (error) {
    throw toUnavailable(error);
  }
  if (!settings) {
    throw new ProviderKeyUnavailableError(
      "KEY_ENCRYPTION_KEYS is not set: org provider keys cannot be sealed or opened.",
    );
  }
  // HostSecretKeySealer's own constructor checks (key length, current version
  // present) mirror keyEncryptionSettings()'s, so settings that already
  // passed it never trip these — nothing further to wrap here.
  return new HostSecretKeySealer(settings);
}

interface ProviderKeyRow {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly sealed_dek: string;
  readonly dek_iv: string;
  readonly dek_tag: string;
  readonly kek_version: string;
}

function toSealedKey(row: ProviderKeyRow): SealedKey {
  return {
    ciphertext: row.ciphertext,
    iv: row.iv,
    tag: row.tag,
    sealedDek: row.sealed_dek,
    dekIv: row.dek_iv,
    dekTag: row.dek_tag,
    kekVersion: row.kek_version,
  };
}

/**
 * Provider keys as rows (PT-7b2, D175, D176), one org's: the store is built
 * for an org, so every statement is scoped to it and another org's keys are
 * invisible — the same shape as `PgDecisionStore`.
 */
export class PgProviderKeyStore implements ProviderKeyPort {
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  async put(provider: Provider, plaintext: string, actor: string): Promise<ProviderKeySummary> {
    const sealed = sealer().seal(plaintext, `${this.orgId}:${provider}`);
    const last4 = last4Of(provider, plaintext);
    const { createdAt } = await this.db.transaction(async (tx) => {
      // Revoke, then insert, in the same transaction (item 2): the partial
      // unique index on (org_id, provider) where revoked_at is null is the
      // backstop if two writers race here, refusing the second insert rather
      // than silently leaving two keys active for one provider.
      await tx.query(
        `update provider_key set revoked_at = now()
         where org_id = $1 and provider = $2 and revoked_at is null`,
        [this.orgId, provider],
      );
      let rows: { created_at: Date }[];
      try {
        ({ rows } = await tx.query<{ created_at: Date }>(
          `insert into provider_key
             (org_id, provider, ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version, last4, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           returning created_at`,
          [
            this.orgId,
            provider,
            sealed.ciphertext,
            sealed.iv,
            sealed.tag,
            sealed.sealedDek,
            sealed.dekIv,
            sealed.dekTag,
            sealed.kekVersion,
            last4,
            actor,
          ],
        ));
      } catch (error) {
        // Two concurrent PUTs for the same provider both revoke the prior
        // row, then both try to insert an active one; the partial unique
        // index on (org_id, provider) where revoked_at is null lets only one
        // insert through. The loser sees a constraint violation, not a
        // reason to 500 — it should just retry.
        if (pgErrorCode(error) === "23505") throw new ProviderKeyConflictError();
        throw error;
      }
      return { createdAt: rows[0]!.created_at };
    });
    return { provider, last4, createdAt: createdAt.toISOString() };
  }

  async list(): Promise<ProviderKeySummary[]> {
    const { rows } = await this.db.query<{ provider: Provider; last4: string; created_at: Date }>(
      `select provider, last4, created_at from provider_key
       where org_id = $1 and revoked_at is null
       order by provider`,
      [this.orgId],
    );
    return rows.map((row) => ({
      provider: row.provider,
      last4: row.last4,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async revoke(provider: Provider): Promise<void> {
    await this.db.query(
      `update provider_key set revoked_at = now()
       where org_id = $1 and provider = $2 and revoked_at is null`,
      [this.orgId, provider],
    );
  }

  async open(provider: Provider): Promise<string | undefined> {
    const { rows } = await this.db.query<ProviderKeyRow>(
      `select ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version
       from provider_key
       where org_id = $1 and provider = $2 and revoked_at is null`,
      [this.orgId, provider],
    );
    const row = rows[0];
    if (!row) return undefined;
    return sealer().open(toSealedKey(row), `${this.orgId}:${provider}`);
  }
}
