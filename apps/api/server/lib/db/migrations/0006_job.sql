-- Durable job rows (PT-6a, D171): the job row IS the lease, the adoption handle
-- and the poll target. A worker claims a campaign with one statement (an insert
-- guarded by a partial unique index), heartbeats to keep its lease alive, and a
-- reaper fails a row whose lease has lapsed so a crashed worker cannot lock a
-- campaign forever.
--
-- `id` is text, not a generated key: the claim's caller mints it (as the file
-- store's `crypto.randomUUID()` does) so the SAME statement can return either the
-- freshly minted id (an insert) or the incumbent's (a conflict), which a
-- database default could not do.
create table job (
  id text primary key,
  org_id text not null references org (id),
  campaign_id text not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  done int not null default 0,
  total int not null default 0,
  log jsonb,
  result jsonb,
  error text,
  -- Set on claim and refreshed by every heartbeat; a reaper run before the next
  -- claim fails any running row whose lease is in the past.
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  -- Insertion order, for the same tie-break `fs-job-store.ts`'s in-memory
  -- counter gives listJobs: two rows in the same millisecond still sort stably.
  seq bigserial not null,
  settled_at timestamptz
);

-- One running campaign per org at a time (D171): the claim's insert conflicts on
-- this index, never on a bare (org_id, campaign_id) key, so a completed or failed
-- row never blocks the next claim, and a reaped row's campaign is claimable again
-- the moment the reaper flips its status.
create unique index job_running_campaign on job (org_id, campaign_id) where status = 'running';

-- Listing and capacity eviction both scan an org's jobs oldest first.
create index job_org_created on job (org_id, created_at, seq);
