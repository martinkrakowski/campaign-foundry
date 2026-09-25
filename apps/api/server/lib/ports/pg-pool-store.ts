import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { hashBytes } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import {
  copyPoolProblem,
  InvalidCopyPoolError,
  type PoolStorePort,
  type StoredPool,
} from "./pool-store.port.js";

/**
 * Validate a campaign id the same way `FsPoolStore.poolPath` does: the same
 * `resolveConfined` call, its resolved path discarded. Postgres has no
 * directory to escape, but a traversing id (`"../evil"`) is refused with the
 * same message either store throws, rather than being silently accepted here
 * and rejected there.
 */
function assertSafeCampaignId(campaignId: string): void {
  resolveConfined("/pools", campaignId, "pools.json");
}

/** The exact bytes `FsPoolStore.writePool` writes (`fs-pool-store.ts:105`). */
function poolBody(pool: CopyPool): string {
  return `${JSON.stringify(pool, null, 2)}\n`;
}

/**
 * The revision of a pool document: the SHA-256 of the bytes it is stored as
 * (`fs-pool-store.ts:115`), so the same pool has the same revision in either
 * store and a PT-8 import keeps it.
 */
function revisionOf(body: string): string {
  return hashBytes(Buffer.from(body, "utf8"));
}

/** A write whose expected revision no longer matches — the same shape `FsPoolStore.writePool` throws. */
function conflictError(revision: string | undefined): Error {
  const err = new Error("Headline pool was modified by another user.");
  (err as { code?: string }).code = "ECONFLICT";
  (err as { revision?: string }).revision = revision;
  return err;
}

/**
 * Copy pools as rows (PT-3e, D169), one org's: the store is built for an org,
 * so every statement is scoped to it and another org's pools are invisible.
 */
export class PgPoolStore implements PoolStorePort {
  private readonly lockChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  /** Postgres has no `briefs/<id>` directory, so it is never a symlink. */
  isPoolDirSymlink(_campaignId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  async readPool(campaignId: string): Promise<StoredPool | undefined> {
    assertSafeCampaignId(campaignId);
    const { rows } = await this.db.query<{ body: string; revision: string }>(
      "select body, revision from pool where org_id = $1 and campaign_id = $2",
      [this.orgId, campaignId],
    );
    const row = rows[0];
    if (!row) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.body);
    } catch (error) {
      throw new InvalidCopyPoolError(campaignId, `not JSON (${errorMessage(error)})`);
    }
    const problem = copyPoolProblem(parsed);
    if (problem !== undefined) throw new InvalidCopyPoolError(campaignId, problem);
    const pool = parsed as CopyPool;
    if (pool.briefId !== campaignId) {
      throw new InvalidCopyPoolError(
        campaignId,
        `briefId "${pool.briefId}" does not match storage key "${campaignId}"`,
      );
    }
    return { pool, revision: row.revision };
  }

  async writePool(pool: CopyPool, options?: { expectedRevision?: string }): Promise<StoredPool> {
    assertSafeCampaignId(pool.briefId);
    const body = poolBody(pool);
    const revision = revisionOf(body);
    await this.db.transaction((tx) =>
      this.claim(tx, pool.briefId, body, revision, options?.expectedRevision),
    );
    return { pool, revision };
  }

  /**
   * Write the row, guarded by `expected` when given: the update's row lock (or
   * the insert's unique key, when no row exists yet) makes the compare and the
   * swap one step, so of two writes from the same read, in any processes, the
   * second finds the revision moved and throws.
   */
  private async claim(
    tx: SqlQuery,
    campaignId: string,
    body: string,
    revision: string,
    expected: string | undefined,
  ): Promise<void> {
    if (expected === undefined) {
      await tx.query(
        `insert into pool (org_id, campaign_id, body, revision, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (org_id, campaign_id)
           do update set body = excluded.body, revision = excluded.revision, updated_at = now()`,
        [this.orgId, campaignId, body, revision],
      );
      return;
    }
    const claimed = await tx.query(
      `update pool set body = $3, revision = $4, updated_at = now()
       where org_id = $1 and campaign_id = $2 and revision = $5
       returning 1`,
      [this.orgId, campaignId, body, revision, expected],
    );
    if (claimed.rows.length === 0) {
      const current = await tx.query<{ revision: string }>(
        "select revision from pool where org_id = $1 and campaign_id = $2",
        [this.orgId, campaignId],
      );
      throw conflictError(current.rows[0]?.revision);
    }
  }

  async copyPool(fromCampaignId: string, toCampaignId: string): Promise<CopyPool | undefined> {
    // Validated before the read, the same order `FsPoolStore.copyPool` checks
    // `isPoolDirSymlink(toBriefId)` in: an unsafe destination is refused even
    // when the source has no pool to copy.
    assertSafeCampaignId(toCampaignId);
    const stored = await this.readPool(fromCampaignId);
    if (!stored) return undefined;
    // The stored pool names the campaign it belongs to; a byte copy would hand
    // the destination a pool that still names the source (C9/D71).
    const copied = { ...stored.pool, briefId: toCampaignId };
    await this.writePool(copied);
    return copied;
  }

  async deletePool(campaignId: string): Promise<void> {
    assertSafeCampaignId(campaignId);
    await this.db.query("delete from pool where org_id = $1 and campaign_id = $2", [
      this.orgId,
      campaignId,
    ]);
  }

  /**
   * Serialise read→merge→write sections per campaign within this process, the
   * same in-process chain `FsPoolStore.withPoolLock` keeps: cross-process
   * safety is `writePool`'s compare-and-swap, not this lock (D79).
   */
  withPoolLock<T>(campaignId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lockChains.get(campaignId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.lockChains.set(campaignId, settled);
    void settled.then(() => {
      if (this.lockChains.get(campaignId) === settled) this.lockChains.delete(campaignId);
    });
    return run;
  }
}
