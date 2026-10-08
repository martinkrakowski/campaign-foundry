import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { migratedDatabase } from "../../server/lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../server/lib/db/sql-client.js";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import {
  resetObjectStoreClient,
  setObjectStoreClient,
} from "../../server/lib/object-store/index.js";
import {
  seedOrg,
  snapshot,
  objectSnapshot,
} from "../../server/lib/deletion/__tests__/purge-org-fixtures.js";
import { USAGE_ORG, parseOrgPurgeArgs, runOrgPurge, sweep, purgeRow } from "../purge.js";

describe("org purge CLI (bin/purge.ts, PT-9m3, D241)", () => {
  let db: SqlClient;
  let endSpy: ReturnType<typeof vi.spyOn>;
  let memory: InMemoryObjectStore;

  const open = () => db;

  beforeEach(async () => {
    db = await migratedDatabase();
    endSpy = vi.spyOn(db, "end").mockResolvedValue(undefined);
    memory = new InMemoryObjectStore({ now: () => Date.now() });
    setObjectStoreClient(memory);
  });

  afterEach(async () => {
    endSpy.mockRestore();
    await db.end();
    delete process.env.OBJECT_STORE;
    resetObjectStoreClient();
    vi.restoreAllMocks();
  });

  test("org CLI refuses bad arguments and the local org before opening anything", async () => {
    const open = vi.fn();
    for (const args of [
      [],
      ["--apply"],
      ["--org"],
      ["--org", "acme", "--org", "beta"],
      ["--org", "acme", "--apply", "--dry-run"],
      ["--org", "--apply"],
      ["--org", ""],
      ["--org", "-x"],
      ["--bogus"],
    ]) {
      await expect(runOrgPurge(args, open)).rejects.toThrow(USAGE_ORG);
    }
    await expect(runOrgPurge(["--org", "local"], open)).rejects.toThrow(
      'org "local" can never be deleted.',
    );
    await expect(runOrgPurge(["--org", "local", "--apply"], open)).rejects.toThrow(
      'org "local" can never be deleted.',
    );
    expect(open).not.toHaveBeenCalled();

    expect(parseOrgPurgeArgs(["--org", "acme"])).toEqual({ apply: false, org: "acme" });
    expect(parseOrgPurgeArgs(["--org", "acme", "--apply"])).toEqual({ apply: true, org: "acme" });
  });

  test("runOrgPurge uses default open when args are bad, throwing before any connection", async () => {
    await expect(runOrgPurge(["--bogus"])).rejects.toThrow(USAGE_ORG);
  });

  test("org CLI dry run prints counts and changes nothing", async () => {
    await seedOrg(db, "acme", memory);
    await seedOrg(db, "beta", memory);
    expect((await objectSnapshot(memory, "acme")).length).toBeGreaterThan(0);

    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeObj = await objectSnapshot(memory, "acme");
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(memory, "beta");

    const lines: string[] = [];
    await runOrgPurge(["--org", "acme"], open, (l) => lines.push(l));

    expect(lines).toEqual([
      "  org acme: 2 live campaign(s), 0 tombstoned, 2 member(s), 1 team(s), 1 invitation(s), 1 provider key(s)",
      "  state: live",
      "  Dry run: nothing changed. Re-run with --apply to tombstone the org and queue its purge, then run yarn purge:sweep.",
    ]);
    for (const needle of [
      "Name of acme",
      "@example.test",
      "ct-acme",
      "u-acme-1",
      "u-acme-2",
      "operator",
    ]) {
      expect(lines.some((l) => l.includes(needle))).toBe(false);
    }
    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
    expect(await objectSnapshot(memory, "acme")).toEqual(beforeAcmeObj);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(memory, "beta")).toEqual(beforeBetaObj);

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion where kind = 'org'`,
    );
    expect(rows[0]!.n).toBe(0);
    expect(endSpy).toHaveBeenCalledTimes(1);

    // A tombstoned org prints "tombstoned"
    await db.query(`update org set deleted_at = now() where id = 'acme'`);
    lines.length = 0;
    await runOrgPurge(["--org", "acme"], open, (l) => lines.push(l));
    expect(lines[1]).toBe("  state: tombstoned");
  });

  test("org CLI apply tombstones the org and queues one org row and purges nothing", async () => {
    await seedOrg(db, "acme");
    await seedOrg(db, "beta");
    const beforeAcme = await snapshot(db, "acme");
    const lines: string[] = [];
    await runOrgPurge(["--org", "acme", "--apply"], open, (l) => lines.push(l));

    expect(lines).toEqual(["  Org acme: deletion requested; run yarn purge:sweep to purge it."]);

    const { rows: org } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from org where id = 'acme'`,
    );
    expect(org[0]!.deleted_at).not.toBeNull();

    const { rows: del } = await db.query<{
      id: string;
      org_id: string;
      subject: string;
      requested_by: string;
      purged_at: Date | null;
    }>(
      `select id, org_id, subject, requested_by, purged_at from deletion where kind = 'org' and org_id = 'acme'`,
    );
    expect(del.length).toBe(1);
    expect(del[0]!.subject).toBe("acme");
    expect(del[0]!.requested_by).toBe("operator");
    expect(del[0]!.purged_at).toBeNull();

    // After --apply, every table EXCEPT org and deletion is unchanged:
    const afterAcme = await snapshot(db, "acme");
    const orgChanged = JSON.parse(afterAcme.org[0]!) !== JSON.parse(beforeAcme.org[0]!);
    expect(orgChanged).toBe(true); // deleted_at should have changed
    for (const table of [
      "campaign",
      "member",
      "team",
      "invitation",
      "provider_key",
      "decision",
      "decision_set",
      "report",
      "pool",
      "job",
      "asset",
      "draft",
      "last_opened",
      "brief_version",
      "team_member",
      "usage",
    ]) {
      expect(afterAcme[table as keyof typeof afterAcme]).toEqual(
        beforeAcme[table as keyof typeof beforeAcme],
      );
    }

    // A second --apply logs "already requested" and leaves exactly one org row
    lines.length = 0;
    await runOrgPurge(["--org", "acme", "--apply"], open, (l) => lines.push(l));
    expect(lines).toEqual(["  Org acme: deletion was already requested."]);

    const { rows: del2 } = await db.query<{ id: string }>(
      `select id from deletion where kind = 'org' and org_id = 'acme'`,
    );
    expect(del2.length).toBe(1);
  });

  test("org CLI refuses an unknown org and writes nothing", async () => {
    await seedOrg(db, "acme");
    await expect(runOrgPurge(["--org", "ghost"], open)).rejects.toThrow('org: unknown org "ghost"');
    await expect(runOrgPurge(["--org", "ghost", "--apply"], open)).rejects.toThrow(
      'org: unknown org "ghost"',
    );

    const { rows: delCount } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion where kind = 'org'`,
    );
    expect(delCount[0]!.n).toBe(0);
    expect(endSpy).toHaveBeenCalled();
  });

  test("purgeRow sends an org row to purgeOrg and a campaign row to purgeCampaign", async () => {
    await seedOrg(db, "acme");
    // A live org row triggers purgeOrg's tombstone guard
    await expect(
      purgeRow(db, "acme", { id: "x", subject: "acme", kind: "org", requestedBy: "operator" }),
    ).rejects.toThrow('org "acme" is not tombstoned; refusing to purge it');

    // A campaign row with a bad subject triggers purgeCampaign's uuid check
    await expect(
      purgeRow(db, "acme", {
        id: "x",
        subject: "not-a-uuid",
        kind: "campaign",
        requestedBy: "operator",
      }),
    ).rejects.toThrow('deletion subject "not-a-uuid" is not a campaign uuid');
  });

  test("sweep records a refused org purge and leaves the live org untouched", async () => {
    await seedOrg(db, "acme");
    await seedOrg(db, "beta");
    await db.query(
      `insert into deletion (org_id, kind, subject, requested_by, not_before) values ('acme', 'org', 'acme', 'operator', now())`,
    );

    const beforeAcme = await snapshot(db, "acme");
    const beforeBeta = await snapshot(db, "beta");

    const lines: string[] = [];
    const { purged, failed } = await sweep(db, (l) => lines.push(l));
    expect(purged).toBe(0);
    expect(failed).toBe(1);

    const { rows } = await db.query<{ last_error: string; purged_at: Date | null }>(
      `select last_error, purged_at from deletion where kind = 'org' and org_id = 'acme'`,
    );
    expect(rows[0]!.last_error).toBe('org "acme" is not tombstoned; refusing to purge it');
    expect(rows[0]!.purged_at).toBeNull();

    // The org's own rows (everything but the deletion table, which the sweep is
    // expected to mutate) must be byte-identical.
    const afterAcme = await snapshot(db, "acme");
    const afterBeta = await snapshot(db, "beta");
    for (const table of [
      "org",
      "campaign",
      "decision",
      "decision_set",
      "report",
      "pool",
      "job",
      "asset",
      "draft",
      "last_opened",
      "provider_key",
      "usage",
      "team",
      "member",
      "invitation",
      "brief_version",
      "team_member",
    ]) {
      expect(afterAcme[table as keyof typeof afterAcme]).toEqual(
        beforeAcme[table as keyof typeof beforeAcme],
      );
      expect(afterBeta[table as keyof typeof afterBeta]).toEqual(
        beforeBeta[table as keyof typeof beforeBeta],
      );
    }
  });

  test("sweep claims the org row and purges the org end to end", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => Date.now() });
    setObjectStoreClient(memory);
    await seedOrg(db, "acme", memory);
    await seedOrg(db, "beta", memory);

    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(memory, "beta");

    await runOrgPurge(
      ["--org", "acme", "--apply"],
      () => db,
      () => undefined,
    );

    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeUsage = beforeAcme.usage;
    const beforeAcmeObj = await objectSnapshot(memory, "acme");

    const lines: string[] = [];
    const first = await sweep(db, (l) => lines.push(l));
    expect(first).toEqual({ purged: 2, failed: 0, orgFailed: 0 });
    // Contains "retry" line for the org and "purged" lines for campaigns
    const orgRowId = (
      await db.query<{ id: string }>(
        `select id from deletion where kind = 'org' and org_id = 'acme'`,
      )
    ).rows[0]!.id;
    expect(lines.some((l) => l.includes(`  org ${orgRowId}: retry`))).toBe(true);

    // The org row answered retry, not purged; it is waiting out its lease
    const { rows: orgRow } = await db.query<{ purged_at: Date | null }>(
      `select purged_at from deletion where kind = 'org' and org_id = 'acme'`,
    );
    expect(orgRow[0]!.purged_at).toBeNull();

    // Simulate lease lapsing
    await db.query(
      `update deletion set claimed_until = now() - interval '1 second' where kind = 'org'`,
    );

    lines.length = 0;
    const second = await sweep(db, (l) => lines.push(l));
    expect(second).toEqual({ purged: 1, failed: 0, orgFailed: 0 });
    expect(lines.some((l) => l.includes(`${orgRowId}: purged`))).toBe(true);

    // acme has zero rows in every table except org, usage, deletion (anonymised)
    for (const table of [
      "campaign",
      "member",
      "team",
      "invitation",
      "provider_key",
      "decision",
      "decision_set",
      "report",
      "pool",
      "job",
      "asset",
      "draft",
      "last_opened",
    ]) {
      const { rows: count } = await db.query<{ n: number }>(
        `select count(*)::int as n from ${table} where org_id = 'acme'`,
      );
      expect(count[0]!.n).toBe(0);
    }
    // brief_version and team_member are scoped via campaign/team, both purged:
    const { rows: bv } = await db.query<{ n: number }>(
      `select count(*)::int as n from brief_version bv join campaign c on bv.campaign_id = c.id where c.org_id = 'acme'`,
    );
    expect(bv[0]!.n).toBe(0);
    const { rows: tm } = await db.query<{ n: number }>(
      `select count(*)::int as n from team_member tm join team t on tm.team_id = t.id where t.org_id = 'acme'`,
    );
    expect(tm[0]!.n).toBe(0);
    const { rows: acmeOrg } = await db.query<{ name: string }>(
      `select name from org where id = 'acme'`,
    );
    expect(acmeOrg[0]!.name).toBe("Deleted org");

    // usage unchanged
    const acmeUsage = (await snapshot(db, "acme")).usage;
    expect(acmeUsage).toEqual(beforeAcmeUsage);

    // deletion rows anonymised
    const { rows: delRows } = await db.query<{ requested_by: string; purged_at: Date | null }>(
      `select requested_by, purged_at from deletion where org_id = 'acme' order by id`,
    );
    for (const row of delRows) {
      expect(row.requested_by).toMatch(/^erased:/);
      expect(row.purged_at).not.toBeNull();
    }

    // store emptied for acme
    const acmeObjects = await memory.list(`org/acme/`);
    expect(acmeObjects.length).toBe(0);

    // beta untouched
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(memory, "beta")).toEqual(beforeBetaObj);

    // no PII in logs
    for (const l of lines) {
      expect(l).not.toContain("@example.test");
      expect(l).not.toContain("Name of acme");
      expect(l).not.toContain("ct-acme");
      expect(l).not.toMatch(/u-acme-\d/);
      expect(l).not.toContain("operator");
    }
  });
});
