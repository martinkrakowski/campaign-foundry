import { randomUUID } from "node:crypto";
import { basename, dirname, extname } from "node:path";
import {
  ObjectExistsError,
  type ObjectKey,
  type ObjectStorePort,
} from "@campaignfoundry/CampaignOrchestration";
import { assetContentType } from "../asset-files.js";
import { hashBytes } from "../brief-files.js";
import { inputKey, inputPrefix } from "../object-store/object-keys.js";
import type { SqlClient } from "../db/sql-client.js";
import {
  isAssetId,
  type AssetCopyResult,
  type AssetEntry,
  type AssetOwner,
  type AssetStorePort,
  type CopyAssetsOptions,
} from "./asset-store.port.js";

/** `error.code`, when `error` has one (pg and PGlite both attach the SQLSTATE as a string). */
function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === "string" ? code : undefined;
}

/** The unique-violation SQLSTATE — `unique (campaign_id, kind, name)` said no. */
const UNIQUE_VIOLATION = "23505";

/**
 * A uuid-shaped campaign reference, the shape `deleteAssets` may be handed
 * directly. Deliberately the same pattern `PgBriefStore.resolveCampaign` tries
 * first: on this backend the id IS the uuid (D168) and the slug is only the
 * name it is addressed by.
 */
const CAMPAIGN_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only `kind` this lane stores; the row's column defaults to it too. */
const INPUT_KIND = "input";

/**
 * Where `copyAssets` puts one asset, discriminated on whether the target already
 * had it (PT-4k1). The `reused` arm carries the id of the row that is ALREADY
 * there; the fresh arm has none yet, because the id is minted by the caller that
 * is about to insert the row that will hold it.
 */
type CopyDestination =
  | { readonly name: string; readonly reused: false }
  | { readonly name: string; readonly reused: true; readonly id: string };

interface AssetRow {
  readonly id: string;
  readonly name: string;
  readonly sha256: string;
  /**
   * `size` is `bigint` so the column can hold any object's length, which `pg`
   * will not hand back as a JS number (int8 is outside the guarantee `pg` makes
   * for any column) while PGlite does. An asset is capped at 2 MiB by the
   * route, so `Number` below loses nothing either way.
   */
  readonly size: number | string;
  readonly content_type: string;
}

/**
 * `AssetStorePort` over Postgres rows plus an `ObjectStorePort` (PT-4b).
 *
 * **The interface is `AssetStorePort`, unchanged.** Every method here still
 * takes a campaign reference and a bare asset name and answers the shapes the
 * routes have always seen; nothing above this line learns that bytes live in a
 * bucket. That is the whole reason the split is a port: `FsAssetStore` and this
 * are two implementations of one contract, and the registry picks between them
 * on `OBJECT_STORE` alone.
 *
 * **A key never carries the slug or the name** (C7, DoD 3) — `inputKey` takes
 * ids only, and the row is what maps an id back to a name. Everything else here
 * follows from that split: a listing is a query rather than a listing of keys,
 * and a campaign is freed by emptying a prefix rather than a directory.
 *
 * **Org-scoped, never team-filtered.** The slug lookup below carries `org_id`
 * and nothing else, so another org's slug answers "absent" rather than
 * "forbidden" and this adapter never becomes a second, subtly different copy
 * of the team rules. Team visibility belongs to `PgBriefStore`, and the routes
 * that call it already refuse a hidden campaign before it ever reaches a store.
 *
 * Under `OBJECT_STORE=s3` the pipeline reads its inputs through
 * `ObjectInputAssets`, which reaches THIS adapter for the bytes (PT-4d); this is
 * the storage half, and the read path above it is a port.
 */
export class ObjectAssetStore implements AssetStorePort {
  constructor(
    private readonly db: SqlClient,
    private readonly store: ObjectStorePort,
    private readonly orgId: string,
  ) {}

