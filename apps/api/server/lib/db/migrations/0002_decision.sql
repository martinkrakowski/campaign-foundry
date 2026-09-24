-- Review decisions (PT-3, D173): one row per creative's verdict, with who gave it,
-- when, and the run (the report revision) it was given against.
--
-- `campaign_id` is the campaign's key as the routes carry it today, its slug. It
-- becomes the campaign's surrogate id once briefs are rows (D168).
create table decision (
  org_id text not null references org (id),
  campaign_id text not null,
  asset_key text not null,
  verdict text not null check (verdict in ('approved', 'rejected')),
  actor text not null,
  decided_at timestamptz not null,
  run text not null,
  primary key (org_id, campaign_id, asset_key)
);

-- The revision of a campaign's decisions: what a save must name, so a second
-- tab's stale save is a conflict (D82). Present once decisions have been written.
create table decision_set (
  org_id text not null references org (id),
  campaign_id text not null,
  revision text not null,
  primary key (org_id, campaign_id)
);
