import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { PublishedClipObjectMissingError } from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import {
  PgPublishedClipStore,
  PublishedClipRecordRefusedError,
  publishedClipLockName,
} from "../pg-published-clip-store.js";

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

  test("a tombstoned campaign's record is refused, recording nothing (CFAR6-record)", async () => {
    const store = new PgPublishedClipStore(db);
    await db.query(`update campaign set deleted_at = now() where id = $1`, [acmeCampaign]);

    await expect(
      store.record("acme", acmeCampaign, "acme/aaa/0123.mp4", "https://pub/aaa.mp4", "0123"),
    ).rejects.toBeInstanceOf(PublishedClipRecordRefusedError);
    // Nothing was recorded: the tombstoned campaign gained no published-clip
    // fact, even though the insert itself would have succeeded.
    expect(await store.find("acme", acmeCampaign, "0123")).toBeUndefined();
    expect(await store.listForCampaign("acme", acmeCampaign)).toEqual([]);
  });

  test("a live campaign still records after a sibling campaign was tombstoned", async () => {
    const store = new PgPublishedClipStore(db);
    await db.query(`update campaign set deleted_at = now() where id = $1`, [acmeCampaign]);

    expect(
      await store.record("beta", betaCampaign, "beta/bbb/0123.mp4", "https://pub/bbb.mp4", "0123"),
    ).toBe("recorded");
    expect(await store.find("beta", betaCampaign, "0123")).toEqual({
      key: "beta/bbb/0123.mp4",
      url: "https://pub/bbb.mp4",
    });
  });

  describe("PgPublishedClipStore object precondition", () => {
    test("writes nothing and refuses when the object is gone, records when it is present", async () => {
      const db = await migratedDatabase();
      try {
        await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
        const campaign = randomUUID();
        await db.query(
          `insert into campaign (id, org_id, slug) values ($1::uuid, 'acme', 'acme-one')`,
          [campaign],
        );
        const store = new PgPublishedClipStore(db);
        await expect(
          store.record(
            "acme",
            campaign,
            "acme/aaa/0123.mp4",
            "https://pub/a.mp4",
            "0123",
            async () => false,
          ),
        ).rejects.toBeInstanceOf(PublishedClipObjectMissingError);
        expect(await store.find("acme", campaign, "0123")).toBeUndefined();

        await expect(
          store.record(
            "acme",
            campaign,
            "acme/aaa/0123.mp4",
            "https://pub/a.mp4",
            "0123",
            async () => true,
          ),
        ).resolves.toBe("recorded");
        expect(await store.find("acme", campaign, "0123")).toBeDefined();
      } finally {
        await db.end();
      }
    });
  });

  test("record takes the key's advisory lock before it checks the object or writes the row", async () => {
    const db2 = await migratedDatabase();
    try {
      await db2.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
      const campaign = randomUUID();
      await db2.query(
        `insert into campaign (id, org_id, slug) values ($1::uuid, 'acme', 'acme-one')`,
        [campaign],
      );
      const events: string[] = [];
      const watched: SqlClient = {
        ...db2,
        transaction: (work) =>
          db2.transaction((tx) =>
            work({
              query: async (text: string, params?: readonly unknown[]) => {
                if (text.includes("pg_advisory_xact_lock")) {
                  events.push(`lock:${String(params?.[0])}`);
                } else if (text.includes("insert into published_clip")) {
                  events.push("insert");
                }
                return tx.query(text, params);
              },
              exec: (text: string) => tx.exec(text),
            }),
          ),
      };
      await new PgPublishedClipStore(watched).record(
        "acme",
        campaign,
        "acme/aaa/0123.mp4",
        "https://pub/a.mp4",
        "0123",
        async () => {
          events.push("check");
          return true;
        },
      );
      expect(events).toEqual([
        `lock:${publishedClipLockName("acme", "acme/aaa/0123.mp4")}`,
        "check",
        "insert",
      ]);
    } finally {
      await db2.end();
    }
  });
});
