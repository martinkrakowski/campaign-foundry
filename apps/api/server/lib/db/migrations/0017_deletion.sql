-- The tombstone and the queue it is swept from (PT-9a1, D231, D233).
--
-- `campaign.deleted_at` HIDES the campaign at once, in one place every reader
-- already goes: the row stays, and every query this lane filters answers as
-- though the campaign were never created. Nothing is deleted here — the columns
-- are the whole of this migration's visible effect, and a `null` on every
-- existing row is a null-to-null change (no lane before this one ever wrote the
-- column), so there is no backfill and no default to reason about.
--
-- `deleted_by` is `text`, NOT a FK to `"user"(id)`, and it is the same
-- "session identity, not always a real row" shape `brief_version.actor`
-- (0004_brief.sql) and `draft.user_id` (0014_draft.sql) already carry: the
-- actor recorded here is the requester's session id, and under `AUTH_MODE=local`
-- that is `"local"`, for which no `"user"` row exists. A FK would turn every
-- tombstone under that mode into a 500 — the exact failure 0014 records.
--
-- No DEFAULT on either, deliberately. A default of `now()` would make every
-- campaign ever inserted already deleted, and a default of `null` would be a
-- default that says nothing the absence of a clause does not.
alter table campaign add column deleted_at timestamptz;
alter table campaign add column deleted_by text;
--
-- `deletion` is the DURABLE QUEUE the sweeper claims from (PT-9f/9g own the
-- claim and the purge; this lane owns only the shape and the index it depends
-- on). One row per requested erasure, carrying WHEN it may happen
-- (`not_before`) rather than when it was asked for, so a grace period is a
-- column and not a scheduler.
--
-- `org_id` carries NO foreign key, and that is load-bearing rather than an
-- oversight: a `kind = 'org'` row is retained PAST the org row's own purge
-- window (D241), so a `deletion` row MUST be able to outlive the `org` it
-- names — which a FK forbids outright, by refusing the org delete outright. This
-- is this database's own precedent, not a new shape: `job.campaign_id text not
-- null` (0006_job.sql) and `report.campaign_id text not null` (0003_report.sql)
-- are both text columns naming a row in another table with no `references` on
-- either. The same is true of `subject`, which may name a campaign this very
-- sweep is about to delete, or an `erased:<uuid>` token that names nothing here
-- at all (D231).
--
-- `org_id` stays NULLABLE and the CHECK below ties that to `kind`: a
-- `kind = 'user'` erasure is scoped to no single org (D240, lane 9l), while
-- `campaign` and `org` erasures always are. Encoding the pairing as one
-- constraint means 9l never has to follow this with a migration to relax a NOT
-- NULL it would otherwise have had to predict.
--
-- `claimed_until` is the sweeper's lease on a row, and `attempts`/`last_error`
-- are what make a row that keeps failing diagnosable rather than silently
-- skipped. Neither is read by any lane yet; they are columns rather than
-- derivations because a claim that cannot record its own failure is a claim that
-- cannot be retried.
create table deletion (
  id uuid primary key default gen_random_uuid(),
  org_id text,
  kind text not null check (kind in ('campaign', 'org', 'user')),
  -- The thing to erase: a campaign slug, an org id, or an `erased:<uuid>` token.
  subject text not null,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  -- The earliest moment this sweep may run, so a grace period is data.
  not_before timestamptz not null,
  claimed_until timestamptz,
  attempts int not null default 0,
  last_error text,
  purged_at timestamptz,
  -- A user erasure is not org-scoped; the other two always are (see above).
  check ((kind = 'user') = (org_id is null))
);

-- The sweeper's claim query is "everything due and not yet done, oldest first",
-- which is exactly this index: `purged_at is null` keeps a finished row — which
-- is a row that must never be claimed again — out of the scan entirely, rather
-- than filtering it after the fact. The partial predicate is what makes the
-- index smaller than the table for the rest of a row's life.
create index deletion_sweep_idx on deletion (not_before) where purged_at is null;