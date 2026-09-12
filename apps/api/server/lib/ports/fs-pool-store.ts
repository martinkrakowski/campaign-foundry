import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage, projectRoot } from "@campaignfoundry/shared";
import { hashBytes, isErrno, SYMLINK_WRITE_ERROR } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import { copyPoolProblem, InvalidCopyPoolError, type PoolStorePort, type StoredPool } from "./pool-store.port.js";

/**
 * Filesystem implementation of PoolStorePort.
 * Stores each brief's copy pool under `<projectRoot>/briefs/<briefId>/pools.json`
 * — a directory beside the brief file, invisible to the briefs lister.
 */
export class FsPoolStore implements PoolStorePort {
  private readonly customDir?: string;
  private readonly lockChains = new Map<string, Promise<unknown>>();

  constructor(dir?: string) {
    if (dir) this.customDir = resolve(dir);
  }

  private get dir(): string {
    return this.customDir ?? resolve(projectRoot(), "briefs");
  }

  /** Confined path `briefs/<briefId>/pools.json` — a directory, invisible to the briefs lister. */
  poolPath(briefId: string): string {
    return resolveConfined(this.dir, briefId, "pools.json");
  }

  /** True when `briefs/<briefId>` exists and is a symlink — writes through it are refused. */
  async isPoolDirSymlink(briefId: string): Promise<boolean> {
    try {
      return (await lstat(dirname(this.poolPath(briefId)))).isSymbolicLink();
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  /** The digest of the bytes stored at `path`; undefined when nothing is stored. */
  private async revisionAt(path: string): Promise<string | undefined> {
    try {
      return hashBytes(await readFile(path));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async readPool(briefId: string): Promise<StoredPool | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.poolPath(briefId), "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InvalidCopyPoolError(briefId, `not JSON (${errorMessage(error)})`);
    }
    const problem = copyPoolProblem(parsed);
    if (problem !== undefined) throw new InvalidCopyPoolError(briefId, problem);
    const pool = parsed as CopyPool;
    if (pool.briefId !== briefId) {
      throw new InvalidCopyPoolError(
        briefId,
        `briefId "${pool.briefId}" does not match storage key "${briefId}"`,
      );
    }
    return { pool, revision: hashBytes(Buffer.from(raw, "utf8")) };
  }

  /**
   * Atomic write: unique temp sibling then rename, so a crash never leaves
   * half-written JSON and two overlapping writers never share a temp file.
   *
   * `expectedRevision` guards the write: the stored bytes are hashed and
   * compared first, and a mismatch throws `ECONFLICT` carrying the fresh
   * revision, so a read→merge→write whose read has gone stale cannot silently
   * overwrite someone else's edit.
   */
  async writePool(pool: CopyPool, options?: { expectedRevision?: string }): Promise<StoredPool> {
    const dest = this.poolPath(pool.briefId);
    if (options?.expectedRevision !== undefined) {
      const current = await this.revisionAt(dest);
      if (current !== options.expectedRevision) {
        const conflictErr = new Error("Copy pool was modified by another user.");
        (conflictErr as { code?: string }).code = "ECONFLICT";
        (conflictErr as { revision?: string }).revision = current;
        throw conflictErr;
      }
    }
    const content = `${JSON.stringify(pool, null, 2)}\n`;
    const tmp = `${dest}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(tmp, content, "utf8");
      await rename(tmp, dest);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    return { pool, revision: hashBytes(Buffer.from(content, "utf8")) };
  }

  async copyPool(fromBriefId: string, toBriefId: string): Promise<CopyPool | undefined> {
    if (await this.isPoolDirSymlink(toBriefId)) {
      throw new Error(SYMLINK_WRITE_ERROR);
    }
    const stored = await this.readPool(fromBriefId);
    if (!stored) return undefined;
    // The stored pool names the brief it belongs to; a byte copy would hand the
    // new brief a pool that still names the old one (C9/D71).
    const copied = { ...stored.pool, briefId: toBriefId };
    await this.writePool(copied);
    return copied;
  }

  async deletePool(briefId: string): Promise<void> {
    try {
      await unlink(this.poolPath(briefId));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }

  withPoolLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
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
