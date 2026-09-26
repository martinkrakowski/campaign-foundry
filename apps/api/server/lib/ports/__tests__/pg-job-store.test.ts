import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { PipelineExecutionLog } from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { runEnvironment } from "../../run-environment.js";
import { LOCAL_TENANT, type TenantContext } from "../../tenant.js";
import { getJobStore, resetJobStore } from "../index.js";
import { FsJobStore, JOB_TTL_MS, JobCapacityError, MAX_JOBS } from "../fs-job-store.js";
import { QUEUED_TTL_MS, type JobResult } from "../job-store.port.js";
import { HEARTBEAT_INTERVAL_MS, JobLeaseLostError, LEASE_MS, PgJobStore } from "../pg-job-store.js";

const acme: TenantContext = { ...LOCAL_TENANT, orgId: "acme", userId: "u1" };

const payload = (over: Partial<JobResult> = {}): JobResult => ({
  halted: false,
  assets: [],
  log: new PipelineExecutionLog("camp", () => new Date("2026-01-01T00:00:00.000Z")),
  ...over,
});

/** Insert a job row directly, bypassing the store, so a test can pre-seed a
 * lease in whatever state it needs (running-and-live, running-and-lapsed,
 * settled) without going through `acquireJob` first. */
async function seed(
  db: SqlClient,
  row: {
    id: string;
    orgId: string;
    campaignId: string;
    status?: "running" | "completed" | "failed";
    leaseOffsetMs?: number;
    settled?: boolean;
  },
): Promise<void> {
  await db.query(
    `insert into job (id, org_id, campaign_id, status, lease_expires_at, heartbeat_at, settled_at)
     values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, now(), $6)`,
    [
      row.id,
      row.orgId,
      row.campaignId,
      row.status ?? "running",
      row.leaseOffsetMs ?? LEASE_MS,
      row.settled ? new Date() : null,
    ],
  );
}

