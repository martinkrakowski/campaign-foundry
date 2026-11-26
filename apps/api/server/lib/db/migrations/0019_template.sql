-- Org-scoped templates (RW-22): an org's own creative templates, written
-- alongside the canonical library (which stays ownerless, in memory, and
-- never writable). Writes only ever create new (org_id, id, version) rows —
-- a version is immutable once stored, so an overwrite is impossible by the
-- primary key.
--
-- `created_by` is plain `text`, not a FK to `"user"(id)`, matching
-- `0014_draft.sql` (and `brief_version.actor`, 0004_brief.sql): the actor is
-- session identity, not always a real Better Auth row ("local" under
-- AUTH_MODE=local), and a user must be erasable while their templates remain
-- — erasure re-attributes `created_by` to an `erased:<uuid>` token instead.
create table template (
  org_id text not null references org (id),
  id text not null,
  version int not null check (version >= 1),
  name text not null,
  unit text not null,
  creative_type text not null,
  layers jsonb not null,
  created_at timestamptz not null default now(),
  created_by text not null,
  primary key (org_id, id, version)
);
