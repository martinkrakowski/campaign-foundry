import { describe, test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE, connect, main, sweep, MAX_CLAIMS_PER_SWEEP } from "../purge.js";
import { emptyDatabase } from "../../server/lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../server/lib/db/sql-client.js";
import type { DeletionRow } from "../../server/lib/deletion/deletion-store.js";
import { claimDue, listDue, recordFailure } from "../../server/lib/deletion/deletion-store.js";
import { purgeCampaign } from "../../server/lib/deletion/purge-campaign.js";

/** No test below inspects the database: `claim`/`purge` are injected stubs and
 *  `recordFailure`/`claimDue`/`purgeCampaign` are module-level mocks, so a
 *  structurally-complete `SqlClient` double is enough — mirroring `db.test.ts`
 *  passing a PGlite instance only to `connect`, never to `sweep`. */
function stubDb(): SqlClient {
  return {
    query: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as SqlClient;
}

function deletionRow(
  id: string,
  kind: DeletionRow["kind"] = "campaign",
  orgId: string | null = "acme",
  subject = "subject",
): DeletionRow {
  return {
    id,
    orgId,
    kind,
    subject,
    requestedBy: "u1",
    notBefore: Date.now() - 1_000,
    attempts: 0,
  };
}

// Mocked collaborators: `sweep` calls `recordFailure` directly (imported), and
// `main` falls back to the imported `claimDue`/`purgeCampaign`/`listDue` when no
// `claim`/`purge` is injected — so a `main`-level test reaches the real names
// only through these mocks. A direct `sweep(db, log, claim, purge)` call still
// passes its own stubs.
vi.mock("../../server/lib/deletion/deletion-store.js", () => ({
  claimDue: vi.fn(),
  listDue: vi.fn(),
  recordFailure: vi.fn(),
}));
vi.mock("../../server/lib/deletion/purge-campaign.js", () => ({ purgeCampaign: vi.fn() }));

describe("purge CLI (PT-9g3, D231)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("connect", () => {
    const saved = { url: process.env.DATABASE_URL, ca: process.env.DATABASE_CA_PATH };
    let dir: string | undefined;
    afterEach(() => {
      for (const [key, value] of [
        ["DATABASE_URL", saved.url],
        ["DATABASE_CA_PATH", saved.ca],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    // A wider timeout than db.test.ts carries: under PGlite (no TEST_PG_URL) the
    // first `emptyDatabase()` pays PGlite's WASM-init cost, which is ~5 s on a
    // host without AVX2 — enough to trip vitest's 5 s default here while staying
    // well within the real-PG budget (line 302). The test logic is unchanged.
    test("builds a one-connection client from the environment, verifying against the CA file it reads", async () => {
      dir = mkdtempSync(join(tmpdir(), "cf-ca-"));
      writeFileSync(join(dir, "ca.pem"), "PEM");
      process.env.DATABASE_URL = "postgres://me@db.example.com:5432/cf";
      process.env.DATABASE_CA_PATH = join(dir, "ca.pem");
      const db = await emptyDatabase();
      const build = vi.fn(() => db);
      await connect(build).end();
      expect(build).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "db.example.com",
          max: 1,
          ssl: { ca: "PEM", rejectUnauthorized: true },
        }),
      );
      await connect().end(); // the default builder: a real pool, never connected
    }, 20_000);

    test("a CA file that cannot be read is refused", () => {
      dir = mkdtempSync(join(tmpdir(), "cf-ca-"));
      process.env.DATABASE_URL = "postgres://me@db.example.com:5432/cf";
      process.env.DATABASE_CA_PATH = join(dir, "missing.pem");
      expect(() => connect()).toThrow(/ENOENT/);
    });

    test("refuses a remote database with no CA before opening anything", () => {
      process.env.DATABASE_URL = "postgres://me@db.example.com:5432/cf";
      process.env.DATABASE_CA_PATH = "";
      expect(() => connect()).toThrow(/DATABASE_CA_PATH is not set/);
    });
  });

  test("sweep purges and counts across a mix of outcomes", async () => {
    const db = stubDb();
    const lines: string[] = [];
    // One row per outcome the loop knows how to branch on: "purged" (counts),
    // "retry" (neither, and `recordFailure` must NOT be called for it — see
    // `purgeCampaign`'s own contract), and a thrown Error (counts as failed).
    const claim = vi
      .fn()
      .mockResolvedValueOnce(deletionRow("r1"))
      .mockResolvedValueOnce(deletionRow("r2"))
      .mockResolvedValueOnce(deletionRow("r3"))
      .mockResolvedValueOnce(undefined);
    const purge = vi
      .fn()
      .mockResolvedValueOnce("purged")
      .mockResolvedValueOnce("retry")
      .mockRejectedValueOnce(new Error("boom"));

    const { purged, failed } = await sweep(db, (line) => lines.push(line), claim, purge);

    // The witness for the manifest mutation (drop the `purged` guard): every
    // row would count, so `purged` would be 2 instead of 1.
    expect(purged).toBe(1);
    expect(failed).toBe(1);
    expect(purge).toHaveBeenCalledTimes(3);
    // Exactly the thrown row, and NOT the "retry" row — purgeCampaign records
    // its own failure for that outcome, so sweep must not double-record it.
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(db, "r3", "boom");
    expect(recordFailure).not.toHaveBeenCalledWith(db, "r2", expect.anything());
    // One line per claimed row, pinned in full so a swapped id/outcome is caught.
    expect(lines).toEqual([
      `  campaign r1: purged`,
      `  campaign r2: retry`,
      `  campaign r3: failed (boom)`,
    ]);
  });

  test("sweep releases an org or user deletion row as not yet implemented", async () => {
    const db = stubDb();
    const lines: string[] = [];
    const claim = vi
      .fn()
      .mockResolvedValueOnce(deletionRow("o1", "org", "acme"))
      .mockResolvedValueOnce(deletionRow("u1", "user", null))
      .mockResolvedValueOnce(undefined);
    const purge = vi.fn(); // must never be called for these kinds

    const { purged, failed } = await sweep(db, (line) => lines.push(line), claim, purge);

    expect(purged).toBe(0);
    expect(failed).toBe(2);
    expect(purge).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledTimes(2);
    expect(recordFailure).toHaveBeenCalledWith(
      db,
      "o1",
      "org purge is not implemented yet (PT-9l/9m).",
    );
    expect(recordFailure).toHaveBeenCalledWith(
      db,
      "u1",
      "user purge is not implemented yet (PT-9l/9m).",
    );
    expect(lines).toEqual([
      `  org o1: failed (org purge is not implemented yet (PT-9l/9m).)`,
      `  user u1: failed (user purge is not implemented yet (PT-9l/9m).)`,
    ]);
  });

  test("sweep records a data error and continues for a campaign row with a null org_id", async () => {
    const db = stubDb();
    const lines: string[] = [];
    const claim = vi
      .fn()
      .mockResolvedValueOnce(deletionRow("c1", "campaign", null))
      .mockResolvedValueOnce(undefined);
    const purge = vi.fn();

    const { purged, failed } = await sweep(db, (line) => lines.push(line), claim, purge);

    expect(purged).toBe(0);
    expect(failed).toBe(1);
    expect(purge).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(
      db,
      "c1",
      "campaign deletion row c1 has a null org_id",
    );
    expect(lines).toEqual([`  campaign c1: failed (campaign deletion row c1 has a null org_id)`]);
  });

  test("sweep records a thrown purge error and continues to the next row", async () => {
    const db = stubDb();
    const lines: string[] = [];
    // Both branches of `error instanceof Error ? error.message : String(error)`:
    // a real Error, then a bare string throw. A successful row bookends them to
    // prove the sweep does not abort on a bad row.
    const claim = vi
      .fn()
      .mockResolvedValueOnce(deletionRow("good"))
      .mockResolvedValueOnce(deletionRow("err"))
      .mockResolvedValueOnce(deletionRow("str"))
      .mockResolvedValueOnce(undefined);
    const purge = vi
      .fn()
      .mockResolvedValueOnce("purged")
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => {
        throw "boom";
      });

    const { purged, failed } = await sweep(db, (line) => lines.push(line), claim, purge);

    expect(purged).toBe(1);
    expect(failed).toBe(2);
    expect(purge).toHaveBeenCalledTimes(3);
    expect(recordFailure).toHaveBeenCalledTimes(2);
    expect(recordFailure).toHaveBeenNthCalledWith(1, db, "err", "boom");
    expect(recordFailure).toHaveBeenNthCalledWith(2, db, "str", "boom");
    expect(lines).toEqual([
      `  campaign good: purged`,
      `  campaign err: failed (boom)`,
      `  campaign str: failed (boom)`,
    ]);
  });

  test("sweep stops after MAX_CLAIMS_PER_SWEEP claims in one run", async () => {
    const db = stubDb();
    // A claim that would never return undefined on its own: the per-invocation
    // cap is the only thing that can stop the loop. Fresh ids so no dedupe logic
    // (which does not exist here) could mask the count.
    let n = 0;
    const claim = vi.fn(async () => deletionRow(`row-${n++}`));
    const purge = vi.fn().mockResolvedValue("purged");

    const { purged, failed } = await sweep(db, () => {}, claim, purge);

    expect(claim).toHaveBeenCalledTimes(MAX_CLAIMS_PER_SWEEP);
    expect(purged).toBe(MAX_CLAIMS_PER_SWEEP);
    expect(failed).toBe(0);
  });

  describe("main", () => {
    test("main sweep --dry-run lists due rows without claiming", async () => {
      const db = stubDb();
      const open = vi.fn(() => db);
      const lines: string[] = [];

      // Empty: "Nothing due." and no claim/list call beyond listDue.
      vi.mocked(listDue).mockResolvedValueOnce([]);
      await main("sweep", true, open, (line) => lines.push(line));
      expect(lines).toEqual(["  Nothing due."]);
      expect(open).toHaveBeenCalled();
      expect(db.end).toHaveBeenCalled();
      expect(claimDue).not.toHaveBeenCalled();
      expect(purgeCampaign).not.toHaveBeenCalled();

      // Non-empty: one line per row, and never a claim. The user row carries a
      // null org_id so the `?? "—"` branch is exercised.
      vi.clearAllMocks();
      vi.mocked(listDue).mockResolvedValueOnce([
        {
          id: "d1",
          orgId: "acme",
          kind: "campaign",
          subject: "c-uuid",
          requestedBy: "u1",
          notBefore: Date.now(),
          attempts: 0,
        },
        {
          id: "d2",
          orgId: null,
          kind: "user",
          subject: "erased:00000000-0000-0000-0000-000000000000",
          requestedBy: "u1",
          notBefore: Date.now(),
          attempts: 0,
        },
      ]);
      const listed: string[] = [];
      await main("sweep", true, open, (line) => listed.push(line));
      expect(listed).toEqual([
        `  campaign "c-uuid" (org acme)`,
        `  user "erased:00000000-0000-0000-0000-000000000000" (org —)`,
      ]);
      expect(db.end).toHaveBeenCalled();
      expect(claimDue).not.toHaveBeenCalled();
      expect(purgeCampaign).not.toHaveBeenCalled();
    });

    test("main sweep purges and logs the counts", async () => {
      const db = stubDb();
      const open = vi.fn(() => db);
      const lines: string[] = [];
      // claimDue hands one campaign row then nothing; purgeCampaign succeeds.
      vi.mocked(claimDue)
        .mockResolvedValueOnce(deletionRow("r1", "campaign", "acme", "c-uuid"))
        .mockResolvedValueOnce(undefined);
      vi.mocked(purgeCampaign).mockResolvedValueOnce("purged");

      await main("sweep", false, open, (line) => lines.push(line));

      // main and sweep write to the SAME injected log stream: the per-row line
      // followed by the summary line, in one array.
      expect(lines).toEqual([`  campaign r1: purged`, `  Purged 1 deletion row(s), 0 failed.`]);
      expect(db.end).toHaveBeenCalled();
      // A per-row failure is not a setup failure: main returns normally and never
      // touches process.exitCode here.
      expect(process.exitCode).toBeUndefined();
    });

    test("main refuses an unknown or missing command", async () => {
      const open = vi.fn();
      await expect(main("other", false, open)).rejects.toThrow(USAGE);
      await expect(main(undefined, false, open)).rejects.toThrow(USAGE);
      // The defaults are never reached on a refused command.
      expect(open).not.toHaveBeenCalled();
      // As `db.test.ts:44` does for the db CLI: a refused command throws before
      // `open` (or, here, `dryRun`) is ever consulted — but purge's `main` takes
      // a `dryRun` argument the db CLI has not, so it is passed through.
      await expect(main("drop", false)).rejects.toThrow(USAGE); // no injected open/log at all
    });
  });
});
