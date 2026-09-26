-- Team scope on Postgres (D166; PT-2c). `campaign.team_id` goes from `uuid`
-- with no foreign key (0004_brief.sql) to `text references team (id) on
-- delete set null`: `team.id` is `text` (0008_auth.sql), so a `uuid` column
-- could never have held one anyway. No existing row has a value (no lane
-- before this one ever wrote `team_id`), so `using team_id::text` is a
-- null-to-null cast for every row — the conversion is safe. `on delete set
-- null` matches D166: deleting a team un-scopes its campaigns to org-wide
-- rather than orphaning or blocking the delete.
alter table campaign alter column team_id type text using team_id::text;
alter table campaign add constraint campaign_team_id_fkey foreign key (team_id) references team (id) on delete set null;
