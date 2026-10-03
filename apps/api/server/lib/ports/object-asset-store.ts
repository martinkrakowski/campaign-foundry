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
import type { AssetEntry, AssetStorePort } from "./asset-store.port.js";

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
   * brief. Rewriting this into a key shape is PT-4k's job (C4).
   */
  assetRelPath(briefId: string, name: string): string {
    return `assets/inputs/${briefId}/${name}`;
  }

  /**
   * See `AssetStorePort.writeAsset`. The order is the whole contract:
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
   */
  async writeAsset(briefId: string, name: string, bytes: Buffer): Promise<{ path: string }> {
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
    return { path: this.assetRelPath(briefId, name) };
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
   * See `AssetStorePort.listAssets`. Answered from ROWS, not from a listing of
   * the prefix: `name`, `type` and `size` are all columns, and reading a
   * remote store's metadata per asset would make one listing cost one round
   * trip per asset against a bucket that is not on this host. It also cannot
   * throw for "not found" — `campaignKnown` in `assets.get.ts` depends on an
   * unknown campaign answering `[]` rather than a refusal.
   */
  async listAssets(briefId: string): Promise<readonly AssetEntry[]> {
    const campaignId = await this.resolveCampaignId(briefId);
    if (campaignId === undefined) return [];
    const { rows } = await this.db.query<Pick<AssetRow, "name" | "size">>(
      `select name, size from asset
        where org_id = $1 and campaign_id = $2 and kind = $3`,
      [this.orgId, campaignId, INPUT_KIND],
    );
    return rows
      .map((row) => ({
        name: row.name,
        type: assetContentType(row.name),
        size: Number(row.size),
        // EXACTLY the fs store's string, slug-based and all, until PT-4f makes
        // this a presigned URL: the route hands this back to a browser, and a
        // listing that pointed somewhere the GET route does not serve would be
        // a 404 on an asset that is right there.
        thumbnailUrl: `/api/pipeline/campaigns/assets?briefId=${encodeURIComponent(briefId)}&name=${encodeURIComponent(row.name)}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * See `AssetStorePort.copyAssets`, and it returns fs's two-entry map byte for
   * byte (`rewriteAssetPaths` reads both keys, and C4 is PT-4k's to change).
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
   */
  async copyAssets(fromBriefId: string, toBriefId: string): Promise<Record<string, string>> {
    if (fromBriefId === toBriefId) return {};
    const [fromId, toId] = await Promise.all([
      this.resolveCampaignId(fromBriefId),
      this.resolveCampaignId(toBriefId),
    ]);
    if (fromId === undefined || toId === undefined) return {};
    const sources = await this.campaignAssets(fromId);
    if (sources.length === 0) return {};

    const pathMap: Record<string, string> = {};
    for (const source of sources) {
      const destination = await this.destination(toId, fromBriefId, source);
      record(pathMap, fromBriefId, toBriefId, source.name, destination.name);
      // The target already holds these exact bytes under this name, so there is
      // nothing to copy and nothing to insert — and copying anyway would be an
      // insert the unique index refuses, which is a 500 rather than the no-op
      // the caller asked for. This is what makes a duplicated campaign, or a
      // replace-save over an already-copied asset, idempotent.
      if (destination.reused) continue;
      const assetId = randomUUID();
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
        // this call back — `briefs.post.ts` runs it with no release step. So EITHER
        // half failing has to give the object back, or it sits under the target's
        // prefix with nothing that will ever name it.
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
    return pathMap;
  }

  /**
   * See `AssetStorePort.deleteAssets`.
   *
   * A uuid is used AS the campaign id, with no lookup at all — the shape a
   * caller holding a campaign's id and no row can free. The routes do not use
   * it: they hold a SLUG and pass it, because this class has to resolve that
   * slug into a uuid through the campaign row, and a create rollback frees the
   * assets BEFORE the release that removes the row (PT-4b). The uuid branch is
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
   */
  private async resolveCampaignId(slug: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ id: string }>(
      `select id from campaign where org_id = $1 and slug = $2`,
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
   * fs's decision tree, in fs's order, with "is this candidate taken" answered by
   * a row rather than by `readFile`: the same question with the same answers and
   * no bytes moved. The suffix text is fs's word for word — `<stem>-<from><ext>`,
   * then `-2`, `-3`.
   */
  private async destination(
    toId: string,
    fromBriefId: string,
    source: AssetRow,
  ): Promise<{ readonly name: string; readonly reused: boolean }> {
    const taken = await this.assetRow(toId, source.name);
    if (taken === undefined) return { name: source.name, reused: false };
    if (taken.sha256 === source.sha256) return { name: source.name, reused: true };
    const extension = extname(source.name);
    const stem = basename(source.name, extension);
    const directory = dirname(source.name);
    for (let counter = 1; ; counter++) {
      const base = counter === 1 ? `${stem}-${fromBriefId}` : `${stem}-${fromBriefId}-${counter}`;
      const named = `${base}${extension}`;
      const candidate = directory === "." ? named : `${directory}/${named}`;
      const existing = await this.assetRow(toId, candidate);
      if (existing === undefined) return { name: candidate, reused: false };
      if (existing.sha256 === source.sha256) return { name: candidate, reused: true };
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
 * The two entries fs's `copyAssets` records per source asset: the bare
 * `name → destName` a brief body carries, and the repo-relative
 * `assets/inputs/<from>/<name> → assets/inputs/<to>/<destName>` one carries.
 * Both, always — `rewriteAssetPaths` reads either, so returning one of them is
 * how a copied brief ends up pointing at a file that is not there.
 */
function record(
  pathMap: Record<string, string>,
  fromBriefId: string,
  toBriefId: string,
  name: string,
  destName: string,
): void {
  pathMap[name] = destName;
  pathMap[`assets/inputs/${fromBriefId}/${name}`] = `assets/inputs/${toBriefId}/${destName}`;
}
