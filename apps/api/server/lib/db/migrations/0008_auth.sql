-- Better Auth in the API (PT-1a, D174b(2)): users, sessions, accounts,
-- verification tokens, and the organisation model Better Auth's `organization`
-- plugin needs, mapped onto `org` (0001) rather than a second table (D174b(1)).
--
-- This SQL is hand-translated from Better Auth's own Kysely migration plan
-- (`getMigrations`, run against a PGlite database carrying only 0001-0007), so
-- the schema-agreement test (`lib/auth/__tests__/schema-agreement.test.ts`) can
-- assert Better Auth finds nothing left to create once this migration has run.
-- Every table and column name below is a `fields`/`modelName` mapping given to
-- `betterAuth()` in `lib/auth/config.ts`; changing a name in one place without
-- the other is exactly what that test exists to catch.

-- `org` gains the columns Better Auth's organisation model requires. The id
-- check tightens to SAFE_ID_PATTERN's form: an org id is a path segment
-- (`tenantRoot`) and a Better Auth model id, so it must be safe for both, not
-- just the wider set 0001 allowed before either consumer existed.
alter table org drop constraint org_id_check;
alter table org add constraint org_id_check check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$');

alter table org add column slug text;
alter table org add column logo text;
alter table org add column metadata text;
-- Backfill before the not-null: 'local' is the only row 0001 ever inserted.
update org set slug = id where slug is null;
alter table org alter column slug set not null;
create unique index org_slug_uidx on org (slug);

create table "user" (
  id text primary key,
  name text not null,
  email text not null unique,
  email_verified boolean not null,
  image text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table session (
  id text primary key,
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null,
  ip_address text,
  user_agent text,
  user_id text not null references "user" (id) on delete cascade,
  -- The organisation plugin's session extension: which org and team a session
  -- is currently acting in. Better Auth's own default field names (camelCase,
  -- unmapped): they are its session bookkeeping, not a house-convention table.
  "activeOrganizationId" text,
  "activeTeamId" text
);
create index session_user_id_idx on session (user_id);

create table account (
  id text primary key,
  account_id text not null,
  provider_id text not null,
  user_id text not null references "user" (id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null
);
create index account_user_id_idx on account (user_id);

create table verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);
create index verification_identifier_idx on verification (identifier);

create table team (
  id text primary key,
  name text not null,
  -- Server-computed by the organisation plugin's adapter, never client input.
  "memberCount" integer not null,
  org_id text not null references org (id) on delete cascade,
  created_at timestamptz not null,
  updated_at timestamptz
);
create index team_org_id_idx on team (org_id);

create table team_member (
  id text primary key,
  team_id text not null references team (id) on delete cascade,
  user_id text not null references "user" (id) on delete cascade,
  -- Server-computed dedup key (org plugin adapter); never client input.
  "membershipKey" text unique,
  created_at timestamptz
);
create index team_member_team_id_idx on team_member (team_id);
create index team_member_user_id_idx on team_member (user_id);

create table member (
  id text primary key,
  org_id text not null references org (id) on delete cascade,
  user_id text not null references "user" (id) on delete cascade,
  role text not null,
  created_at timestamptz not null
);
create index member_org_id_idx on member (org_id);
create index member_user_id_idx on member (user_id);

create table invitation (
  id text primary key,
  org_id text not null references org (id) on delete cascade,
  email text not null,
  role text,
  team_id text,
  status text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default current_timestamp,
  inviter_id text not null references "user" (id) on delete cascade
);
create index invitation_org_id_idx on invitation (org_id);
create index invitation_email_idx on invitation (email);
