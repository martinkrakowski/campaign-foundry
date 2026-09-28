-- The display name and campaign type a user typed at Create (PT-5b3, D168,
-- D177). A blank Create mints a versionless `campaign` row (PT-5b2), so
-- today the name and type live nowhere on the server once #614 validates
-- `type` and stores nothing — PT-5c retires the `cf:create-seed` that
-- carried them to the editor. Both are nullable: a pre-lane campaign, and
-- fs's own `campaign.json`-less reservations, answer null for either. Saving
-- a version never touches these columns, so they survive every Save.
alter table campaign add column name text;
alter table campaign add column type text;
