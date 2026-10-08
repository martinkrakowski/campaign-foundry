import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetObjectStoreClient, setObjectStoreClient } from "../../object-store/index.js";
import { orgPrefix } from "../../object-store/object-keys.js";
import { purgeCampaign } from "../purge-campaign.js";
import { purgeOrg, requestOrgDeletion } from "../purge-org.js";
import { objectSnapshot, orgRow, seedOrg, snapshot } from "./purge-org-fixtures.js";

const CHILD_TABLES = [
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
  "team",
  "member",
  "invitation",
  "brief_version",
  "team_member",
] as const;

describe("purgeOrg end-to-end (PT-9m2, D241)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let savedStore: string | undefined;

  beforeEach(async () => {
    db = await migratedDatabase();
    savedStore = process.env.OBJECT_STORE;
    process.env.OBJECT_STORE = "s3";
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
  });
  afterEach(async () => {
    await db.end();
    resetObjectStoreClient();
    if (savedStore === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = savedStore;
  });

  test("purgeOrg after real campaign purges leaves the org empty and a second org identical", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);

    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    const beforeAcme = await snapshot(db, "acme");

    await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
    const row = await orgRow(db, "acme");

    // The first purge queues the campaign purges and answers retry.
    expect(await purgeOrg(db, "acme", row)).toBe("retry");

    // Drive the campaign purges directly (the real purgeCampaign), one per row.
    const { rows: pending } = await db.query<{ id: string; subject: string }>(
      `select id, subject from deletion
         where org_id = 'acme' and kind = 'campaign' and purged_at is null
       order by not_before`,
    );
    for (const { id, subject } of pending) {
      expect(await purgeCampaign(db, "acme", { id, subject })).toBe("purged");
    }

    // Now no campaign rows remain, so a second purge runs to completion.
    expect(await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy })).toBe("purged");

    // Every acme row is gone except the (anonymised) org row, the retained usage
    // rows, and the deletion rows — which are all anonymised and all purged.
    const after = await snapshot(db, "acme");
    expect(after.org).toHaveLength(1);
    const org = JSON.parse(after.org[0]!);
    expect(org.name).toBe("Deleted org");
    expect(org.slug).toBe("acme");
    expect(org.logo).toBeNull();
    expect(org.metadata).toBeNull();
    for (const table of CHILD_TABLES) {
      expect(after[table]).toEqual([]);
    }
    // Usage is untouched and equals the pre-purge snapshot.
    expect(after.usage).toEqual(beforeAcme.usage);
    // Every deletion row is anonymised and marked purged.
    expect(after.deletion.length).toBeGreaterThan(0);
    const tokens = new Set<string>();
    for (const d of after.deletion) {
      const parsed = JSON.parse(d);
      expect(parsed.purged_at).not.toBeNull();
      expect(parsed.requested_by).toMatch(
        /^erased:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(tokens.has(parsed.requested_by)).toBe(false);
      tokens.add(parsed.requested_by);
    }
    // The whole org prefix is empty.
    expect(await store.list(orgPrefix("acme"))).toHaveLength(0);

    // Beta is byte-identical: rows and objects.
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
    expect(await objectSnapshot(store, "acme")).toEqual([]);
  });
});
