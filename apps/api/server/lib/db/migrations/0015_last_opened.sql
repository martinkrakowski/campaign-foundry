-- The per-user last-opened campaign pointer (PT-5e, D173, D180): the campaign
-- this user last opened, so the bare `/brief`, `/grid`, `/export`, `/runs` and
-- `/compliance` routes can hand them back to it. One row per (org, user) — the
-- pointer is a convenience, never an address (D37): the URL still names which
-- campaign a page shows, exactly as it does for the editor.
--
-- `user_id` is the caller's session identity, the same one
-- `requestTenant(event).userId` answers, and nothing here is ever read from a
-- request body. Plain `text`, NOT a FK to `"user"(id)` — the same deviation
-- PT-5d made in `0014_draft.sql`, for the same two reasons: `LOCAL_TENANT.userId`
-- is `"local"` under `AUTH_MODE=local` and no migration seeds a matching
-- `"user"` row for it, so every write under that combination would fail the FK
-- with a 500 (which the web's pointer write swallows, and a last-opened pointer
-- that silently never persists is the exact defect this lane exists to fix); and
-- a FK would also stop a user being deleted while they had a pointer, unlike
-- Better Auth's own tables, which cascade. `brief_version.actor`
-- (`0004_brief.sql`) carries the identical "session identity, not always a real
-- Better Auth row" shape as plain `text`, and so does `draft.user_id`.
--
-- `campaign_id` carries the real Postgres surrogate (D168) and cascades on
-- delete, so a deleted campaign takes its pointers with it rather than leaving
-- a row that could only ever answer "no pointer" (D166: every record belongs to
-- exactly one org, and a record whose subject is gone is not a record).
-- `last_opened` is itself in `RESERVED_CAMPAIGN_IDS`, so no campaign can hold
-- this slug and shadow the static route.
create table last_opened (
  org_id text not null references org (id),
  user_id text not null,
  campaign_id uuid not null references campaign (id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