  /**
   * See `AssetStorePort.assetRelPath` — UNCHANGED, and it stays a BRIEF-BODY
   * path with the slug in it. It is what a stored brief records, so it is what a
   * brief must keep saying; the key is a different thing and never appears in a
   * brief. PT-4k1 did NOT rewrite it into a key shape, and here is why that is
   * still right: the web writes this path into the brief until PT-4l teaches it
   * to send an id, and the SERVER is what normalises such a ref — first
   * org-scoped against the campaign it names, and then (PT-4k2b, D208d) into the
   * asset's own id at the save-time check. A path this returns is an input to
   * that check, not an output of it.
   */
  assetRelPath(briefId: string, name: string): string {
    return `assets/inputs/${briefId}/${name}`;
  }

  /**
   * See `AssetStorePort.writeAsset`, and it additionally answers the asset's own
   * `id` (PT-4k1) — the one ref the web can hand back once PT-4l reads it. The
   * order is the whole contract:
   *
   * 1. resolve the slug to the campaign's uuid, org-scoped;
   * 2. mint an asset id;
   * 3. `put` the bytes under a key carrying that id, with `ifNoneMatch: "*"`;
   * 4. insert the row, and on ANY failure remove the object again.
   *
   * **The row is the exclusive create, not the key.** Asset ids are random, so
   * a second upload of the same name writes a second, different key and the
   * store's conditional create passes — two objects and one refusal. The
   * unique index on `(campaign_id, kind, name)` is what turns the second insert
   * into a `23505`, and the object that insert could not claim is deleted
   * before the caller is told. `If-None-Match` stays as defence in depth for the
   * one case a key really can be taken: a retry of a write that already
   * succeeded.
   *
   * The returned id is the one that was MINTED, not one read back from the row:
   * it went in as `$1`, so the insert that is the exclusive create is also what
   * makes the returned id name an object — a row read afterwards could only say
   * the same thing, one round trip later, and could say a different one.
   */
  async writeAsset(
    briefId: string,
    name: string,
    bytes: Buffer,
  ): Promise<{ path: string; id: string }> {
    const campaignId = await this.resolveCampaignId(briefId);
    // Before the put, not after: an unresolved reference is the one failure with
    // nothing to undo, and a `23503` from the foreign key would be a genuine
    // error for a request the route is supposed to have refused with a 404
    // (assets.post.ts resolves first, D166's "absent, never forbidden").
    if (campaignId === undefined) {
      throw new Error(
        "Refusing to store an asset: the campaign reference does not resolve in this org.",
      );
    }
    const assetId = randomUUID();
    const key = inputKey(this.orgId, campaignId, assetId);
    const contentType = assetContentType(name);
    try {
      await this.store.put(key, bytes, { contentType, ifNoneMatch: "*" });
    } catch (error) {
      // The store kept its own object and never wrote ours (D174c), so there is
      // nothing to delete and nothing to explain differently: an exclusive
      // create that lost is this same 409 whether the index or the store caught
      // it, and a caller that handled one must handle the other.
      if (error instanceof ObjectExistsError) throw alreadyExists(this.assetRelPath(briefId, name));
      throw error;
    }
    try {
      // The minted id goes IN, not left to the column default: the key already
      // carries it, so a row whose `id` were generated independently would name
      // an object nobody can find and leave the one that was written unnameable.
      await this.db.query(
        `insert into asset (id, org_id, campaign_id, kind, name, size, sha256, content_type)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          assetId,
          this.orgId,
          campaignId,
          INPUT_KIND,
          name,
          bytes.length,
          hashBytes(bytes),
          contentType,
        ],
      );
    } catch (error) {
      // There is never a row without an object. The delete is best-effort in
      // BOTH branches — the answer the caller gets is decided by the insert,
      // and a store that cannot delete an object it just accepted is a problem
      // for the operator, not a reason to report a duplicate as a 500 or to
      // replace one storage failure with a different one. A leaked object under
      // an unreferenced id is invisible to every read in this class; a leaked
      // ROW is not, which is why the row is the half that must not survive.
      await this.discard(key);
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw alreadyExists(this.assetRelPath(briefId, name));
      }
      throw error;
    }
    return { path: this.assetRelPath(briefId, name), id: assetId, objectKey: key };
  }

  /**
   * See `AssetStorePort.readAsset`. `undefined` for a reference that does not
   * resolve, a row that is not there, and an object that is not there — the
   * three "absent" answers the fs store gives and the routes already handle.
   *
   * A store that REFUSES is different, and propagates: `S3RequestError` means
   * the store could not be read, and turning that into `undefined` would tell a
   * caller its asset is gone. It is a 500, and it stays one.
   */
  async readAsset(briefId: string, name: string): Promise<Buffer | undefined> {
    const campaignId = await this.resolveCampaignId(briefId);
    if (campaignId === undefined) return undefined;
    const row = await this.assetRow(campaignId, name);
    if (row === undefined) return undefined;
    const object = await this.store.get(inputKey(this.orgId, campaignId, row.id));
    return object === undefined ? undefined : Buffer.from(object.bytes);
  }

  /**
   * See `AssetStorePort.readAssetById`, and the three `undefined`s are decided
   * in this order — which matters, because two of the three cost nothing:
   *
   * 1. a ref that is not an id answers `undefined` WITHOUT a query. This is the
   *    guard `isAssetId` exists for (D203's shape rule, C1): `asset.id` is a
   *    `uuid` column, so binding `assets/inputs/winter-sale/logo.png` to
   *    `a.id = $2` raises `22P02` on pg and on PGlite alike, and the promise
   *    this method makes for a ref it cannot answer is `undefined`, never a
   *    throw. A query here would also make the shape rule load-bearing twice.
   * 2. a row no `asset` in THIS org holds answers `undefined` — another org's
   *    id included, which is why the query carries `org_id`. Another tenant's id
   *    is ABSENT, never forbidden, for the same reason another tenant's slug is
   *    (see {@link ObjectAssetStore.resolveCampaignId}).
   * 3. a row whose object is gone answers `undefined`: the row is not the bytes.
   *
   * A store that REFUSES propagates, as it does in `readAsset` — a bucket that
   * cannot be read is a 500, and turning it into `undefined` would tell a caller
   * its asset is gone.
   */
  async readAssetById(id: string): Promise<Buffer | undefined> {
    if (!isAssetId(id)) return undefined;
    const { rows } = await this.db.query<{ campaign_id: string }>(
      `select campaign_id from asset where org_id = $1 and id = $2`,
      [this.orgId, id],
    );
    const campaignId = rows[0]?.campaign_id;
    if (campaignId === undefined) return undefined;
    const object = await this.store.get(inputKey(this.orgId, campaignId, id));
    return object === undefined ? undefined : Buffer.from(object.bytes);
  }

  /**
   * See `AssetStorePort.assetOwner`. Org-scoped like every query here, and the
   * join is the reason this is not two calls: the slug lives on `campaign` and the
   * name on `asset`, and asking twice would be two round trips to answer one
   * question about one row — while a campaign renamed between them would be able
   * to disagree with itself.
   *
   * `kind = 'input'` is carried because the column is CHECK-constrained to
   * `input` today and `readAssetById` deliberately does NOT narrow by it (an id
   * is an id; the constraint is not what makes it org-scoped). Pinning it here
   * would make the two methods answer different questions about the same row the
   * moment a second kind lands, so the id stays the only selector and the check
   * stays the only gate. A row that is absent, another org's, or not an id answers
   * `undefined`, the same three as above.
   *
   * The join is also what filters a TOMBSTONED campaign (D231): an asset row
   * outlives its campaign until D232 step 3 sweeps it, and this must not hand
   * back a name and a slug for a campaign whose every other reader has already
   * stopped answering. `readAssetById` is deliberately NOT filtered — it never
   * joins `campaign` at all, and an id-addressed byte read stays one until the
   * purge deletes the rows (see the class docstring).
   */
  async assetOwner(id: string): Promise<AssetOwner | undefined> {
    if (!isAssetId(id)) return undefined;
    const { rows } = await this.db.query<{ campaign_id: string; slug: string; name: string }>(
      `select a.campaign_id, c.slug, a.name from asset a
         join campaign c on c.id = a.campaign_id
         where a.org_id = $1 and a.id = $2 and c.deleted_at is null`,
      [this.orgId, id],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { campaignId: row.campaign_id, slug: row.slug, name: row.name };
  }

  /**
   * See `AssetStorePort.assetObjectKey`. The key is the one {@link
   * ObjectAssetStore.writeAsset} built — `inputKey(this.orgId, campaignId,
   * row.id)` — so the `?name=` redirect hands a browser the very key the upload
   * wrote, and it goes through the same org-scoped `resolveCampaignId` and the
   * same `assetRow` every read above uses rather than a lookup of its own.
   *
   * The three `undefined`s are decided in that order, and two of them cost
   * nothing: a reference this org has no campaign for, then a name no row of that
   * campaign carries. **There is no third `get`** — the key is decided by rows,
   * and an object gone from under a row that exists is the store's 404 after the
   * redirect.
   */
  async assetObjectKey(briefId: string, name: string): Promise<ObjectKey | undefined> {
    const campaignId = await this.resolveCampaignId(briefId);
    if (campaignId === undefined) return undefined;
    const row = await this.assetRow(campaignId, name);
    if (row === undefined) return undefined;
    return inputKey(this.orgId, campaignId, row.id);
  }

  /**
   * See `AssetStorePort.listAssets`. Answered from ROWS, not from a listing of
   * the prefix: `name`, `type` and `size` are all columns, and reading a
   * remote store's metadata per asset would make one listing cost one round
   * trip per asset against a bucket that is not on this host. It also cannot
   * throw for "not found" — `campaignKnown` in `assets.get.ts` depends on an
   * unknown campaign answering `[]` rather than a refusal.
   *
   * `id` rides along for free (PT-4k1): it is the row's own primary key, so
   * carrying it costs one column on a query that already runs rather than a
   * lookup per entry, and it is what a caller needs to store a ref. fs leaves
   * the field absent, which is why the port declares it optional.
   *
   * `thumbnailUrl` is the route URL and is FINAL as of PT-4f (D209b) — not
   * "until PT-4f makes this a presigned URL", which is what this comment said
   * while that lane was planned. Two reasons it is the route URL and not a
   * presigned one, and both are load-bearing rather than tidiness: it never
   * expires (the grid holds these across a poll cycle, and a URL that died at the
   * next window would blank every thumbnail), and it costs no presign PER LISTED
   * ASSET, which a listing of a campaign with forty inputs would pay on every
   * tick. Under `s3` that same URL answers a 302 to a freshly presigned
   * location, so the browser still never sees a bucket path (D170) and the
   * listing stays one query.
   */
  async listAssets(briefId: string): Promise<readonly AssetEntry[]> {
    const campaignId = await this.resolveCampaignId(briefId);
    if (campaignId === undefined) return [];
    const { rows } = await this.db.query<Pick<AssetRow, "id" | "name" | "size">>(
      `select id, name, size from asset
        where org_id = $1 and campaign_id = $2 and kind = $3`,
      [this.orgId, campaignId, INPUT_KIND],
    );
    return rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        type: assetContentType(row.name),
        size: Number(row.size),
        // EXACTLY the fs store's string, slug-based and all, byte for byte —
        // a listing that spelled this differently on one backend would make the
        // two disagree about an asset that is the same file.
        thumbnailUrl: `/api/pipeline/campaigns/assets?briefId=${encodeURIComponent(briefId)}&name=${encodeURIComponent(row.name)}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * See `AssetStorePort.copyAssets`, and its map answers to THREE keys per copied
   * (or reused) asset — `name → destName`, `assets/inputs/<from>/<name> → <target
   * id>`, and `<source id> → <target id>` (PT-4k1, D208a).
   *
   * `rewriteAssetPaths` is unchanged and reads them in that order: `path in
   * pathMap` FIRST, so a full path ref is answered by the id it must become;
   * otherwise the `assets/inputs/<from>/` prefix branch looks the bare NAME up
   * and builds a path from it, which is why the name entry is still
   * name→name rather than name→id. That asymmetry is deliberate: the name entry
   * exists to feed a path BUILDER, and an id inside it would produce
   * `assets/inputs/<to>/<id>` — a ref nothing can read.
   *
   * **The target id is decided BEFORE anything is recorded** (PT-4k1), because a
   * reused asset has no insert to read an id back from: `destination()` answers
   * the EXISTING row's id when it says `reused`, so a name the target already
   * holds by these exact bytes maps to the row the target really has rather than
   * to an id of an object that was never written.
   *
   * The copy is a server-side `copy` to a NEW key with a NEW asset id, plus a
   * new row in the target — a campaign's assets are its own, and a key shared
   * between two campaigns is a key one campaign's `deleteAssets` would take
   * from under the other.
   *
   * **Collisions are decided on `sha256`, never by downloading anything.** A
   * target that already holds the same name with the same bytes reuses the name
   * and does nothing else: the asset the target has IS this asset, so copying
   * it again would write a second object that no row could ever name. That holds
   * on the SUFFIXED name too, not only the plain one: a target may already have
   * `logo-<from>.png` carrying exactly these bytes from an earlier copy, and
   * asking for a name the target already answers is not a copy — it is a no-op
   * the unique index would refuse. Same text as fs for the other case —
   * `<stem>-<from><ext>`, then `-2`, `-3` — so a duplicated campaign's brief
   * names the same files on both backends.
   *
   * **The id-ref gap PT-4k1 left is CLOSED (PT-4k2b, D208 D, D210 a/c).** An id ref
   * reaches a written brief through `resolveBriefAssetRefs`' `save` mode, which team-checks
   * it (`assetOwner` is org-scoped only, so the team half is the explicit
   * `campaignVisibility` call) and refuses a hidden campaign, another org's, an absent row
   * and a ref naming no campaign with ONE 404 — and every write route then copies the
   * foreign owners it named, so this map's `<source id> → <target id>` entry is what
   * remaps them. What `extractSourceAssetBriefIds` could not see, because it matches paths
   * only, is now seen by all four write routes (`briefs.post`, `briefs/[id].put`,
   * `duplicate.post`, `index.post`), and off `s3` the path-derived rule is unchanged.
   */
  async copyAssets(
    fromBriefId: string,
    toBriefId: string,
    options?: CopyAssetsOptions,
  ): Promise<AssetCopyResult> {
    // PT-9j0 (D237): `created` is owned by THIS frame and handed to the body, so a
    // throw part-way through still knows what the call had already made. Rows 1..N-1
    // of a source whose asset N failed are freed (version-checked) before the error is
    // rethrown; the failed asset's own object was already discarded.
    const created = new Set<string>();
    try {
      return await this.copyAssetsInto(fromBriefId, toBriefId, created, options?.only);
    } catch (error) {
      try {
        await this.freeUnreferencedAssets(toBriefId, [...created]);
      } catch {
        // Best-effort: the copy's own error is what the caller must hear, and a failed free
        // here is the leftover D239's reconciler (objects) or the release cascade (rows) takes.
      }
      throw error;
    }
  }

  /** The body of {@link copyAssets}; every id it mints is added to `created` the moment it is minted. */
  private async copyAssetsInto(
    fromBriefId: string,
    toBriefId: string,
    created: Set<string>,
    only: readonly string[] | undefined,
  ): Promise<AssetCopyResult> {
    if (fromBriefId === toBriefId) return { paths: {}, created: new Set() };
    const [fromId, toId] = await Promise.all([
      this.resolveCampaignId(fromBriefId),
      this.resolveCampaignId(toBriefId),
    ]);
    if (fromId === undefined || toId === undefined) return { paths: {}, created: new Set() };
    const all = await this.campaignAssets(fromId);
    const wanted = only === undefined ? undefined : new Set(only);
    const sources = wanted === undefined ? all : all.filter((source) => wanted.has(source.name));
    if (sources.length === 0) return { paths: {}, created: new Set() };

    const pathMap: Record<string, string> = {};
    for (const source of sources) {
      const destination = await this.destination(toId, fromBriefId, source);
      // FIRST, so all three entries can name it: a reused asset already has an
      // id — the target row's own — and a fresh one has to be minted before it
      // is recorded at all. Recording before this point is what the pre-PT-4k1
      // body did with a path, and the path is not what the map answers with.
      const assetId = destination.reused ? destination.id : randomUUID();
      record(pathMap, fromBriefId, source.name, destination.name, source.id, assetId);
      // The target already holds these exact bytes under this name, so there is
      // nothing to copy and nothing to insert — and copying anyway would be an
      // insert the unique index refuses, which is a 500 rather than the no-op
      // the caller asked for. This is what makes a duplicated campaign, or a
      // replace-save over an already-copied asset, idempotent.
      if (destination.reused) continue;
      created.add(assetId);
      const targetKey = inputKey(this.orgId, toId, assetId);
      try {
        // INSIDE the try, because a copy can fail AFTER it wrote: S3 answers
        // CopyObject's status line before it evaluates the copy, so the adapter
        // reads a success body afterwards (PT-4b's body-read wrap) and a read
        // that dies mid-stream rejects with the destination object already
        // stored. Nothing after this point would have named it.
        await this.store.copy(inputKey(this.orgId, fromId, source.id), targetKey);
        await this.db.query(
          `insert into asset (id, org_id, campaign_id, kind, name, size, sha256, content_type)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            assetId,
            this.orgId,
            toId,
            INPUT_KIND,
            destination.name,
            Number(source.size),
            source.sha256,
            source.content_type,
          ],
        );
      } catch (error) {
        // The same compensation `writeAsset` makes, and for the same reason: the
        // object is written before the row that will name it, and nobody rolls
        // this call back — `briefs.post.ts` runs it with no release step, and
        // neither does `briefs/[id].put.ts` (which has no reservation to release).
        // So EITHER half failing has to give the object back, or it sits under the
        // target's prefix with nothing that will ever name it.
        await this.discard(targetKey);
        // A concurrent copy of one name is the only `23505` left here (every
        // same-hash case above `continue`s before it gets this far), and it is
        // the same refusal `writeAsset` answers: that name is taken.
        if (pgErrorCode(error) === UNIQUE_VIOLATION) {
          throw alreadyExists(this.assetRelPath(toBriefId, destination.name));
        }
        throw error;
      }
    }
    return { paths: pathMap, created };
  }

  /**
   * See `AssetStorePort.deleteAssets`.
   *
   * A uuid is used AS the campaign id, with no lookup at all — the shape a
   * caller holding a campaign's id and no row can free. The routes do not use
   * it: they hold a SLUG and pass it, because this class has to resolve that
   * slug into a uuid through the campaign row, and a create rollback frees the
   * assets BEFORE the release that removes the row (PT-4b). PT-9e/D237: the
   * create rollback's replacement is `freeUnreferencedAssets` (wired by PT-9j);
   * this whole-campaign delete stays for the purge (by uuid/prefix) and for the
   * fs release. The uuid branch is
   * kept because it costs one regex test and answers a case that is otherwise
   * silently wrong: given an id no row resolves, a slug lookup would no-op.
   *
   * A non-uuid is a slug and is resolved; one that does not resolve is a no-op,
   * exactly as on fs, where the directory simply is not there.
   */
  async deleteAssets(briefId: string): Promise<void> {
    const campaignId = CAMPAIGN_UUID_PATTERN.test(briefId)
      ? briefId
      : await this.resolveCampaignId(briefId);
    if (campaignId === undefined) return;
    // The objects first, then the rows: a listing that throws leaves the rows
    // to cascade with the campaign, whereas emptying the prefix after the rows
    // are gone would lose the uuid→name mapping the listing is built from.
    await this.store.deletePrefix(inputPrefix(this.orgId, campaignId));
    await this.db.query(`delete from asset where org_id = $1 and campaign_id = $2`, [
      this.orgId,
      campaignId,
    ]);
  }

  async freeUnreferencedAssets(campaign: string, ids: readonly string[]): Promise<void> {
    // D236's 22P02 lesson: filter before the `::uuid[]` cast.
    const uuidIds = ids.filter(isAssetId);
    if (uuidIds.length === 0) return;
    const freed = await this.db.transaction(async (tx) => {
      const { rows: campaignRows } = await tx.query<{ id: string }>(
        `select id from campaign where org_id = $1 and slug = $2 and deleted_at is null for update`,
        [this.orgId, campaign],
      );
      const campaignId = campaignRows[0]?.id;
      if (campaignId === undefined) return { campaignId: undefined, ids: [] as string[] };
      const { rows } = await tx.query<{ id: string }>(
        `delete from asset
          where campaign_id = $1 and id = any($2::uuid[])
            and not exists (
              select 1 from brief_version v where v.campaign_id = $1 and position(asset.id::text in v.body) > 0
            )
          returning id`,
        [campaignId, uuidIds],
      );
      return { campaignId, ids: rows.map((r) => r.id) };
    });
    if (freed.campaignId === undefined) return;
    for (const id of freed.ids) {
      // Best-effort, AFTER commit: no object-store call inside the transaction (D237).
      await this.discard(inputKey(this.orgId, freed.campaignId, id));
    }
  }

  /**
   * The campaign uuid behind a slug, or `undefined` when this org has no such
   * campaign. `org_id` is in the WHERE clause and is the whole of the tenant
   * scope: without it, a slug that happens to be taken in another org would
   * resolve to that org's campaign and this store would hand back another
   * tenant's assets. A slug is not globally unique — the unique constraint is
   * `(org_id, slug)` — so this is a real key, not a defensive nicety.
   *
   * NOT team-filtered, and deliberately: `PgBriefStore.resolveCampaign` owns
   * team visibility and the routes call it before they get here. Re-implementing
   * it in the store would be a second copy of one rule, free to disagree.
   *
   * A TOMBSTONED campaign (D231) IS filtered, and that is not the same rule: a
   * team assignment can change while a caller holds a ref, but a tombstone means
   * the campaign is gone for good, so one filter here covers all six callers
   * (`writeAsset`, `readAsset`, `assetObjectKey`, `listAssets`, and both halves
   * of `copyAssets`) in a single query — `writeAsset` refuses with the same
   * "does not resolve in this org" error an absent campaign gets, and
   * `listAssets` answers `[]`, which is what makes `campaignKnown`'s
   * `assetKnown` fallback safe for a slug it could not resolve.
   *
   * `deleteAssets`' UUID branch does NOT come through here — it short-circuits a
   * uuid-shaped ref straight to `campaignId = briefId`, so it still acts on a
   * tombstoned campaign's uuid while `deleteAssets(slug)` is now a no-op. A
   * purge must therefore free a deleted campaign's inputs by PREFIX or by the
   * raw uuid, never by trusting `deleteAssets(slug)` to act.
   */
  private async resolveCampaignId(slug: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ id: string }>(
      `select id from campaign where org_id = $1 and slug = $2 and deleted_at is null`,
      [this.orgId, slug],
    );
    return rows[0]?.id;
  }

  private async assetRow(campaignId: string, name: string): Promise<AssetRow | undefined> {
    const { rows } = await this.db.query<AssetRow>(
      `select id, name, size, sha256, content_type from asset
        where org_id = $1 and campaign_id = $2 and kind = $3 and name = $4`,
      [this.orgId, campaignId, INPUT_KIND, name],
    );
    return rows[0];
  }

  private async campaignAssets(campaignId: string): Promise<readonly AssetRow[]> {
    const { rows } = await this.db.query<AssetRow>(
      `select id, name, size, sha256, content_type from asset
        where org_id = $1 and campaign_id = $2 and kind = $3
        order by name`,
      [this.orgId, campaignId, INPUT_KIND],
    );
    return rows;
  }

  /**
   * Where one source asset lands in the target, and whether it is ALREADY there.
   *
   * `reused` is the whole of the idempotency, and it is a claim about the BYTES
   * rather than about the name: the target holds a row with this exact `sha256`
   * under the chosen name, so the asset the target has IS this asset. The caller
   * records the mapping and does nothing else — no `copy`, no `insert`, and
   * therefore no second object that no row could name, and no `23505` from asking
   * for a name the target already answers. It holds for a SUFFIXED name as much
   * as for the plain one, which is the case a copy that runs twice reaches.
   *
   * The `reused: true` arm carries the EXISTING row's `id` (PT-4k1), and it is a
   * discriminated union rather than an optional `id?` for one reason: an optional
   * field does not narrow on `destination.reused`, so the caller's `destination
   * .reused ? destination.id : randomUUID()` would be a `string | undefined`
   * under `exactOptionalPropertyTypes` and the fresh copy's key would be built
   * from a type that admits nothing. Carrying it on the arm that HAS it is what
   * makes the caller total — and the caller's map has to name the asset the
   * target really has, which is this row, not a fresh id for an object nobody
   * wrote.
   *
   * fs's decision tree, in fs's order, with "is this candidate taken" answered by
   * a row rather than by `readFile`: the same question with the same answers and
   * no bytes moved. The suffix text is fs's word for word — `<stem>-<from><ext>`,
   * then `-2`, `-3`.
   */
  private async destination(
    toId: string,
    fromBriefId: string,
    source: AssetRow,
  ): Promise<CopyDestination> {
    const taken = await this.assetRow(toId, source.name);
    if (taken === undefined) return { name: source.name, reused: false };
    if (taken.sha256 === source.sha256) return { name: source.name, reused: true, id: taken.id };
    const extension = extname(source.name);
    const stem = basename(source.name, extension);
    const directory = dirname(source.name);
    for (let counter = 1; ; counter++) {
      const base = counter === 1 ? `${stem}-${fromBriefId}` : `${stem}-${fromBriefId}-${counter}`;
      const named = `${base}${extension}`;
      const candidate = directory === "." ? named : `${directory}/${named}`;
      const existing = await this.assetRow(toId, candidate);
      if (existing === undefined) return { name: candidate, reused: false };
      if (existing.sha256 === source.sha256) {
        return { name: candidate, reused: true, id: existing.id };
      }
    }
  }

  /**
   * Remove an object this call wrote, ignoring a failure to do so. See
   * `writeAsset`: the caller's answer is already decided, and swallowing is what
   * keeps a second, unrelated storage error from replacing the first one.
   */
  private async discard(key: ObjectKey): Promise<void> {
    try {
      await this.store.delete(key);
    } catch {
      // Nothing to do: the row that referenced this object is what must not
      // survive, and it does not.
    }
  }
}

/**
 * The refusal `assets.post.ts` already maps to a 409: it reads `code`, not the
 * message, so a duplicate answers the same as the fs store's `EEXIST` without
 * the route knowing a Postgres exists.
 */
function alreadyExists(path: string): Error {
  const error = new Error(`Asset "${path}" already exists.`);
  (error as { code?: string }).code = "EEXIST";
  return error;
}

/**
 * The three entries `copyAssets` records per source asset, and each answers a
 * DIFFERENT reader (PT-4k1):
 *
 * - `name → destName`, the bare name a brief body carries. UNCHANGED by this
 *   lane: `rewriteAssetPath`'s prefix branch finds this key and BUILDS
 *   `assets/inputs/<toBriefId>/<value>` from it, so an id here would make a ref
 *   nothing can read.
 * - `assets/inputs/<fromBriefId>/<name> → <target id>`. The full path a brief
 *   written before ids existed carries, remapped to what the target's ref must
 *   become. `rewriteAssetPath` checks `path in pathMap` FIRST, so this is the
 *   entry that answer wins on.
 * - `<source id> → <target id>`, the ref of a brief that was ALREADY id-addressed.
 *   Without it a duplicated campaign's second version would keep naming the
 *   FIRST campaign's asset — still readable, and now owned by a campaign whose
 *   `deleteAssets` this caller has no right to lean on.
 *
 * All three, always. Returning a subset is how a copied brief ends up naming an
 * asset that is not there, and the reader that loses is whichever kind of ref
 * this lane did not think about.
 */
function record(
  pathMap: Record<string, string>,
  fromBriefId: string,
  name: string,
  destName: string,
  sourceId: string,
  targetId: string,
): void {
  pathMap[name] = destName;
  pathMap[`assets/inputs/${fromBriefId}/${name}`] = targetId;
  pathMap[sourceId] = targetId;
}