describe("PgJobStore (PT-6a, D171)", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
  });
  afterEach(async () => {
    await db.end();
  });

  test("claim acquires on an empty table", async () => {
    const store = new PgJobStore(db, "local");
    const claim = await store.acquireJob("camp");
    expect(claim).toEqual({ acquired: true, jobId: expect.any(String) });
  });

  test("createJob accepts a custom id", async () => {
    const store = new PgJobStore(db, "local");
    const id = await store.createJob("camp", "my-id");
    expect(id).toBe("my-id");
    expect(await store.getJob("my-id")).toEqual({
      status: "running",
      done: 0,
      total: 0,
      log: null,
    });
  });

  test("claim returns the incumbent when running", async () => {
    const store = new PgJobStore(db, "local");
    const first = await store.acquireJob("camp");
    expect(first.acquired).toBe(true);
    const second = await store.acquireJob("camp");
    expect(second).toEqual({
      acquired: false,
      runningJobId: first.acquired ? first.jobId : undefined,
    });
    // createJob follows the same rule.
    expect(await store.createJob("camp")).toBe(first.acquired ? first.jobId : undefined);
  });

  test("claim after the reaper failed a lapsed lease acquires", async () => {
    const store = new PgJobStore(db, "local");
    await seed(db, { id: "lapsed", orgId: "local", campaignId: "camp", leaseOffsetMs: -1_000 });

    const claim = await store.acquireJob("camp");
    expect(claim).toEqual({ acquired: true, jobId: expect.any(String) });
    expect(claim.acquired && claim.jobId).not.toBe("lapsed");

    const { rows } = await db.query<{ status: string; error: string | null }>(
      "select status, error from job where id = $1",
      ["lapsed"],
    );
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(rows[0]!.error).toMatch(/Lease expired/);
  });

  test("a lapsed lease belonging to another org never blocks this org's claim", async () => {
    await seed(db, { id: "other", orgId: "acme", campaignId: "camp", leaseOffsetMs: -1_000 });
    const store = new PgJobStore(db, "local");
    await expect(store.acquireJob("camp")).resolves.toEqual({
      acquired: true,
      jobId: expect.any(String),
    });
    // The other org's lapsed row is untouched: reaping is scoped per store.
    const { rows } = await db.query<{ status: string }>("select status from job where id = $1", [
      "other",
    ]);
    expect(rows[0]).toEqual({ status: "running" });
  });

  test("a retry for a campaign already running adopts the incumbent even at MAX_JOBS, never a capacity error (finding 1)", async () => {
    const store = new PgJobStore(db, "local");
    const first = await store.acquireJob("camp");
    const firstId = first.acquired ? first.jobId : "";
    for (let i = 1; i < MAX_JOBS; i++) await store.acquireJob(`c${i}`);
    // The org is now at MAX_JOBS, every row running. A retry for "camp" must
    // adopt the incumbent, not evict to make room for a row that would only
    // conflict with the one already there and then throw JobCapacityError —
    // that is the bug: the file store returns the incumbent first.
    await expect(store.acquireJob("camp")).resolves.toEqual({
      acquired: false,
      runningJobId: firstId,
    });
  });

  test("acquireJob takes the org's advisory lock inside its own transaction (finding 3)", async () => {
    const store = new PgJobStore(db, "local");
    const seenSql: string[] = [];
    const originalTransaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation((work) =>
      originalTransaction((tx) => {
        const wrapped: typeof tx = {
          ...tx,
          query: (<R>(text: string, params?: readonly unknown[]) => {
            seenSql.push(text);
            return tx.query<R>(text, params);
          }) as typeof tx.query,
        };
        return work(wrapped);
      }),
    );
    try {
      await store.acquireJob("camp");
    } finally {
      spy.mockRestore();
    }
    expect(seenSql.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
  });

  test("the insert's own conflict path still answers the incumbent if it is ever reached (belt-and-braces behind the lock and the pre-check)", async () => {
    // Finding 1 and the finding-3 advisory lock together mean the insert's own
    // ON CONFLICT DO UPDATE path is no longer reachable through acquireJob's
    // normal flow — the pre-check (runningIncumbent) always finds a live
    // incumbent first. That path still exists on purpose (an older client, a
    // future bypass of the pre-check), so it must still answer correctly: force
    // the pre-check to miss, the way an actual bypass would, and prove the
    // insert's own conflict handling still returns the incumbent rather than a
    // duplicate row or a constraint error.
    const store = new PgJobStore(db, "local");
    const first = await store.acquireJob("camp");
    const firstId = first.acquired ? first.jobId : "";
    const spy = vi
      .spyOn(
        store as unknown as {
          runningIncumbent: (...args: unknown[]) => Promise<string | undefined>;
        },
        "runningIncumbent",
      )
      .mockResolvedValueOnce(undefined);
    try {
      await expect(store.acquireJob("camp")).resolves.toEqual({
        acquired: false,
        runningJobId: firstId,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("enqueueJob's own conflict path still answers the incumbent if it is ever reached", async () => {
    // Same belt-and-braces proof as acquireJob's above, for the queued insert's
    // own `on conflict … do update` path (item 2): force the pre-check to miss
    // and confirm the insert's conflict handling still returns the incumbent.
    const store = new PgJobStore(db, "local");
    const first = await store.enqueueJob("camp");
    const firstId = first.acquired ? first.jobId : "";
    const spy = vi
      .spyOn(
        store as unknown as {
          runningIncumbent: (...args: unknown[]) => Promise<string | undefined>;
        },
        "runningIncumbent",
      )
      .mockResolvedValueOnce(undefined);
    try {
      await expect(store.enqueueJob("camp")).resolves.toEqual({
        acquired: false,
        runningJobId: firstId,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("a lapsed running row polls as failed without any claim ever reaping it (finding 5)", async () => {
    const store = new PgJobStore(db, "local");
    await seed(db, { id: "ghost", orgId: "local", campaignId: "camp", leaseOffsetMs: -1_000 });

    expect(await store.getJob("ghost")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Lease expired"),
    });
    expect((await store.listJobs()).find((j) => j.id === "ghost")?.job).toMatchObject({
      status: "failed",
    });
    // Read-time only: nothing wrote the row. The next real claim's reaper is
    // still what settles it for good.
    const row = await db.query<{ status: string }>("select status from job where id = $1", [
      "ghost",
    ]);
    expect(row.rows[0]).toEqual({ status: "running" });
  });

  test("a lapsed queued row polls as failed without any claim ever reaping it", async () => {
    const store = new PgJobStore(db, "local");
    // Direct insert, past QUEUED_TTL_MS, bypassing enqueueJob so no reap() runs.
    await db.query(
      `insert into job (id, org_id, campaign_id, status, created_at)
       values ($1, 'local', 'camp', 'queued', now() - interval '11 minutes')`,
      ["ghost-queued"],
    );

    expect(await store.getJob("ghost-queued")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("expired"),
    });
    expect((await store.listJobs()).find((j) => j.id === "ghost-queued")?.job).toMatchObject({
      status: "failed",
    });
    // Read-time only: nothing wrote the row. The next real claim's reaper is
    // still what settles it for good.
    const row = await db.query<{ status: string }>("select status from job where id = $1", [
      "ghost-queued",
    ]);
    expect(row.rows[0]).toEqual({ status: "queued" });
  });

  test("heartbeat extends the lease", async () => {
    const store = new PgJobStore(db, "local");
    const claim = await store.acquireJob("camp");
    const id = claim.acquired ? claim.jobId : "";
    const before = await db.query<{ t: Date }>(
      "select lease_expires_at as t from job where id = $1",
      [id],
    );
    await store.heartbeat(id);
    const after = await db.query<{ t: Date }>(
      "select lease_expires_at as t from job where id = $1",
      [id],
    );
    expect(after.rows[0]!.t.getTime()).toBeGreaterThan(before.rows[0]!.t.getTime());
  });

  test("heartbeat on a job that no longer holds its lease is a silent no-op", async () => {
    const store = new PgJobStore(db, "local");
    await seed(db, {
      id: "gone",
      orgId: "local",
      campaignId: "camp",
      status: "failed",
      settled: true,
    });
    await expect(store.heartbeat("gone")).resolves.toBeUndefined();
    await expect(store.heartbeat("never-existed")).resolves.toBeUndefined();
  });

  test("progressJob refuses once the row no longer holds the lease", async () => {
    const store = new PgJobStore(db, "local");
    await seed(db, {
      id: "reaped",
      orgId: "local",
      campaignId: "camp",
      status: "failed",
      settled: true,
    });
    await expect(store.progressJob("reaped", 1, 2)).rejects.toBeInstanceOf(JobLeaseLostError);
    await expect(store.progressJob("never-existed", 1, 2)).rejects.toThrow(
      /no longer holds its lease/,
    );
  });

  test("completeJob refuses once the row no longer holds the lease", async () => {
    const store = new PgJobStore(db, "local");
    await seed(db, {
      id: "reaped",
      orgId: "local",
      campaignId: "camp",
      status: "failed",
      settled: true,
    });
    await expect(store.completeJob("reaped", payload())).rejects.toBeInstanceOf(JobLeaseLostError);
  });

  test("failJob refuses once the row no longer holds the lease", async () => {
    const store = new PgJobStore(db, "local");
    await seed(db, {
      id: "done",
      orgId: "local",
      campaignId: "camp",
      status: "completed",
      settled: true,
    });
    await expect(store.failJob("done", "boom")).rejects.toBeInstanceOf(JobLeaseLostError);
  });

  test("a lapsed-but-not-yet-reaped lease refuses heartbeat and every fenced write, not just status = 'running' (finding 2)", async () => {
    const store = new PgJobStore(db, "local");
    await seed(db, { id: "lapsed", orgId: "local", campaignId: "camp", leaseOffsetMs: -1_000 });

    const before = await db.query<{ t: Date }>(
      "select lease_expires_at as t from job where id = $1",
      ["lapsed"],
    );
    // Silent, like any other "no longer holds it" case — but it must not renew.
    await expect(store.heartbeat("lapsed")).resolves.toBeUndefined();
    const after = await db.query<{ t: Date }>(
      "select lease_expires_at as t from job where id = $1",
      ["lapsed"],
    );
    expect(after.rows[0]!.t.getTime()).toBe(before.rows[0]!.t.getTime());

    await expect(store.progressJob("lapsed", 1, 2)).rejects.toBeInstanceOf(JobLeaseLostError);
    await expect(store.completeJob("lapsed", payload())).rejects.toBeInstanceOf(JobLeaseLostError);
    await expect(store.failJob("lapsed", "boom")).rejects.toBeInstanceOf(JobLeaseLostError);

    // Nobody's reaper has run: the row is still 'running' in the database, and
    // the fence caught this on the lease alone.
    const row = await db.query<{ status: string }>("select status from job where id = $1", [
      "lapsed",
    ]);
    expect(row.rows[0]).toEqual({ status: "running" });
  });

  test("progressJob records done/total for a job that still holds its lease", async () => {
    const store = new PgJobStore(db, "local");
    const claim = await store.acquireJob("camp");
    const id = claim.acquired ? claim.jobId : "";
    await store.progressJob(id, 2, 5);
    expect(await store.getJob(id)).toEqual({ status: "running", done: 2, total: 5, log: null });
  });

  test("completeJob records assets.length and the log/result payload", async () => {
    const store = new PgJobStore(db, "local");
    const claim = await store.acquireJob("camp");
    const id = claim.acquired ? claim.jobId : "";
    const log = new PipelineExecutionLog("camp", () => new Date("2026-01-01T00:00:00.000Z"));
    log.record("build", "started", "info");
    const result = payload({ assets: [{}, {}] as unknown as JobResult["assets"], log });
    await store.completeJob(id, result);

    const job = await store.getJob(id);
    expect(job).toMatchObject({ status: "completed", done: 2, total: 2 });
    // A different process boundary than the file store's in-memory cache: the
    // log comes back as the plain data `toJSON` describes, not a live instance.
    // Nothing downstream needs the class — the poll route returns it as JSON.
    expect(job?.log).toMatchObject({
      campaignId: "camp",
      entries: [expect.objectContaining({ stage: "build" })],
    });
    expect(job?.result?.log).toEqual(job?.log);
  });

  test("completeJob uses 0/0 when the run halted", async () => {
    const store = new PgJobStore(db, "local");
    const claim = await store.acquireJob("camp");
    const id = claim.acquired ? claim.jobId : "";
    await store.completeJob(
      id,
      payload({ halted: true, assets: [{}] as unknown as JobResult["assets"] }),
    );
    expect(await store.getJob(id)).toMatchObject({ status: "completed", done: 0, total: 0 });
  });

  test("failJob records the error without a result", async () => {
    const store = new PgJobStore(db, "local");
    const claim = await store.acquireJob("camp");
    const id = claim.acquired ? claim.jobId : "";
    await store.failJob(id, "out of memory");
    expect(await store.getJob(id)).toEqual({
      status: "failed",
      done: 0,
      total: 0,
      log: null,
      error: "out of memory",
    });
  });

  test("getJob and getStoredJob answer undefined for an unknown id", async () => {
    const store = new PgJobStore(db, "local");
    expect(await store.getJob("nope")).toBeUndefined();
    expect(await store.getStoredJob("nope")).toBeUndefined();
  });

  test("hasRunningJob and getRunningJobId track active campaigns", async () => {
    const store = new PgJobStore(db, "local");
    expect(await store.hasRunningJob("camp")).toBe(false);
    expect(await store.getRunningJobId("camp")).toBeUndefined();

    const claim = await store.acquireJob("camp");
    const id = claim.acquired ? claim.jobId : "";
    expect(await store.hasRunningJob("camp")).toBe(true);
    expect(await store.getRunningJobId("camp")).toBe(id);
    expect(await store.hasRunningJob("other")).toBe(false);

    await store.completeJob(id, payload());
    expect(await store.hasRunningJob("camp")).toBe(false);
    expect(await store.getRunningJobId("camp")).toBeUndefined();
  });

  test("getRunningJobId ignores a lapsed row", async () => {
    const store = new PgJobStore(db, "local");
    await db.query(
      `insert into job (id, org_id, campaign_id, status, lease_expires_at)
       values ($1, 'local', 'camp', 'running', now() - interval '10 seconds')`,
      ["lapsed-job-1"],
    );
    expect(await store.getRunningJobId("camp")).toBeUndefined();
  });

  test("deleteJob removes the row; a second delete is a safe no-op", async () => {
    const store = new PgJobStore(db, "local");
    const claim = await store.acquireJob("camp");
    const id = claim.acquired ? claim.jobId : "";
    await store.completeJob(id, payload());
    expect(await store.getJob(id)).toBeDefined();
    await store.deleteJob(id);
    expect(await store.getJob(id)).toBeUndefined();
    await expect(store.deleteJob(id)).resolves.toBeUndefined();
  });

  test("listJobs returns this org's jobs ordered by creation", async () => {
    const store = new PgJobStore(db, "local");
    const first = await store.acquireJob("camp1");
    const second = await store.acquireJob("camp2");
    const list = await store.listJobs();
    expect(list.map((j) => j.id)).toEqual([
      first.acquired ? first.jobId : "",
      second.acquired ? second.jobId : "",
    ]);
  });

  test("a settled job expires after JOB_TTL_MS on READ; a running one does not (finding 4: no acquireJob before the assertion, or evictToFit's purge — not the read filter — is what the test would be measuring)", async () => {
    const store = new PgJobStore(db, "local");
    await seed(db, {
      id: "settled",
      orgId: "local",
      campaignId: "a",
      status: "completed",
      settled: true,
    });
    // Backdate settledAt past the TTL directly (no fake timers against a real clock column).
    await db.query(
      "update job set settled_at = now() - ($1 || ' milliseconds')::interval where id = $2",
      [JOB_TTL_MS + 1, "settled"],
    );
    await seed(db, { id: "running", orgId: "local", campaignId: "b" });

    // No acquireJob call above this line: its own evictToFit would delete the
    // expired row as a side effect, and the assertions below would pass for
    // that reason even if getStoredJob's own TTL `where` clause were broken.
    expect(await store.getJob("settled")).toBeUndefined();
    expect(await store.getStoredJob("settled")).toBeUndefined();
    expect((await store.getJob("running"))?.status).toBe("running");
    expect((await store.listJobs()).map((j) => j.id)).toEqual(["running"]);
  });

  test("the store is capped at MAX_JOBS per org, evicting settled jobs before running ones", async () => {
    const store = new PgJobStore(db, "local");
    const runner1 = await store.acquireJob("runner1");
    const runner1Id = runner1.acquired ? runner1.jobId : "";
    const settled = await store.acquireJob("settled");
    const settledId = settled.acquired ? settled.jobId : "";
    await store.failJob(settledId, "x");
    const kept: string[] = [runner1Id];
    for (let i = 2; i < MAX_JOBS; i++) {
      const c = await store.acquireJob(`c${i}`);
      kept.push(c.acquired ? c.jobId : "");
    }

    const next = await store.acquireJob("next");
    expect(await store.getJob(settledId)).toBeUndefined();
    for (const id of kept) {
      expect((await store.getJob(id))?.status).toBe("running");
    }
    expect((await store.getJob(next.acquired ? next.jobId : ""))?.status).toBe("running");
  });

  test("when every job of an org is still running, the store REFUSES rather than evicting one", async () => {
    const store = new PgJobStore(db, "local");
    const oldest = await store.acquireJob("c0");
    const oldestId = oldest.acquired ? oldest.jobId : "";
    for (let i = 1; i < MAX_JOBS; i++) await store.acquireJob(`c${i}`);
    await expect(store.acquireJob("overflow")).rejects.toThrow(JobCapacityError);
    expect(await store.getJob(oldestId)).toBeDefined();
  });

  test("another org's jobs are invisible, and capacity is counted per org", async () => {
    const local = new PgJobStore(db, "local");
    const acme = new PgJobStore(db, "acme");
    const claim = await local.acquireJob("camp");
    const id = claim.acquired ? claim.jobId : "";

    expect(await acme.getJob(id)).toBeUndefined();
    expect(await acme.hasRunningJob("camp")).toBe(false);
    // The same campaign id is a different lock per org.
    await expect(acme.acquireJob("camp")).resolves.toEqual({
      acquired: true,
      jobId: expect.any(String),
    });
    expect(await local.hasRunningJob("camp")).toBe(true);
  });

  test("clear forgets only this org's jobs", async () => {
    const local = new PgJobStore(db, "local");
    const acme = new PgJobStore(db, "acme");
    const localClaim = await local.acquireJob("camp");
    const acmeClaim = await acme.acquireJob("camp");
    await local.clear();
    expect(await local.getJob(localClaim.acquired ? localClaim.jobId : "")).toBeUndefined();
    expect(await acme.getJob(acmeClaim.acquired ? acmeClaim.jobId : "")).toBeDefined();
  });

  test("withJobLock runs its function directly: the row is the lock, not an in-process chain", async () => {
    const store = new PgJobStore(db, "local");
    const order: number[] = [];
    await store.withJobLock("camp", async () => {
      order.push(1);
    });
    await store.withJobLock("camp", async () => {
      order.push(2);
    });
    expect(order).toEqual([1, 2]);
  });

  test("HEARTBEAT_INTERVAL_MS is comfortably inside LEASE_MS, so a missed beat or two never costs the lease", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(LEASE_MS);
  });

  test("enqueueJob inserts a queued row and reports status as queued in stored job", async () => {
    const store = new PgJobStore(db, "local");
    const res = await store.enqueueJob("camp");
    expect(res.acquired).toBe(true);
    if (!res.acquired) return;
    const stored = await store.getStoredJob(res.jobId);
    expect(stored?.job.status).toBe("queued");
  });

  test("a queued row blocks a second enqueue and returns the incumbent jobId", async () => {
    const store = new PgJobStore(db, "local");
    const first = await store.enqueueJob("camp");
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    const second = await store.enqueueJob("camp");
    expect(second.acquired).toBe(false);
    if (second.acquired) return;
    expect(second.runningJobId).toBe(first.jobId);
  });

  test("a queued row blocks acquireJob and returns the incumbent jobId", async () => {
    const store = new PgJobStore(db, "local");
    const enq = await store.enqueueJob("camp");
    expect(enq.acquired).toBe(true);
    if (!enq.acquired) return;
    const acq = await store.acquireJob("camp");
    expect(acq.acquired).toBe(false);
    if (acq.acquired) return;
    expect(acq.runningJobId).toBe(enq.jobId);
  });

  test("a running row blocks enqueueJob and returns the incumbent jobId", async () => {
    const store = new PgJobStore(db, "local");
    const acq = await store.acquireJob("camp");
    expect(acq.acquired).toBe(true);
    if (!acq.acquired) return;
    const enq = await store.enqueueJob("camp");
    expect(enq.acquired).toBe(false);
    if (enq.acquired) return;
    expect(enq.runningJobId).toBe(acq.jobId);
  });

  test("startQueuedJob transitions a queued row to running and sets lease", async () => {
    const store = new PgJobStore(db, "local");
    const enq = await store.enqueueJob("camp");
    expect(enq.acquired).toBe(true);
    if (!enq.acquired) return;

    const started = await store.startQueuedJob(enq.jobId);
    expect(started).toBe(true);

    const stored = await store.getStoredJob(enq.jobId);
    expect(stored?.job.status).toBe("running");
  });

  test("duplicate delivery: second startQueuedJob returns false and nothing runs twice", async () => {
    const store = new PgJobStore(db, "local");
    const enq = await store.enqueueJob("camp");
    expect(enq.acquired).toBe(true);
    if (!enq.acquired) return;

    const first = await store.startQueuedJob(enq.jobId);
    expect(first).toBe(true);

    // Second call on already running job returns false
    const second = await store.startQueuedJob(enq.jobId);
    expect(second).toBe(false);

    // Call on unknown id returns false
    const unknown = await store.startQueuedJob("00000000-0000-0000-0000-000000000000");
    expect(unknown).toBe(false);
  });

  test("reaper fails a queued row older than QUEUED_TTL_MS", async () => {
    const store = new PgJobStore(db, "local");
    // Insert a queued row created 11 minutes ago (past QUEUED_TTL_MS of 10 min)
    const oldId = "11111111-1111-1111-1111-111111111111";
    await db.query(
      `insert into job (id, org_id, campaign_id, status, created_at, lease_expires_at, heartbeat_at)
       values ($1, 'local', 'camp-old', 'queued', now() - interval '11 minutes', now() + interval '10 minutes', now())`,
      [oldId],
    );

    // Insert a fresh queued row
    const freshId = "22222222-2222-2222-2222-222222222222";
    await db.query(
      `insert into job (id, org_id, campaign_id, status, created_at, lease_expires_at, heartbeat_at)
       values ($1, 'local', 'camp-fresh', 'queued', now(), now() + interval '10 minutes', now())`,
      [freshId],
    );

    // Calling enqueueJob triggers reap()
    expect(QUEUED_TTL_MS).toBe(JOB_TTL_MS);
    await store.enqueueJob("camp-other");

    const oldJob = await store.getStoredJob(oldId);
    expect(oldJob?.job.status).toBe("failed");
    expect(oldJob?.job.error).toMatch(/expired|timed out/i);

    const freshJob = await store.getStoredJob(freshId);
    expect(freshJob?.job.status).toBe("queued");
  });
});

describe("STORE_BACKEND=postgres puts jobs in the database, one lease-backed store per org (PT-6a)", () => {
  const saved = process.env.STORE_BACKEND;
  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
    resetJobStore();
    resetDatabase();
  });

  test("the default is the file store", () => {
    delete process.env.STORE_BACKEND;
    expect(getJobStore(LOCAL_TENANT)).toBeInstanceOf(FsJobStore);
  });

  test("postgres builds a database store per org; a run's scope is its tenant's org", async () => {
    const database = await migratedDatabase();
    setDatabase(database);
    await database.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    process.env.STORE_BACKEND = "postgres";
    const local = getJobStore(LOCAL_TENANT);
    expect(local).toBeInstanceOf(PgJobStore);
    // Cached: the same tenant gets the same store, so heartbeat and the claim
    // share one instance across the life of a request.
    expect(getJobStore(LOCAL_TENANT)).toBe(local);
    expect(getJobStore(acme)).not.toBe(local);
    // A run's captured environment resolves to its tenant's org, not a fresh one.
    expect(getJobStore(runEnvironment(LOCAL_TENANT))).toBe(local);

    const claim = await local.acquireJob("camp");
    expect(claim.acquired).toBe(true);
    expect(await getJobStore(acme).getJob(claim.acquired ? claim.jobId : "")).toBeUndefined();
    await database.end();
  });
});
