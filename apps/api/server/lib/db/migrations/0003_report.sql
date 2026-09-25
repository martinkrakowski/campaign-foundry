-- Campaign reports (PT-3c, D169): one row per (org, campaign) holding the
-- report bytes `report.ts` wrote, verbatim.
--
-- `body` is `text`, not `jsonb`: a jsonb column re-serialises the payload (key
-- order, whitespace), which would change its SHA-256 — the revision — away
-- from the file store's for the same payload, and a PT-8 import would not
-- keep it.
--
-- `campaign_id` is the campaign's key as the routes carry it today, its slug.
-- It becomes the campaign's surrogate id once briefs are rows (D168).
create table report (
  org_id text not null references org (id),
  campaign_id text not null,
  body text not null,
  revision text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, campaign_id)
);
