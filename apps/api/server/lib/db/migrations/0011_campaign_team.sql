-- Team scope on Postgres (D166; PT-2c). `campaign.team_id` goes from `uuid`
-- with no foreign key (0004_brief.sql) to `text references team (id) on
-- delete set null`: `team.id` is `text` (0008_auth.sql), so a `uuid` column
-- could never have held one anyway. No existing row has a value (no lane
-- before this one ever wrote `team_id`), so `using team_id::text` is a
-- null-to-null cast for every row — the conversion is safe. `on delete set
-- null` matches D166: deleting a team un-scopes its campaigns to org-wide
-- rather than orphaning or blocking the delete.
alter table campaign alter column team_id type text using team_id::text;

-- A single-column `campaign.team_id -> team.id` FK only proves the team
-- exists somewhere, never that it belongs to the campaign's own org — `team.id`
-- is globally unique, not org-scoped. The application (`assertTeamInOrg`)
-- already refuses a cross-org assignment, but a direct SQL write, an import,
-- or a future writer that bypasses it would not be. `team (org_id, id)` is
-- exactly campaign's own `unique (org_id, slug)` shape for the same reason,
-- and the composite FK below makes the invariant the database's, not just the
-- application's.
alter table team add constraint team_org_id_id_key unique (org_id, id);
-- `set null (team_id)` (not the bare `set null`, which would try to null
-- every column in the composite key, including `campaign.org_id`, and violate
-- its `not null`) is PG15+ syntax; PGlite 0.5.x and CloudNativePG's default
-- image are both well past that.
alter table campaign add constraint campaign_team_id_fkey foreign key (org_id, team_id) references team (org_id, id) on delete set null (team_id);
