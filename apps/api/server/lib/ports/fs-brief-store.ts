import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { isReservedCampaignId, type CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { parse as parseYaml } from "yaml";
import { resolveConfined } from "../confined-path.js";
import { parseBriefText, YAML_ALIAS_CAP, type ParseBriefOptions } from "../load-brief.js";
import {
  TeamsNotSupportedError,
  type BriefStorePort,
  type BriefWriteOptions,
  type CampaignMeta,
  type CreateCampaignOptions,
  type ResolvedCampaign,
  type StoredBrief,
} from "./brief-store.port.js";
import {
  BRIEF_SOURCE_EXTS,
  hashBytes,
  isBriefSourceName,
  isErrno,
  patchBriefYaml,
  serializeBrief,
  SYMLINK_WRITE_ERROR,
} from "../brief-files.js";

/**
 * The name/type meta file `createCampaign` writes inside a campaign's
 * reserved directory (PT-5b3, D168, D177) — a sibling of the versioned
 * `<slug>.yaml`, never touched by a Save, so it answers the same before and
 * after the first version exists.
 */
const CAMPAIGN_META_FILE = "campaign.json";

/**
 * A campaign's autosave drafts (PT-5d), one JSON file per user, inside the
 * same reserved directory `campaign.json` lives in — `FsDraftStore`'s own
 * `DRAFTS_DIR`, duplicated here rather than imported: this file must not
 * depend on the draft store (the reverse dependency, one write path per
 * concern), and the two agreeing is what `releaseCampaign`'s own test proves.
 */
const DRAFTS_DIR = "drafts";

/**
 * D166 item 5: this backend has no team column at all — a non-undefined
 * `teamId` (a team id to assign, or `null` to clear one) is refused outright
 * rather than silently ignored, since silently dropping it would tell the
 * caller their assignment took effect when it did not.
 */
function assertNoTeam(teamId: string | null | undefined): void {
  if (teamId !== undefined) throw new TeamsNotSupportedError();
}

/**
 * The campaign id `raw` DECLARES, read at the DOCUMENT level: the `id` key of
 * the parsed mapping, when that key is a string.
 *
 * Deliberately not `parseBriefText`'s id. `parseBrief` validates SHAPE, so an
 * operator's half-written file — `id: stolen` beside `products: not-an-array`
 * — declares no id through it, and "these bytes declare no id" and "these
 * bytes declare another campaign" came back as the same `undefined`. The write
 * path must not collapse them: it re-derives on the second and patches on the
 * first, so a schema-validated answer let a Save patch one campaign's whole
 * file as another, `id` included, over a root `listBriefs` had skipped.
 *
 * The bytes are put through the same extension dispatch and the same
 * `YAML_ALIAS_CAP` `parseBriefText` uses, so what parses here parses there and
 * an alias bomb is bounded in both places at once.
 *
 * A document that is not a mapping, or whose `id` is not a string, declares no
 * id at all — and a Save still owes THOSE bytes a refusal by name rather than a
 * re-derivation. Re-deriving would answer "no such campaign" for a file that is
 * right there, and `replaceBrief` would turn that refusal into a create over
 * the bytes the caller asked to repair.
 */
function declaredBriefId(filePath: string, raw: string): string | undefined {
  try {
    const data =
      extname(filePath).toLowerCase() === ".json"
        ? JSON.parse(raw)
        : parseYaml(raw, { maxAliasCount: YAML_ALIAS_CAP });
    const id = (data as { id?: unknown } | null | undefined)?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Filesystem implementation of BriefStorePort.
 * Stores briefs under `<projectRoot>/briefs/*.yaml` (or .yml / .json).
 */
export class FsBriefStore implements BriefStorePort {
  /** No team column at all (D166 item 5) — see `BriefStorePort.supportsTeams`. */
  readonly supportsTeams = false;

  /** Resolved once at construction; the composition root decides it (D167). */
  private readonly dir: string;
  private readonly lockChains = new Map<string, Promise<unknown>>();

  /**
   * L1: the id -> file name index, and the reason `findBriefFileById` is no
   * longer a full-directory scan. Measured at a 199-202 ms median over 1,000
   * campaigns (`scripts/bench-fs-id-lookup.ts`, three runs) against the row's
   * 5 ms threshold, on the ids `resolveCampaign` / `campaignVisibility` /
   * `campaignMeta` resolve for the assets, decisions, pools and preview-frame
   * routes.
   *
   * A POSITIVE cache, and deliberately only that:
   * - a hit is validated and then answered from here: one `lstat` on the
   *   cached NAME (`isIndexedFileLive`), never a re-read of the brief;
   * - a miss ALWAYS falls back to a full `listBriefs()` scan
   *   (`rebuildIdIndex`), which republishes the whole map. A miss is never
   *   cached, so this cannot hide a brief that another `FsBriefStore`, another
   *   process or an operator put in this root since the last scan — the first
   *   lookup from a second instance over the same root is exactly that case,
   *   and it finds the campaign.
   *
   * The `lstat` is what makes a long-lived instance honest. `FsBriefStore`
   * outlives any request (the ports `Registry` caches one per scope), and
   * nothing in this file ever unlinks a brief file, so a cached name can
   * outlive the file behind it: an operator's `rm`, a second API process, an
   * editor's own "delete campaign". Answered from the map alone, a stale hit
   * made `resolveCampaign` / `campaignVisibility` / `campaignMeta` report a
   * campaign that is gone, and a stale hit that is now a SYMLINK would be read
   * through it — a fresh scan excludes that name, and the index must not be a
   * way around the listing's regular-file check.
   *
   * Residual, and named: a stat sees the NAME, not what the file declares. A
   * file whose `brief.id` was changed in place out of band is still answered
   * by `findBriefFileById` (a parse per hit is the cost this lane exists to
   * remove). The two lookups that read the file anyway fix that differently,
   * and both have to: `findBriefById` verifies the id it parsed, and
   * `rewriteBrief` verifies the id in the bytes it is about to patch, so a Save
   * cannot rewrite one campaign's file as another.
   *
   * It holds FILE NAMES and nothing else. A `StoredBrief`'s revision must
   * always be hashed from the bytes on disk (`getRevision`, and
   * `rewriteBrief`'s `expectedRevision` check), so caching a revision would
   * turn a conditional write into an unconditional one and quietly retire
   * `ECONFLICT`.
   *
   * A rebuild REPLACES the map rather than mutating it, so publishing one is a
   * single assignment and any map a reader is holding stays whole. Nothing else
   * empties it: a rebuild is the only way entries are dropped, so `clear()`
   * does not appear anywhere in this file. `createBrief` is the one in-place
   * writer, and it only ever records the name a write just created. Each
   * rebuild also RETURNS the map it built so its caller answers from that scan
   * rather than from the field — see `rebuildIdIndex`.
   */
  private idIndex: Map<string, string> = new Map();

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  getBriefsDir(): string {
    return this.dir;
  }

  async listBriefs(): Promise<readonly StoredBrief[]> {
    let files: string[];
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      files = entries
        .filter((e) => e.isFile() && isBriefSourceName(e.name))
        .map((e) => e.name)
        .sort();
    } catch (error) {
      // A missing briefs/ directory is "no campaigns yet". Any other errno
      // (EACCES, EIO, ENOTDIR) is a store read failure the route maps to 500.
      console.warn(`[briefs] could not read ${this.dir}: ${errorMessage(error)}`);
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }

    const briefs: StoredBrief[] = [];
    for (const file of files) {
      const entry = await this.storedBrief(file);
      if (entry) briefs.push(entry);
    }
    return briefs;
  }

  /**
   * One brief file to its `StoredBrief`, or `undefined` when its bytes will
   * not read or parse. Split out of `listBriefs` so `findBriefById` skips a
   * malformed file exactly the way the listing does — letting the parse throw
   * instead would turn a refusal into a failure on the one file it was asked
   * for, which is the outcome `listBriefs`'s own warn-and-skip exists to
   * prevent.
   */
  private async storedBrief(file: string): Promise<StoredBrief | undefined> {
    try {
      // `resolve`, not `resolveConfined`, unchanged from `listBriefs` — but not
      // for the reason it was written. Two callers reach this method and only
      // one of them feeds it a name from this directory's own `readdir`: the
      // other is `findBriefById`, passing whatever the id index holds. Both are
      // confined, differently rather than not at all — an index value is a
      // `readdir` name, or the `${id}.yaml` `createBrief` already put through
      // `resolveConfined` before writing it — so a second narrowing check here
      // would rule out nothing either caller can hand over.
      const filePath = resolve(this.dir, file);
      const bytes = await readFile(filePath);
      const brief = parseBriefText(filePath, bytes.toString("utf8"));
      return { campaignId: brief.id, file, brief, revision: hashBytes(bytes) };
    } catch (error) {
      console.warn(`[briefs] skipped ${file}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Republish the id index from a full `listBriefs()` scan — the miss path,
   * and the only way the map is ever filled in bulk. First file per id wins,
   * which is what `list.find` over the already-sorted listing answered before
   * the index existed: two files declaring one id is a corrupt root, and the
   * answer must not depend on whether the caller arrived warm or cold.
   *
   * It RETURNS the map it built, and callers answer from that rather than from
   * `this.idIndex` after the await. Publishing is an assignment, so a rebuild
   * that scanned an older view of the root can land after one that scanned a
   * newer one; a caller that read the field back would get whichever map won
   * that race instead of the one it waited for, and a decision made from it
   * (`createCampaign`'s taken-check, `releaseCampaign`'s guard) would be made
   * from a scan nobody asked for. Each caller answers from a complete scan it
   * performed itself, and the field is left to be the cache.
   */
  private async rebuildIdIndex(): Promise<ReadonlyMap<string, string>> {
    const listed = await this.listBriefs();
    const next = new Map<string, string>();
    for (const entry of listed) {
      if (!next.has(entry.campaignId)) next.set(entry.campaignId, entry.file);
    }
    this.idIndex = next;
    return next;
  }

  /**
   * The brief behind `id`, and the one lookup in this file that gets to check
   * what the bytes SAY rather than what their name is.
   *
   * The stat in `findBriefFileById` cannot see an id rewritten in place: a file
   * another writer changed from `id: x` to `id: y` still exists, is still a
   * regular file, and keeps answering the cached name — so a request for the
   * OLD id would hand `assertOwnedCampaign` a different campaign under the id
   * the caller asked for. Here the parse has already happened (this method has
   * always read and parsed the file), so the declared id is free to compare, and
   * a disagreement re-derives the mapping from the directory exactly as a miss
   * does: the wrong name goes, and the answer is the file that declares `id`
   * — the replacement if one exists, `undefined` if the id simply moved.
   */
  async findBriefById(id: string): Promise<StoredBrief | undefined> {
    const file = await this.findBriefFileById(id);
    if (file === undefined) return undefined;
    const entry = await this.storedBrief(file);
    if (entry === undefined || entry.campaignId === id) return entry;
    const replacement = (await this.rebuildIdIndex()).get(id);
    return replacement === undefined ? undefined : this.storedBrief(replacement);
  }

  /**
   * True when an indexed file name still names a REGULAR file in this root —
   * the one check `findBriefFileById`'s hit is worth paying for.
   *
   * `lstat`, never `stat`: it does not follow the final component, so a name
   * that has become a symlink reports as `!isFile()` (and is never opened)
   * rather than being read through to a brief outside the briefs root. That is
   * the same rule `listBriefs` applies through `readdir`'s `isFile()`, so a
   * name this accepts is a name a fresh scan would list.
   *
   * `resolveConfined`, for the same reason every other reader in this file uses
   * it: the name is checked for escape before it is stat'd, not after.
   *
   * ENOENT (a brief file removed out of band) and "not a regular file" are the
   * same answer here — the entry is not what it was — so both return false and
   * the caller re-derives. Any OTHER errno (EACCES, EIO, ENOTDIR on the parent)
   * propagates unchanged: a root this store cannot stat is a storage failure,
   * and answering it as "no such campaign" would turn an outage into a 404.
   */
  private async isIndexedFileLive(file: string): Promise<boolean> {
    try {
      const st = await lstat(resolveConfined(this.dir, file));
      return st.isFile();
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  /**
   * See `BriefStorePort.findBriefFileById`. One map read and one `lstat` on a
   * hit; a full directory scan on a miss, never a cached miss — see `idIndex`
   * for why a miss has to keep paying for the answer.
   *
   * A hit whose file is gone (or is no longer a regular file) is NOT a hit: it
   * falls through to the same scan a miss pays for, which drops the entry by
   * replacing the whole map. `createCampaign` and `releaseCampaign` do not
   * consult the cache at all before they DECIDE anything — they scan, and
   * answer from that scan — for what a stat cannot see: a file that no longer
   * declares the id it was indexed under.
   *
   * The name, not the bytes: a cached file whose contents stopped PARSING is
   * still a hit here, while `findBriefById` reports that id absent. Pre-index
   * both said absent. The split is deliberate and is the write path's reason —
   * `rewriteBrief` must keep handing those bytes to `patchBriefYaml`, which
   * refuses them by name (R4.1). Deriving them here instead would answer a
   * corrupt file's id as "no such campaign", and `replaceBrief` would turn
   * that refusal into a create.
   */
  async findBriefFileById(id: string): Promise<string | undefined> {
    const cached = this.idIndex.get(id);
    if (cached !== undefined && (await this.isIndexedFileLive(cached))) return cached;
    return (await this.rebuildIdIndex()).get(id);
  }

  async findBriefFile(
    id: string,
    exts: readonly string[] = BRIEF_SOURCE_EXTS,
  ): Promise<string | undefined> {
    for (const ext of exts) {
      const fileName = `${id}${ext}`;
      try {
        const candidate = resolveConfined(this.dir, fileName);
        const st = await lstat(candidate);
        if (st.isFile()) return fileName;
      } catch {
        // missing at this extension or invalid — try next
      }
    }
    return undefined;
  }

  async readBrief(fileOrKey: string, opts: ParseBriefOptions = {}): Promise<CampaignBrief> {
    const file = (await this.findBriefFileById(fileOrKey)) ?? fileOrKey;
    const filePath = resolveConfined(this.dir, file);
    const raw = await readFile(filePath, "utf8");
    return parseBriefText(filePath, raw, opts);
  }

  async createBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief> {
    assertNoTeam(options?.teamId);
    if (isReservedCampaignId(brief.id)) {
      throw new Error(`"${brief.id}" is reserved; choose another campaign id.`);
    }
    const filePath = resolveConfined(this.dir, `${brief.id}.yaml`);
    try {
      const st = await lstat(filePath);
      if (st.isSymbolicLink()) {
        throw new Error(SYMLINK_WRITE_ERROR);
      }
    } catch (err) {
      if (errorMessage(err) === SYMLINK_WRITE_ERROR) throw err;
    }
    await mkdir(dirname(filePath), { recursive: true });
    const content = serializeBrief(filePath, brief);
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    const revision = hashBytes(Buffer.from(content, "utf8"));
    // Record the mapping this write just created. The index is a positive
    // cache with a scan on every miss, so an id it has never seen would be
    // found by the next scan anyway; recording it here is what makes the read
    // that FOLLOWS a Save a hit instead of a full re-read of the root.
    //
    // Never over an entry that still sorts first (qodo PRRT_kwDOSzP1zc6nOTpw
    // / coderabbit PRRT_kwDOSzP1zc6nOY4b): `a-dup.yaml` and `dup.yaml` may both
    // declare `dup`, and `rebuildIdIndex` answers with the first by name. An
    // unconditional set made a warm store pick `dup.yaml` where a store built
    // one second later picks `a-dup.yaml` — so which file a read or a rewrite
    // targeted would depend on cache state alone.
    //
    // What this does NOT promise is agreement in the other direction. A store
    // whose index is still empty when it makes this write — cold, or over a
    // root it has not scanned — records the canonical name over an on-disk
    // `a-dup.yaml`, and a scan of that same root then answers `a-dup.yaml`.
    // Two files declaring one id is a corrupt root, and there is no cheap way
    // out of it: proving an earlier-sorting file also declares the id means
    // the full scan this lane exists to remove, on the one write that does not
    // need it. Both names are files that really declare the id, so neither
    // answer is a wrong brief — the cost is that a rewrite through one store
    // lands in the file the other did not read. Named rather than papered over.
    const fileName = `${brief.id}.yaml`;
    const indexed = this.idIndex.get(brief.id);
    if (indexed === undefined || fileName < indexed) this.idIndex.set(brief.id, fileName);
    return { campaignId: brief.id, file: fileName, brief, revision };
  }

  /**
   * D177/D179 (PT-5b2): `POST /campaigns`'s blank-create path. A directory,
   * never a file — `<slug>.yaml` is what `createBrief` writes for the first
   * Save, a different filesystem entry that a bare `<slug>/` directory never
   * blocks (no shared inode, no shared parent-of-the-file check). "Taken"
   * (the Dedupe note) is a brief file at any allowed extension OR an
   * already-reserved directory. No lock here — house convention (`createBrief`
   * doesn't lock either): the caller wraps this in `withBriefLock` itself,
   * because a caller that also copies assets and calls `createBrief`
   * afterwards (duplicate, a sourced `POST /campaigns`) needs THAT whole
   * sequence, not just this reservation, to be one critical section — nesting
   * a second `withBriefLock` call on the same slug inside that caller's own
   * would deadlock on this store's per-id chain. `mkdir` with no
   * `{ recursive: true }` is itself an atomic reservation, so even an
   * unlocked call is safe against another unlocked call of the same slug —
   * only the check-then-mkdir sequence needs the caller's lock.
   */
  async createCampaign(slug: string, options?: CreateCampaignOptions): Promise<ResolvedCampaign> {
    assertNoTeam(options?.teamId);
    if (isReservedCampaignId(slug)) {
      throw new Error(`"${slug}" is reserved; choose another campaign id.`);
    }
    // "Taken" is a file NAMED after the slug (`findBriefFile`) OR an existing
    // brief whose `id` IS the slug but lives in a differently named file
    // (`findBriefFileById`, an id-parsed lookup over `listBriefs()` — the
    // same one `campaignVisibility` already relies on). A filename check
    // alone missed that second case (coderabbit PRRT_kwDOSzP1zc6mgBu7 / qodo
    // PRRT_kwDOSzP1zc6mgEyH): the legacy `reserveVisible` check in
    // `duplicate.post.ts` was id-based and never had this gap.
    //
    // The EEXIST decision is made from a SCAN, not from the cache, so this
    // method re-derives what the root holds before it decides. A hit proves
    // the indexed NAME is a live regular file (see `isIndexedFileLive`), not
    // that the file still DECLARES this slug — a brief whose id was rewritten
    // in place out of band would keep its name and lose its claim to the slug,
    // and the refusal it caused would be permanent. Cheap here: one
    // reservation per campaign, on a path that is not a read. Asking for the
    // scan directly rather than clearing the index and going through
    // `findBriefFileById` is the same one scan either way, minus the window in
    // which every other reader on this shared instance misses with it.
    const taken =
      (await this.findBriefFile(slug)) !== undefined ||
      (await this.rebuildIdIndex()).get(slug) !== undefined;
    if (taken) {
      const err = new Error(`Brief "${slug}" already exists.`);
      (err as { code?: string }).code = "EEXIST";
      throw err;
    }
    const dirPath = resolveConfined(this.dir, slug);
    try {
      await mkdir(this.dir, { recursive: true });
      await mkdir(dirPath);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        const err = new Error(`Brief "${slug}" already exists.`);
        (err as { code?: string }).code = "EEXIST";
        throw err;
      }
      throw error;
    }
    // PT-5b3 (D168, D177): the display name and type the user typed at
    // Create, recorded beside the reservation. `wx` matches `createBrief`'s
    // own exclusive-create write — the `mkdir` just above already proved
    // this directory (and so this file within it) didn't exist a moment ago,
    // so nothing else could have raced it into existence.
    //
    // coderabbit PRRT_kwDOSzP1zc6miLda / qodo PRRT_kwDOSzP1zc6miLvn: a failed
    // write (ENOSPC, EACCES) must not leave the `mkdir` above as an orphaned,
    // permanent reservation — the caller never receives a `ResolvedCampaign`
    // to `releaseCampaign`, so nothing else would ever clean it up. Undo only
    // what THIS call created (the meta file, if it landed, then the now-empty
    // directory) and propagate the original error unchanged; both cleanup
    // steps swallow their own failure (e.g. the file never got written) so
    // the caller sees the write's error, not a masking one.
    try {
      await writeFile(
        resolveConfined(dirPath, CAMPAIGN_META_FILE),
        JSON.stringify({ name: options?.name ?? null, type: options?.type ?? null }),
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      await unlink(resolveConfined(dirPath, CAMPAIGN_META_FILE)).catch(() => undefined);
      await rmdir(dirPath).catch(() => undefined);
      throw error;
    }
    return { campaignId: slug, slug };
  }

  /**
   * True when `briefs/<slug>` exists but is not a genuine directory — most
   * concerningly a symlink, which could point outside the briefs root
   * (coderabbit/qodo PRRT_kwDOSzP1zc6miLvl, PRRT_kwDOSzP1zc6miLvm). The same
   * stance `FsPoolStore.isPoolDirSymlink` takes for a pool's own directory.
   * `lstat` never follows the final component, so a symlink reports as
   * `!isDirectory()` here without ever touching its target. ENOENT (never
   * reserved) is absent, not unsafe.
   */
  private async isCampaignDirUnsafe(slug: string): Promise<boolean> {
    let st;
    try {
      st = await lstat(resolveConfined(this.dir, slug));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    return !st.isDirectory();
  }

  /**
   * True when `briefs/<slug>` is a genuine directory — never a symlink,
   * which `lstat`'s own semantics already exclude (it never follows the
   * final component, so a link's own stat is never `isDirectory()`).
   * Absent (ENOENT) answers false, not an error. Used by `campaignMeta`
   * (PT-5c2, qodo PRRT_kwDOSzP1zc6m7irI) to still recognise a reservation
   * made before `campaign.json` existed (pre-PT-5b3).
   */
  private async campaignDirExists(slug: string): Promise<boolean> {
    let st;
    try {
      st = await lstat(resolveConfined(this.dir, slug));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    return st.isDirectory();
  }

  /**
   * `campaign.json`'s own reader (PT-5b3). `undefined` only for ENOENT — a
   * pre-lane reservation (or a versioned brief with no reserved directory at
   * all, the common case for every campaign that existed before this lane)
   * has no meta file to read; any other read/parse failure propagates,
   * fail-closed like the rest of this store. A symlinked `<slug>` directory
   * (PRRT_kwDOSzP1zc6miLvl) is never read through: it answers "no metadata"
   * exactly like ENOENT, the same fail-closed shape `campaignVisibility`
   * already gives a hidden campaign.
   */
  private async readCampaignMeta(
    slug: string,
  ): Promise<{ name: string | null; type: string | null } | undefined> {
    if (await this.isCampaignDirUnsafe(slug)) return undefined;
    let raw: string;
    try {
      raw = await readFile(resolveConfined(this.dir, slug, CAMPAIGN_META_FILE), "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    const parsed = JSON.parse(raw) as { name?: unknown; type?: unknown };
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      type: typeof parsed.type === "string" ? parsed.type : null,
    };
  }

  /**
   * See `BriefStorePort.campaignMeta` (PT-5b3). `ref` IS the slug on this
   * backend (D179): `campaign.json` lives inside the same reserved directory
   * a Save never touches, so name/type answer the same whether or not a
   * version has been saved yet (item 4: Saving never clears them).
   *
   * PT-5c2 fix round (qodo PRRT_kwDOSzP1zc6m7iq6): a saved version already
   * proves the campaign known on its own — `readCampaignMeta`'s own
   * fail-closed stance (a malformed `campaign.json` propagates, per its own
   * doc comment) stays exactly that strict when meta is the ONLY signal
   * (`hasVersion` false), but must not turn into a 500 that blocks
   * generate/plan/preview/save for a campaign this store can already prove
   * exists a different way. `name`/`type` degrade to null in that case,
   * same as a campaign that never had a meta file at all.
   *
   * PT-5c2 fix round (qodo PRRT_kwDOSzP1zc6m7irI): neither a saved version
   * nor a readable `campaign.json` still answers known when a genuine
   * (non-symlink) `briefs/<ref>/` directory exists — a reservation made
   * before `campaign.json` existed (pre-PT-5b3). Absent all three →
   * undefined (an unknown ref, 404 at the route).
   */
  async campaignMeta(ref: string): Promise<CampaignMeta | undefined> {
    const hasVersion = Boolean(await this.findBriefFileById(ref));
    let meta: { name: string | null; type: string | null } | undefined;
    try {
      meta = await this.readCampaignMeta(ref);
    } catch (error) {
      if (!hasVersion) throw error;
      meta = undefined;
    }
    if (meta) {
      return { campaignId: ref, slug: ref, name: meta.name, type: meta.type, hasVersion };
    }
    if (hasVersion) {
      return { campaignId: ref, slug: ref, name: null, type: null, hasVersion: true };
    }
    if (await this.campaignDirExists(ref)) {
      return { campaignId: ref, slug: ref, name: null, type: null, hasVersion: false };
    }
    return undefined;
  }

  /**
   * See `BriefStorePort.releaseCampaign` (PT-5b2 fix-round item 2; PT-5b3).
   * "Holds no brief file" is `findBriefFileById`, the same id-parsed lookup
   * `createCampaign` itself checks. "Nothing else is there" is now checked by
   * `readdir` BEFORE anything is deleted: `campaign.json` (PT-5b3's own meta
   * file) is part of the reservation and is removed with the directory, but
   * any other entry (a leftover `pools.json`) still refuses the whole
   * release, unchanged — reading first means a stray file is discovered
   * before `campaign.json` is gone, never after. The ENOENT/ENOTEMPTY
   * fallback the old unconditional `rmdir` needed lives in this `readdir`
   * check now (a slug never reserved, or one with something else in it), so
   * `rmdir` itself runs only once both are already ruled out — its own
   * failure (e.g. EACCES on the parent) propagates unchanged. A symlinked
   * `<slug>` directory (PRRT_kwDOSzP1zc6miLvm) is refused BEFORE any
   * `readdir`/`unlink` — enumerating or deleting through it could touch a
   * file outside the briefs root — so `isCampaignDirUnsafe` runs first, and
   * a caller sees the same `false` a leftover-pool-file refusal gives, never
   * a distinguishing error.
   *
   * PT-5d: `drafts/` (every user's autosave for this campaign) is now part of
   * the reservation too, same as `campaign.json` — a failed blank create
   * (item 3's own test) must release its draft along with everything else, or
   * the caller's own autosave orphans a directory this method reports as
   * fully released. A symlinked `drafts/` is refused exactly like a
   * symlinked `<slug>` itself: checked before any entry inside it is
   * touched, so a release can never be tricked into deleting through it.
   */
  async releaseCampaign(slug: string): Promise<boolean> {
    // The one method whose first act is a DECISION about what this root holds,
    // so it re-derives that rather than deciding from a claim the index has not
    // re-checked. The failure this prevents is a leak rather than a wrong
    // answer: a brief file removed outside this store (another process, an
    // operator's `rm` — nothing in this file ever unlinks one) or one whose id
    // was rewritten in place leaves an entry the hit's own `lstat` either
    // cannot see past or cannot disprove, that entry makes the guard below
    // report "holds a brief file", and the reservation is refused FOREVER,
    // because no other method invalidates it. Once per failed create, never on
    // a read. The scan is asked for directly, so the answer comes from the
    // scan this call made rather than from the shared field it republishes.
    if ((await this.rebuildIdIndex()).get(slug)) return false;
    if (await this.isCampaignDirUnsafe(slug)) return false;
    const dirPath = resolveConfined(this.dir, slug);
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    if (entries.some((entry) => entry !== CAMPAIGN_META_FILE && entry !== DRAFTS_DIR)) {
      return false;
    }
    let draftsPath: string | undefined;
    if (entries.includes(DRAFTS_DIR)) {
      draftsPath = resolveConfined(dirPath, DRAFTS_DIR);
      const draftsStat = await lstat(draftsPath);
      if (!draftsStat.isDirectory()) return false;
    }
    if (draftsPath) {
      const draftFiles = await readdir(draftsPath);
      for (const file of draftFiles) {
        await unlink(resolveConfined(draftsPath, file));
      }
      await rmdir(draftsPath);
    }
    if (entries.includes(CAMPAIGN_META_FILE)) {
      await unlink(resolveConfined(dirPath, CAMPAIGN_META_FILE));
    }
    await rmdir(dirPath);
    return true;
  }

  /**
   * One brief file, with the bytes a write about it needs and the id those
   * bytes declare — the comparison `findBriefFileById`'s `lstat` cannot make
   * for the caller, taken here because the write needs the bytes regardless.
   */
  private async readWritableTarget(file: string): Promise<{
    file: string;
    filePath: string;
    raw: Buffer;
    declaredId: string | undefined;
  }> {
    const filePath = resolveConfined(this.dir, file);
    const raw = await readFile(filePath);
    return { file, filePath, raw, declaredId: declaredBriefId(filePath, raw.toString("utf8")) };
  }

  /**
   * Non-destructive writer for Save and `POST ?replace=1` (R4.1): read the
   * existing bytes, patch the changed paths in place as a YAML Document, and
   * atomically replace the file via a temp rename. Comments, blank lines, key
   * order and quoting the operator wrote survive; an unparseable file refuses
   * the write (fail closed) rather than falling back to a whole-object dump.
   */
  async rewriteBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief> {
    assertNoTeam(options?.teamId);
    const file = await this.findBriefFileById(brief.id);
    let target = file === undefined ? undefined : await this.readWritableTarget(file);
    if (target !== undefined && target.declaredId !== undefined && target.declaredId !== brief.id) {
      // A hit the hit's own `lstat` cannot disprove, and the one place it can
      // still do damage rather than merely answer wrongly: the file is still
      // there, still a regular file, and no longer declares the id it was
      // indexed under. `findBriefById` already refuses to serve that pair, but
      // the write below patches the WHOLE target — `id` included — so a Save
      // for the old id would rewrite another campaign's file as this one. The
      // bytes are in hand for the write anyway, so the declared id is free to
      // compare, and a disagreement re-derives exactly as `findBriefById` does:
      // the file that declares the id, or ENOENT when none of them does.
      await this.rebuildIdIndex();
      const replacement = this.idIndex.get(brief.id);
      target = replacement === undefined ? undefined : await this.readWritableTarget(replacement);
    }
    if (target === undefined) {
      // Check if there is an inode (e.g. symlink) at canonical path
      const candidate = resolveConfined(this.dir, `${brief.id}.yaml`);
      try {
        const st = await lstat(candidate);
        if (st.isSymbolicLink()) {
          throw new Error(SYMLINK_WRITE_ERROR);
        }
      } catch (err) {
        if (errorMessage(err) === SYMLINK_WRITE_ERROR) throw err;
      }
      const err = new Error(`Brief "${brief.id}" not found.`);
      (err as { code?: string }).code = "ENOENT";
      throw err;
    }
    const filePath = target.filePath;
    const raw = target.raw;
    if (options?.expectedRevision) {
      const currentRev = hashBytes(raw);
      if (currentRev !== options.expectedRevision) {
        const conflictErr = new Error("Brief was modified by another user.");
        (conflictErr as { code?: string; revision?: string }).code = "ECONFLICT";
        (conflictErr as { revision?: string }).revision = currentRev;
        throw conflictErr;
      }
    }
    let content: string;
    if (extname(filePath).toLowerCase() === ".json") {
      // R4.2 — named carve-out, deliberate: a `.json` brief keeps JSON. A YAML
      // Document patch here would write YAML into a `.json` file and hide the
      // brief on the next load. Never Document-patched, never fail-closed for
      // "not a YAML Document".
      content = serializeBrief(filePath, brief);
    } else {
      content = patchBriefYaml(filePath, raw.toString("utf8"), brief);
    }
    // Atomic replace: write a sibling temp file, then rename over the target, so
    // a failure mid-write leaves the operator's original bytes untouched. The temp
    // name is per-process and random (as the pool store's is) because a fixed one
    // is shared by every overlapping writer: the first rename takes it and the
    // second writer's rename fails, so what makes the write atomic would be the
    // caller's lock rather than the rename.
    const tmpPath = `${filePath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmpPath, content, "utf8");
      await rename(tmpPath, filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
    const revision = hashBytes(Buffer.from(content, "utf8"));
    // Nothing is invalidated, and nothing needs to be recorded: the rename
    // above replaces the brief's own bytes through a temp file and keeps the
    // name, so the mapping this write resolved is still the mapping on disk —
    // including on the redirect above, where `rebuildIdIndex` has already
    // published the name that was patched. Re-asserting it here would be the
    // line's only job in a normal rewrite, and re-asserting the INDEXED name
    // after a redirect would put the stale one straight back. A `clear()` is
    // what must never appear: it would send the read after every autosave PUT
    // back to a full scan of the root, and the lane would have made the
    // editor's own hot path into the thing it set out to measure. The revision
    // is deliberately not recorded either — it is hashed from the bytes above,
    // never from the index, so `expectedRevision` still compares live data.
    return { campaignId: brief.id, file: basename(filePath), brief, revision };
  }

  async replaceBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief> {
    assertNoTeam(options?.teamId);
    // No index call of its own, and none is owed: this method's only two
    // successful outcomes are `rewriteBrief`'s and `createBrief`'s below, and
    // each of those re-asserts the mapping it wrote. Every other path here
    // propagates without a write — the symlink refusal, `rewriteBrief`'s
    // ECONFLICT, a `createBrief` EEXIST — so on those the mapping this method
    // read is still the mapping on disk.
    const file = await this.findBriefFileById(brief.id);
    const candidate = resolveConfined(this.dir, file ?? `${brief.id}.yaml`);
    try {
      const st = await lstat(candidate);
      if (st.isSymbolicLink()) {
        throw new Error(SYMLINK_WRITE_ERROR);
      }
    } catch (err) {
      if (errorMessage(err) === SYMLINK_WRITE_ERROR) throw err;
    }
    try {
      return await this.rewriteBrief(brief, options);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return await this.createBrief(brief, options);
      }
      throw error;
    }
  }

  /** Never "hidden": the filesystem store has no team column (D166 item 5). */
  async campaignVisibility(id: string): Promise<"absent" | "visible"> {
    return (await this.findBriefFileById(id)) ? "visible" : "absent";
  }

  /** See `BriefStorePort.campaignTeam` (PT-5b2 fix-round item 1): no team column (D166 item 5). */
  async campaignTeam(slug: string): Promise<string | null | undefined> {
    return (await this.findBriefFileById(slug)) ? null : undefined;
  }

  /**
   * On the filesystem backend, a campaign's id is its slug (D179).
   * Answers { campaignId: ref, slug: ref } if the brief exists, else undefined.
   */
  async resolveCampaign(ref: string): Promise<ResolvedCampaign | undefined> {
    const file = await this.findBriefFileById(ref);
    if (!file) return undefined;
    return { campaignId: ref, slug: ref };
  }

  async getRevision(fileOrId: string): Promise<string | undefined> {
    try {
      const file = (await this.findBriefFileById(fileOrId)) ?? fileOrId;
      const filePath = resolveConfined(this.dir, file);
      const bytes = await readFile(filePath);
      return hashBytes(bytes);
    } catch {
      return undefined;
    }
  }

  async exists(fileOrId: string): Promise<boolean> {
    try {
      const file = (await this.findBriefFileById(fileOrId)) ?? fileOrId;
      const filePath = resolveConfined(this.dir, file);
      await lstat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  withBriefLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lockChains.get(briefId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.lockChains.set(briefId, settled);
    void settled.then(() => {
      if (this.lockChains.get(briefId) === settled) this.lockChains.delete(briefId);
    });
    return run;
  }
}
