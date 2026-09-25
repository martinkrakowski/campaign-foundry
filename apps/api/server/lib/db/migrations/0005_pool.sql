-- Copy pools on Postgres (PT-3e, D169): one row per (org, campaign) holding the
-- pool document and the revision of its bytes, so a stale write is refused
-- just as the file store's is (D79/D80). The whole pool overwrites at once —
-- there is no per-entry row, matching how `FsPoolStore.writePool` replaces the
-- whole `pools.json` file.
--
-- `campaign_id` is the campaign's key as the routes carry it today, its slug. It
-- becomes the campaign's surrogate id once briefs are rows (D168), same as
-- `decision.campaign_id` — no foreign key yet.
create table pool (
  org_id text not null references org (id),
  campaign_id text not null,
  -- The exact bytes `FsPoolStore.writePool` writes: `JSON.stringify(pool, null, 2)`
  -- plus a trailing newline. Never jsonb, which would re-serialise them and change
  -- the revision (the digest of these bytes, not a field on the document).
  body text not null,
  revision text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, campaign_id)
);
