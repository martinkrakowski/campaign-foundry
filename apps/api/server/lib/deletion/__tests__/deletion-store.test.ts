import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { claimDue, listDue, recordFailure } from "../deletion-store.js";

/** A `deletion` row planted directly — every one's `subject` is a campaign uuid,
 * never a slug (GAP's opening paragraph: a campaign deletion names its uuid). */
async function plantDeletion(
  db: SqlClient,
  opts: {
    notBefore?: Date;
    claimedUntil?: Date | null;
    purgedAt?: Date | null;
  },
): Promise<string> {
  const subject = randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `insert into deletion (org_id, kind, subject, requested_by, not_before, claimed_until, purged_at)
       values ('local', 'campaign', $1, 'tester', $2, $3, $4)
     returning id`,
    [subject, opts.notBefore ?? new Date(), opts.claimedUntil ?? null, opts.purgedAt ?? null],
  );
  return rows[0]!.id;
}

/** Re-read a single `deletion` row's claim-facing columns. */
async function readClaim(
  db: SqlClient,
  id: string,
): Promise<{
  claimed_until: Date | null;
  attempts: number;
  last_error: string | null;
  purged_at: Date | null;
}> {
  const { rows } = await db.query<{
    claimed_until: Date | null;
    attempts: number;
    last_error: string | null;
    purged_at: Date | null;
  }>(`select claimed_until, attempts, last_error, purged_at from deletion where id = $1`, [id]);
  return rows[0]!;
}

describe("deletion-store (D231, PT-9-4 claim/lease)", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await migratedDatabase();
    // `local` is seeded by 0001_org.sql; ensure it is present for the FK-less
    // `deletion.org_id` to read as a real tenant in either backend.
  });
  afterEach(async () => {
    await db.end();
  });

  test("claimDue returns the oldest due row and sets claimed_until and attempts", async () => {
    const subject = randomUUID();
    const { rows } = await db.query<{ id: string }>(
      `insert into deletion (org_id, kind, subject, requested_by, not_before)
         values ('local', 'campaign', $1, 'tester', now())
       returning id`,
      [subject],
    );
    const id = rows[0]!.id;

    const claimed = await claimDue(db);

    expect(claimed).toEqual({
      id,
      orgId: "local",
      kind: "campaign",
      subject,
      requestedBy: "tester",
      notBefore: expect.any(Number),
      attempts: 1,
    });
    const onDisk = await readClaim(db, id);
    expect(onDisk.attempts).toBe(1);
    expect(onDisk.claimed_until!.getTime()).toBeGreaterThan(Date.now());
  });

  test("claimDue skips a row not yet due", async () => {
    const subject = randomUUID();
    const { rows } = await db.query<{ id: string }>(
      `insert into deletion (org_id, kind, subject, requested_by, not_before)
         values ('local', 'campaign', $1, 'tester', now() + interval '1 hour')
       returning id`,
      [subject],
    );
    const id = rows[0]!.id;

    await expect(claimDue(db)).resolves.toBeUndefined();

    const onDisk = await readClaim(db, id);
    expect(onDisk.claimed_until).toBeNull();
    expect(onDisk.attempts).toBe(0);
  });

  test("claimDue skips a row claimed by someone else", async () => {
    const id = await plantDeletion(db, { claimedUntil: new Date(Date.now() + 60_000) });

    await expect(claimDue(db)).resolves.toBeUndefined();

    const onDisk = await readClaim(db, id);
    expect(onDisk.claimed_until!.getTime()).toBeGreaterThan(Date.now());
    expect(onDisk.attempts).toBe(0);
  });

  test("claimDue reclaims a row whose lease has lapsed", async () => {
    const id = await plantDeletion(db, {
      claimedUntil: new Date(Date.now() - 60_000),
    });

    const claimed = await claimDue(db);

    expect(claimed).toBeDefined();
    expect(claimed!.id).toBe(id);
    expect(claimed!.attempts).toBe(1);
    const onDisk = await readClaim(db, id);
    expect(onDisk.claimed_until!.getTime()).toBeGreaterThan(Date.now());
    expect(onDisk.attempts).toBe(1);
  });

  test("claimDue skips an already purged row", async () => {
    const id = await plantDeletion(db, { purgedAt: new Date() });

    await expect(claimDue(db)).resolves.toBeUndefined();

    const onDisk = await readClaim(db, id);
    expect(onDisk.purged_at).not.toBeNull();
    expect(onDisk.attempts).toBe(0);
  });

  test("claimDue returns undefined when nothing is due", async () => {
    await expect(claimDue(db)).resolves.toBeUndefined();
  });

  test("recordFailure sets last_error and leaves the claim in place", async () => {
    const id = await plantDeletion(db, { claimedUntil: new Date(Date.now() + 60_000) });
    const before = await readClaim(db, id);

    await recordFailure(db, id, "s3 endpoint unreachable");

    const onDisk = await readClaim(db, id);
    expect(onDisk.last_error).toBe("s3 endpoint unreachable");
    // The lease is intentionally left standing: head-of-line starvation's fix.
    expect(
      Math.abs(onDisk.claimed_until!.getTime() - before.claimed_until!.getTime()),
    ).toBeLessThan(1_000);
    expect(onDisk.claimed_until!.getTime()).toBeGreaterThan(Date.now());
    expect(onDisk.attempts).toBe(0);
  });

  test("listDue never claims", async () => {
    const id = await plantDeletion(db, {});

    const first = await listDue(db);
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe(id);
    expect(first[0]!.orgId).toBe("local");
    expect(first[0]!.kind).toBe("campaign");

    const second = await listDue(db);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(id);

    const onDisk = await readClaim(db, id);
    expect(onDisk.claimed_until).toBeNull();
    expect(onDisk.attempts).toBe(0);
  });
});
