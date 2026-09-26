-- Quota reservation under concurrency (PT-7a2, D175).
--
-- Today assertUnderQuota reads the quota and count, and a usage row is written
-- only after the provider returns: parallel cells and concurrent jobs pass
-- against the same stale count. A reservation row claims a slot inside an
-- advisory-locked transaction before any provider call; on success settle
-- updates it to 'recorded' with provider, model and units, while release
-- deletes it on failure, cache hit, or fallback-owned delegation.
--
-- Status is 'recorded' by default so existing rows and direct writes stay valid.
-- Columns that describe the settled generation are made nullable so a reserved
-- row can be inserted before those fields are known.
alter table usage add column status text not null default 'recorded' check (status in ('reserved', 'recorded'));

alter table usage alter column provider drop not null;
alter table usage alter column model drop not null;
alter table usage alter column units drop not null;
alter table usage alter column key_owner drop not null;
