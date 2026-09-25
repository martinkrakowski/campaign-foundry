-- Briefs as rows (PT-3d, D168, D169): `campaign` mints the org-scoped surrogate
-- id and carries the slug, the domain id every route and BriefStorePort still
-- address a brief by until PT-5 moves routes to ids. `brief_version` is one
-- row per save, so a write is an audit entry, never an overwrite, and it
-- carries the actor and a SHA-256 of the canonical YAML (`dumpBrief`) as its
-- revision.
create table campaign (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references org (id),
  slug text not null,
  -- Reserved for D166's team-scoped campaigns; no team table exists yet.
  team_id uuid,
  created_at timestamptz not null default now(),
  unique (org_id, slug)
);

-- `body` is `text`, not `jsonb`: a jsonb column re-serialises the payload
-- (nested key order, whitespace), which would silently reorder a brief's
-- nested objects (e.g. `products[0]`'s keys) on every round trip — `text`
-- keeps exactly the `JSON.stringify(brief)` bytes the store wrote.
create table brief_version (
  campaign_id uuid not null references campaign (id),
  version int not null,
  body text not null,
  revision text not null,
  actor text not null,
  created_at timestamptz not null default now(),
  primary key (campaign_id, version)
);
