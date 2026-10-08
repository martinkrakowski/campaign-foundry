import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { migratedDatabase } from "../../server/lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../server/lib/db/sql-client.js";
import {
  resetObjectStoreClient,
  setObjectStoreClient,
} from "../../server/lib/object-store/index.js";
import { USAGE_ORG_EXPIRE, parseOrgExpireArgs, runOrgExpire } from "../purge.js";
import {
  backdateOrg,
  purgeOrgCompletely,
  seedOrg,
  snapshot,
  objectSnapshot,
} from "../../server/lib/deletion/__tests__/purge-org-fixtures.js";

const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

function saveStore(): string | undefined {
  return process.env.OBJECT_STORE;
}
function restoreStore(saved: string | undefined): void {
  if (saved === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = saved;
}

describe("org-expire CLI (bin/purge.ts, PT-9m4, D241, Q5)", () => {
  let db: SqlClient;
  let endSpy: ReturnType<typeof vi.spyOn>;
  let memory: InMemoryObjectStore;
  let savedStore: string | undefined;

  const open = () => db;

  beforeEach(async () => {
    db = await migratedDatabase();
    endSpy = vi.spyOn(db, "end").mockResolvedValue(undefined);
    savedStore = saveStore();
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore();
    setObjectStoreClient(memory);
  });

  afterEach(async () => {
    endSpy.mockRestore();
    await db.end();
    resetObjectStoreClient();
    restoreStore(savedStore);
    vi.restoreAllMocks();
  });

  afterAll(() => {
    // Proving the leak is fixed: OBJECT_STORE is unchanged across the whole suite.
    expect(process.env.OBJECT_STORE).toBe(SAVED_OBJECT_STORE);
  });

  async function purgeAndBackdate(orgId: string): Promise<void> {
    await seedOrg(db, orgId, memory);
    await purgeOrgCompletely(db, orgId);
    await backdateOrg(db, orgId, "13 months 1 day");
  }

  test("org-expire CLI refuses bad arguments before opening anything", async () => {
    const openSpy = vi.fn();
    for (const args of [
      ["--apply"],
      ["--bogus"],
      ["--org", "acme", "--apply", "--dry-run"],
      ["--org"],
    ]) {
      await expect(runOrgExpire(args, openSpy)).rejects.toThrow(USAGE_ORG_EXPIRE);
    }
    expect(openSpy).not.toHaveBeenCalled();

    expect(parseOrgExpireArgs([])).toEqual({ apply: false, org: undefined });

    // Default open: parseOrgExpireArgs throws before open() is ever called.
    await expect(runOrgExpire(["--bogus"])).rejects.toThrow(USAGE_ORG_EXPIRE);
  });

  test("org-expire CLI dry run lists eligible orgs and deletes nothing", async () => {
    await purgeAndBackdate("acme");
    await purgeAndBackdate("gamma");
    await seedOrg(db, "beta");

    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeObj = await objectSnapshot(memory, "acme");
    const beforeGamma = await snapshot(db, "gamma");
    const beforeGammaObj = await objectSnapshot(memory, "gamma");
    const beforeBeta = await snapshot(db, "beta");

    const lines: string[] = [];
    await runOrgExpire([], open, (l) => lines.push(l));
    expect(lines).toEqual([
      "  org acme: eligible (tombstoned over 13 months ago, purge complete)",
      "  org gamma: eligible (tombstoned over 13 months ago, purge complete)",
      "  Dry run: nothing deleted. Re-run with --org <id> --apply to delete.",
    ]);
    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
    expect(await objectSnapshot(memory, "acme")).toEqual(beforeAcmeObj);
    expect(await snapshot(db, "gamma")).toEqual(beforeGamma);
    expect(await objectSnapshot(memory, "gamma")).toEqual(beforeGammaObj);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);

    // No eligible orgs -> "Nothing to expire."
    // beta is live; acme and gamma are not backdated in this run.
    await db.query(`update org set deleted_at = null where id = 'acme'`);
    await db.query(`update org set deleted_at = null where id = 'gamma'`);
    lines.length = 0;
    await runOrgExpire([], open, (l) => lines.push(l));
    expect(lines).toEqual([
      "  Nothing to expire.",
      "  Dry run: nothing deleted. Re-run with --org <id> --apply to delete.",
    ]);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
  });

  test("org-expire CLI apply expires exactly the named org", async () => {
    await purgeAndBackdate("acme");
    await purgeAndBackdate("gamma");
    await seedOrg(db, "beta");
    const beforeGamma = await snapshot(db, "gamma");
    const beforeGammaObj = await objectSnapshot(memory, "gamma");
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(memory, "beta");

    const lines: string[] = [];
    await runOrgExpire(["--org", "acme", "--apply"], open, (l) => lines.push(l));
    expect(lines).toEqual(["  Expired 1 org tombstone(s)."]);

    const { rows: acmeOrg } = await db.query<{ n: number }>(
      `select count(*)::int as n from org where id = 'acme'`,
    );
    expect(acmeOrg[0]!.n).toBe(0);
    const { rows: acmeUsage } = await db.query<{ n: number }>(
      `select count(*)::int as n from usage where org_id = 'acme'`,
    );
    expect(acmeUsage[0]!.n).toBe(0);
    expect(await snapshot(db, "gamma")).toEqual(beforeGamma);
    expect(await objectSnapshot(memory, "gamma")).toEqual(beforeGammaObj);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(memory, "beta")).toEqual(beforeBetaObj);
  });

  test("org-expire CLI refuses an org that is not eligible and deletes nothing", async () => {
    await seedOrg(db, "beta");
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(memory, "beta");

    await expect(runOrgExpire(["--org", "beta"], open)).rejects.toThrow(
      'org-expire: org "beta" is not eligible: it must be tombstoned, fully purged and older than 13 months.',
    );
    await expect(runOrgExpire(["--org", "beta", "--apply"], open)).rejects.toThrow(
      'org-expire: org "beta" is not eligible: it must be tombstoned, fully purged and older than 13 months.',
    );
    await expect(runOrgExpire(["--org", "ghost"], open)).rejects.toThrow(
      'org-expire: org "ghost" is not eligible: it must be tombstoned, fully purged and older than 13 months.',
    );

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(memory, "beta")).toEqual(beforeBetaObj);
    expect(endSpy).toHaveBeenCalled();
  });

  test("org-expire CLI --org --apply takes --apply as the org id and refuses it before deleting", async () => {
    // parseOrgArgs is shared unedited: --org with no following value that is
    // not option-shaped is consumed as the org id. "--apply" is not
    // option-shaped (it doesn't start with -), so it becomes the org value
    // with apply=false. The id "--apply" matches no org, so the not-eligible
    // throw fires. Pinned: exact message, nothing deleted, connection closed.
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(memory, "beta");

    await expect(runOrgExpire(["--org", "--apply"], open)).rejects.toThrow(
      'org-expire: org "--apply" is not eligible: it must be tombstoned, fully purged and older than 13 months.',
    );
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(memory, "beta")).toEqual(beforeBetaObj);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("org-expire CLI --org --apply --apply takes the second --apply as the org id in apply mode", async () => {
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(memory, "beta");

    await expect(runOrgExpire(["--org", "--apply", "--apply"], open)).rejects.toThrow(
      'org-expire: org "--apply" is not eligible: it must be tombstoned, fully purged and older than 13 months.',
    );
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(memory, "beta")).toEqual(beforeBetaObj);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("org-expire CLI reports a failed org with a fixed message and no detail", async () => {
    await purgeAndBackdate("acme");
    await db.query(`insert into campaign (org_id, slug) values ('acme', 'late')`);
    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeObj = await objectSnapshot(memory, "acme");

    const lines: string[] = [];
    await expect(
      runOrgExpire(["--org", "acme", "--apply"], open, (l) => lines.push(l)),
    ).rejects.toThrow("org-expire: 1 org(s) could not be expired; see the lines above.");
    expect(lines).toEqual([
      "  Expired 0 org tombstone(s).",
      "  org acme: failed (could not be expired; a row may still reference it); it is left in place",
    ]);
    for (const needle of ["violates", "foreign key", "constraint", "campaign"]) {
      expect(lines.some((l) => l.includes(needle))).toBe(false);
    }

    const { rows: orgExists } = await db.query<{ n: number }>(
      `select count(*)::int as n from org where id = 'acme'`,
    );
    expect(orgExists[0]!.n).toBe(1);
    const { rows: usageRows } = await db.query<{ n: number }>(
      `select count(*)::int as n from usage where org_id = 'acme'`,
    );
    expect(usageRows[0]!.n).toBe(2);
    expect(await snapshot(db, "acme")).toEqual(beforeAcme);
    expect(await objectSnapshot(memory, "acme")).toEqual(beforeAcmeObj);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});
