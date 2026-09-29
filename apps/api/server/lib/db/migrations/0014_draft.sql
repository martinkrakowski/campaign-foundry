-- Per-user server drafts (PT-5d, D173, D177): autosave writes here instead of
-- localStorage, debounced client-side, so one browser's draft never collides
-- with another user's edits on the same campaign, and a draft survives a
-- device switch. One row per (campaign, user); a fresh PUT replaces it in
-- place — a draft is not an audit trail, unlike `brief_version`.
--
-- `user_id` is the caller's session identity, the same one
-- `requestTenant(event).userId` answers; nothing here is ever read from a
-- request body. Plain `text`, not a FK to `"user"(id)` (fix round, bots —
-- real, twice over): `LOCAL_TENANT.userId` is `"local"` under
-- `AUTH_MODE=local`, and no migration ever seeds a matching `"user"` row for
-- it (that mode has no Better Auth session to seed one from) — every draft
-- PUT under that combination failed the FK with a 500 that `putServerDraft`
-- swallows client-side, so autosave and resume silently did nothing. A FK
-- also meant a user could never be deleted while they had a saved draft,
-- unlike Better Auth's own tables, which cascade. `brief_version.actor`
-- (0004_brief.sql) already carries the identical "session identity, not
-- always a real Better Auth row" shape as plain `text` for the same reason —
-- this column now matches it.
--
-- `base_revision` is the campaign's published revision (`StoredBrief.revision`,
-- the SHA-256 the brief store answers) the draft was taken against — null for
-- a versionless campaign (D177: "no published version" is itself a value this
-- column carries, not the absence of one). It is what `BriefEditor` compares
-- against the campaign's current revision before restoring a draft, and what
-- a PUT is refused for (409) when it has gone stale.
create table draft (
  campaign_id uuid not null references campaign (id) on delete cascade,
  user_id text not null,
  org_id text not null references org (id),
  state jsonb not null,
  base_revision text,
  updated_at timestamptz not null default now(),
  primary key (campaign_id, user_id)
);

-- W3's resume: the caller's latest draft across every campaign in their org,
-- read without knowing which campaign it belongs to.
create index draft_org_user_updated_idx on draft (org_id, user_id, updated_at desc);
