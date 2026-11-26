import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { PgPublishedClipStore } from "../pg-published-clip-store.js";

/**
 * A published-clip record round trip on a real (PGlite) Postgres: idempotent
 * recording, cross-org isolation, and the refusals the schema promises —
 * duplicate content returns "exists", a duplicate key is a unique violation,
 * and a bare campaign delete is refused (FK 23503) because the row must go
 * only after the public bytes are removed.
 */
describe("PgPublishedClipStore (PT-4k)", () => {
  let db: SqlClient;
  const acmeCampaign = randomUUID();
  const betaCampaign = randomUUID();

  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    await db.query("insert into org (id, name) values ($1, $2)", ["beta", "Beta"]);
    await db.query(
      `insert into campaign (id, org_id, slug) values ($1::uuid, 'acme', 'acme-one')`,
      [acmeCampaign],
    );
    await db.query(
      `insert into campaign (id, org_id, slug) values ($1::uuid, 'beta', 'beta-one')`,
      [betaCampaign],
    );
  });
  afterEach(async () => {
    await db.end();
  });

  test("record find listForCampaign and remove round trip", async () => {
    const store = new PgPublishedClipStore(db);
    expect(
      await store.record("acme", acmeCampaign, "acme/aaa/0123.mp4", "https://pub/aaa.mp4", "0123"),
    ).toBe("recorded");

    expect(await store.find("acme", acmeCampaign, "0123")).toEqual({
      key: "acme/aaa/0123.mp4",
      url: "https://pub/aaa.mp4",
    });
    expect(await store.listForCampaign("acme", acmeCampaign)).toEqual([
      { key: "acme/aaa/0123.mp4", url: "https://pub/aaa.mp4" },
    ]);

    await store.remove("acme", "acme/aaa/0123.mp4");
    expect(await store.find("acme", acmeCampaign, "0123")).toBeUndefined();
    expect(await store.listForCampaign("acme", acmeCampaign)).toEqual([]);
  });

  test("cross-org reads answer absent and a cross-org remove deletes nothing", async () => {
    const store = new PgPublishedClipStore(db);
    await store.record("acme", acmeCampaign, "acme/aaa/0123.mp4", "https://pub/aaa.mp4", "0123");

    // beta cannot see, list, or remove acme's record.
    expect(await store.find("beta", acmeCampaign, "0123")).toBeUndefined();
    expect(await store.listForCampaign("beta", acmeCampaign)).toEqual([]);
    await store.remove("beta", "acme/aaa/0123.mp4");
    expect(await store.find("acme", acmeCampaign, "0123")).toEqual({
      key: "acme/aaa/0123.mp4",
      url: "https://pub/aaa.mp4",
    });
  });

  test("a duplicate content hash returns exists and preserves the original row", async () => {
    const store = new PgPublishedClipStore(db);
    await store.record("acme", acmeCampaign, "acme/aaa/0123.mp4", "https://pub/aaa.mp4", "0123");

    expect(
      await store.record(
        "acme",
        acmeCampaign,
        "acme/aaa/other.mp4",
        "https://pub/other.mp4",
        "0123",
      ),
    ).toBe("exists");

    // The winning record's key is untouched: the loser changed nothing.
    expect(await store.find("acme", acmeCampaign, "0123")).toEqual({
      key: "acme/aaa/0123.mp4",
      url: "https://pub/aaa.mp4",
    });
  });

  test("a duplicate key over a different content hash is refused, never exists", async () => {
    const store = new PgPublishedClipStore(db);
    await store.record("acme", acmeCampaign, "acme/aaa/0123.mp4", "https://pub/aaa.mp4", "0123");

    // Same key, different (campaign, content hash): the `key` unique
    // constraint refuses — a published object cannot back two records.
    await expect(
      store.record("acme", acmeCampaign, "acme/aaa/0123.mp4", "https://pub/aaa.mp4", "9999"),
    ).rejects.toMatchObject({ code: "23505" });
    // And nothing was written under the new hash.
    expect(await store.find("acme", acmeCampaign, "9999")).toBeUndefined();
  });

  test("a bare campaign delete with published_clip rows is refused with FK 23503", async () => {
    const store = new PgPublishedClipStore(db);
    await store.record("acme", acmeCampaign, "acme/aaa/0123.mp4", "https://pub/aaa.mp4", "0123");

    // No cascade, deliberately: the public object must be removed before the
    // row, so a bare delete must fail closed instead of orphaning the bytes.
    await expect(
      db.query(`delete from campaign where id = $1`, [acmeCampaign]),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await store.find("acme", acmeCampaign, "0123")).toBeDefined();
  });
});
