-- PT-3 foundation (D166, D174a). Every record belongs to exactly one org, and
-- every later table carries `org_id` referencing this one.
--
-- The id is the org's key everywhere else (storage roots, object keys, rows).
-- Once PT-1 lands it is the auth provider's org id; until then the only org is
-- `local`, the operator the API has always served (`LOCAL_TENANT`).
create table org (
  id text primary key check (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  name text not null,
  created_at timestamptz not null default now()
);

insert into org (id, name) values ('local', 'Local operator');
