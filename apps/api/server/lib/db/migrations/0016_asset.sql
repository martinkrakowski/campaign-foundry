-- Uploaded campaign inputs as rows (PT-4b, C7): one row per uploaded asset,
-- the metadata the listing and the read answer from. Today an upload is a file
-- under `assets/inputs/<briefId>/<name>` and nothing else — the object store is
-- the only place a name exists, so a listing is a listing, a size is a `stat`,
-- and a rename or a copy has to move bytes to be recorded. The row makes the
-- asset a record the database owns, and the bytes move behind `ObjectStorePort`
-- (D201) while `AssetStorePort`'s own shape is unchanged.
--
-- `campaign_id` is the campaign's Postgres surrogate (D168), NOT the slug the
-- routes carry: the key an input is stored under is `org/<org>/campaign/<uuid>/…`
-- (C7), and a key that carried the slug would put a user-chosen, renameable
-- string in the store's namespace — so the uuid is what the object path is
-- built from too. `on delete cascade` is what makes a released campaign's
-- assets go with it, which is why the create rollback deletes by the minted
-- uuid (a slug no longer resolves once the campaign row is gone).
--
-- `org_id` is carried beside the campaign id rather than derived from it,
-- matching `draft` (0014) and `last_opened` (0015): every read in the adapter
-- is `org_id = $1 and …`, so the tenant predicate is one the index can use and
-- a campaign id from another org can never answer "present" — the slug lookup
-- that finds the uuid is org-scoped, and a ref that resolves to nothing is
-- "absent", never "forbidden".
--
-- `kind` is `input` for everything this lane stores, and the check says so
-- rather than leaving the column open: a second kind (a rendered asset, a
-- proof) is a different answer to `AssetEntry.type` and a different key
-- segment, and admitting the value now would let a row name a namespace no
-- reader knows. The DEFAULT is `input` so an insert that forgets it is a
-- default rather than a NOT NULL violation.
--
-- `unique (campaign_id, kind, name)` IS the exclusive create (D174c), and it
-- is the whole of it. The object key is per-ASSET-id, not per name, so two
-- uploads of the same name would otherwise both find a free key, both store
-- bytes and both try to insert: the index is what turns the second insert into
-- a refusal, and the adapter deletes the object it just wrote before
-- answering. The store's own `If-None-Match: "*"` cannot be that check — asset
-- ids are random, so the second writer's key is new and the conditional create
-- passes. The index is defence in depth, the database's, and it holds across
-- processes rather than within one.
--
-- `size` is the byte length of what was written, not what the object store
-- later reports: the listing is answered from rows alone (N HEADs against a
-- remote store is a listing that costs a round trip per asset), and the row is
-- the record of the write that happened. `sha256` is the digest of those same
-- bytes, which is what lets `copyAssets` recognise a collision as "the same
-- asset under another campaign" and reuse the name instead of inventing a
-- suffix for a file the target already has.
create table asset (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references org (id),
  campaign_id uuid not null references campaign (id) on delete cascade,
  kind text not null default 'input' check (kind in ('input')),
  name text not null,
  size bigint not null,
  sha256 text not null,
  content_type text not null,
  created_at timestamptz not null default now(),
  unique (campaign_id, kind, name)
);

-- The listing, and `deleteAssets`' row delete: both are per campaign, and the
-- unique index above leads with `campaign_id` so it already serves them. This
-- index is the org-scoped read `readAsset` and the slug lookup behind it
-- cannot use the unique index for, since neither names the org.
create index asset_org_campaign_idx on asset (org_id, campaign_id);
