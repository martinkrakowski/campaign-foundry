-- Metering and quotas (PT-7a, D175): a usage row per generation, and a
-- calendar-month quota on `org` that gates admission before any provider call
-- (generate.post.ts's admission region). Additive only: PT-1a's 0008 also
-- alters `org`.
--
-- `monthly_generation_quota` null means unlimited (the operator's `local`
-- org, until an owner sets one).
alter table org add column monthly_generation_quota integer;

-- One row per non-cached, successful generation: an image background resolved
-- by a provider, or one copy-pool request. `units` is the images or copy
-- variants that generation produced, for cost reporting; the admission check
-- counts rows, not units (D175: "every generation records … against a
-- quota"). `key_owner` is always 'platform' in this wave; PT-7b adds 'org'
-- (BYOK).
create table usage (
  id bigserial primary key,
  org_id text not null references org (id),
  provider text not null,
  model text not null,
  units integer not null,
  key_owner text not null check (key_owner in ('platform', 'org')),
  created_at timestamptz not null default now()
);

-- The admission check and any per-org usage listing both filter by org and
-- range over time.
create index usage_org_created_idx on usage (org_id, created_at);
