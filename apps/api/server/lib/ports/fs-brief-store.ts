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
import { resolveConfined } from "../confined-path.js";
import { parseBriefText, type ParseBriefOptions } from "../load-brief.js";
import {
  TeamsNotSupportedError,
  type BriefStorePort,
  type BriefWriteOptions,
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
 * D166 item 5: this backend has no team column at all — a non-undefined
 * `teamId` (a team id to assign, or `null` to clear one) is refused outright
 * rather than silently ignored, since silently dropping it would tell the
 * caller their assignment took effect when it did not.
 */
function assertNoTeam(teamId: string | null | undefined): void {
  if (teamId !== undefined) throw new TeamsNotSupportedError();
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
      try {
        const filePath = resolve(this.dir, file);
        const bytes = await readFile(filePath);
        const revision = hashBytes(bytes);
        const brief = parseBriefText(filePath, bytes.toString("utf8"));
        briefs.push({ campaignId: brief.id, file, brief, revision });
      } catch (error) {
        console.warn(`[briefs] skipped ${file}: ${errorMessage(error)}`);
      }
    }
    return briefs;
  }

  async findBriefById(id: string): Promise<StoredBrief | undefined> {
    const list = await this.listBriefs();
    return list.find((entry) => entry.brief.id === id);
  }

  async findBriefFileById(id: string): Promise<string | undefined> {
    const found = await this.findBriefById(id);
    return found?.file;
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
    return { campaignId: brief.id, file: `${brief.id}.yaml`, brief, revision };
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
    if ((await this.findBriefFile(slug)) || (await this.findBriefFileById(slug))) {
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
    return { campaignId: slug, slug };
  }

  /**
   * See `BriefStorePort.releaseCampaign` (PT-5b2 fix-round item 2). "Holds no
   * brief file" is `findBriefFileById`, the same id-parsed lookup
   * `createCampaign` itself now checks; "nothing else" is `rmdir` (never
   * recursive) refusing a non-empty directory outright — the caller deletes
   * the campaign's pool (its own file inside this same directory) first, so
   * a leftover `pools.json` alone never blocks the release.
   */
  async releaseCampaign(slug: string): Promise<boolean> {
    if (await this.findBriefFileById(slug)) return false;
    try {
      await rmdir(resolveConfined(this.dir, slug));
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTEMPTY")) return false;
      throw error;
    }
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
    if (!file) {
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
    const filePath = resolveConfined(this.dir, file);
    const raw = await readFile(filePath);
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
    return { campaignId: brief.id, file: basename(filePath), brief, revision };
  }

  async replaceBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief> {
    assertNoTeam(options?.teamId);
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
