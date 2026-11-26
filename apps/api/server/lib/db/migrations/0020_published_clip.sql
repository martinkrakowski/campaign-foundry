-- Published ad clips (PT-4k): the durable ledger of which clips a campaign has
-- published to the PUBLIC bucket — the store key and the plain URL a browser
-- fetches. One row per content hash: the same bytes never publish twice, and
-- `record`'s `on conflict do nothing` settles the race idempotently.
create table published_clip (
  org_id text not null references org (id),
  -- No `on delete cascade`, deliberately: the public object behind `key` must
  -- be removed from the public bucket BEFORE the row goes (the delete use
  -- case removes bytes first), so a bare campaign delete must be refused with
  -- FK 23503 rather than silently orphaning published bytes.
  campaign_id uuid not null references campaign (id),
  content_hash text not null,
  key text not null unique,
  url text not null,
  created_at timestamptz not null default now(),
  -- `org_id` is part of the primary key so every statement is filtered by org
  -- (one org can never read, remove, or collide with another org's record)
  -- and so the org purge's `delete ... where org_id = $1` needs no second index.
  primary key (org_id, campaign_id, content_hash)
);
