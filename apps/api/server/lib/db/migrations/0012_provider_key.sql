-- Org provider keys, sealed (PT-7b2, D175, D176): an org's own Gemini,
-- OpenRouter or Firefly credentials (BYOK), envelope-encrypted with the host
-- secret KEK (PT-7b1's `HostSecretKeySealer`) and never stored in the clear.
-- Firefly's client id and secret are sealed together as one plaintext, so
-- this table has no notion of "two keys for one provider".
--
-- A row is replaced, not updated: `put` revokes the active row and inserts a
-- new one in the same transaction, so `revoked_at is null` always identifies
-- at most one row per (org, provider) — the partial unique index below is
-- what makes that "at most one" true even across two racing writers.
create table provider_key (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references org (id),
  provider text not null check (provider in ('gemini', 'openrouter', 'firefly')),
  -- The sealed envelope (PT-7b1's SealedKey), base64 strings as `seal` returns them.
  ciphertext text not null,
  iv text not null,
  tag text not null,
  sealed_dek text not null,
  dek_iv text not null,
  dek_tag text not null,
  kek_version text not null,
  -- The last 4 characters of the plaintext `put` sealed, so an owner can tell
  -- keys apart without ever reading one back.
  last4 text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index provider_key_active on provider_key (org_id, provider) where revoked_at is null;
