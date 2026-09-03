import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage, projectRoot } from "@campaignfoundry/shared";
import { isErrno, SYMLINK_WRITE_ERROR } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import { copyPoolProblem, InvalidCopyPoolError, type PoolStorePort } from "./pool-store.port.js";

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

  async readPool(briefId: string): Promise<CopyPool | undefined> {
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
    return pool;
  }

  /**
   * Atomic write: unique temp sibling then rename, so a crash never leaves
   * half-written JSON and two overlapping writers never share a temp file.
   */
  async writePool(pool: CopyPool): Promise<void> {
    const dest = this.poolPath(pool.briefId);
    const tmp = `${dest}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(pool, null, 2)}\n`, "utf8");
      await rename(tmp, dest);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  async copyPool(fromBriefId: string, toBriefId: string): Promise<CopyPool | undefined> {
    if (await this.isPoolDirSymlink(toBriefId)) {
      throw new Error(SYMLINK_WRITE_ERROR);
    }
    const pool = await this.readPool(fromBriefId);
    if (!pool) return undefined;
    // The stored pool names the brief it belongs to; a byte copy would hand the
    // new brief a pool that still names the old one (C9/D71).
    const copied = { ...pool, briefId: toBriefId };
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
