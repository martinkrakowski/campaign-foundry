import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { requestOrgDeletion } from "../purge-org.js";
import { seedOrg, snapshot } from "./purge-org-fixtures.js";

describe("requestOrgDeletion (PT-9m2, D241)", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await migratedDatabase();
  });
  afterEach(async () => {
    await db.end();
  });

  test("requestOrgDeletion tombstones the org and queues one org deletion row", async () => {
    await seedOrg(db, "acme");
    await seedOrg(db, "beta");
    const beforeBeta = await snapshot(db, "beta");
    const beforeAcme = await snapshot(db, "acme");

    const result = await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
    expect(result).toBe("requested");

    const { rows: acme } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from org where id = $1`,
      ["acme"],
    );
    expect(acme[0]!.deleted_at).not.toBeNull();
    const { rows: betaLive } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from org where id = $1`,
      ["beta"],
    );
    expect(betaLive[0]!.deleted_at).toBeNull();

    const { rows: orgRows } = await db.query<{
      org_id: string;
      kind: string;
      subject: string;
      requested_by: string;
      purged_at: Date | null;
      not_before: Date;
    }>(
      `select org_id, kind, subject, requested_by, purged_at, not_before
         from deletion where org_id = $1 and kind = 'org'`,
      ["acme"],
    );
    expect(orgRows).toHaveLength(1);
    expect(orgRows[0]!.org_id).toBe("acme");
    expect(orgRows[0]!.kind).toBe("org");
    expect(orgRows[0]!.subject).toBe("acme");
    expect(orgRows[0]!.requested_by).toBe("operator");
    expect(orgRows[0]!.purged_at).toBeNull();
    expect(orgRows[0]!.not_before.getTime()).toBeLessThanOrEqual(Date.now());
    const { rows: betaCount } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion where org_id = $1 and kind = 'org'`,
      ["beta"],
    );
    expect(betaCount[0]!.n).toBe(0);

    // Everything of acme is unchanged except the org row and the deletion rows.
    const afterAcme = await snapshot(db, "acme");
    expect({ ...beforeAcme, org: afterAcme.org, deletion: afterAcme.deletion }).toEqual(afterAcme);
    // B is untouched: byte for byte.
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
  });

  test("requestOrgDeletion is idempotent and queues no second row", async () => {
    await seedOrg(db, "acme");
    await seedOrg(db, "beta");
    const beforeBeta = await snapshot(db, "beta");

    const first = await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
    expect(first).toBe("requested");
    const { rows: firstDeleted } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from org where id = $1`,
      ["acme"],
    );

    const second = await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
    expect(second).toBe("already-requested");
    const { rows: secondDeleted } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from org where id = $1`,
      ["acme"],
    );
    expect(secondDeleted[0]!.deleted_at).toEqual(firstDeleted[0]!.deleted_at);

    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion where org_id = 'acme' and kind = 'org'`,
    );
    expect(count[0]!.n).toBe(1);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
  });

  test("requestOrgDeletion refuses the local org and writes nothing", async () => {
    await seedOrg(db, "acme");
    await seedOrg(db, "beta");
    const beforeBeta = await snapshot(db, "beta");

    await expect(
      requestOrgDeletion(db, { orgId: "local", requestedBy: "operator" }),
    ).rejects.toThrow(/org "local" can never be deleted\./);

    const { rows: local } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from org where id = $1`,
      ["local"],
    );
    expect(local[0]!.deleted_at).toBeNull();
    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion where kind = 'org'`,
    );
    expect(count[0]!.n).toBe(0);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
  });

  test("requestOrgDeletion refuses an unknown org and writes nothing", async () => {
    await seedOrg(db, "acme");
    await seedOrg(db, "beta");
    const beforeBeta = await snapshot(db, "beta");

    await expect(
      requestOrgDeletion(db, { orgId: "ghost", requestedBy: "operator" }),
    ).rejects.toThrow(/unknown org "ghost"/);

    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion where kind = 'org'`,
    );
    expect(count[0]!.n).toBe(0);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
  });

  test("requestOrgDeletion leaves the org live when the queue insert fails", async () => {
    await seedOrg(db, "acme");
    await seedOrg(db, "beta");
    const beforeBeta = await snapshot(db, "beta");
    // PGlite is one connection: intercept inside the transaction so the organ
    // tombstone runs but the `insert into deletion` rejects, rolling both back.
    const wrapped: SqlClient = {
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            query: (text, params) =>
              /insert into deletion/.test(text)
                ? Promise.reject(new Error("boom"))
                : tx.query(text, params),
          }),
        ),
    };

    await expect(
      requestOrgDeletion(wrapped, { orgId: "acme", requestedBy: "operator" }),
    ).rejects.toThrow("boom");

    const { rows: acme } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from org where id = $1`,
      ["acme"],
    );
    expect(acme[0]!.deleted_at).toBeNull();
    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion where kind = 'org'`,
    );
    expect(count[0]!.n).toBe(0);
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
  });
});
