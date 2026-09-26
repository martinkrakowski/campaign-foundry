import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { FsReportStore } from "../fs-report-store.js";
import { ReportConflictError } from "../report-store.port.js";
import { JobLeaseLostError } from "../job-store.port.js";
import { PgReportStore } from "../pg-report-store.js";

import { getReportStore, resetReportStore } from "../index.js";
import { LOCAL_TENANT, type TenantContext } from "../../tenant.js";

const acme: TenantContext = { ...LOCAL_TENANT, orgId: "acme", userId: "u1" };

describe("PgReportStore (PT-3c, D169)", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await migratedDatabase();
  });
  afterEach(async () => {
    await db.end();
  });

  test("a report round-trips the exact payload bytes as JSON", async () => {
    const store = new PgReportStore(db, "local");
    const payload = JSON.stringify({ assets: [{ productId: "alpha" }] }, null, 2);
    await store.writeReport("camp", payload);
    await expect(store.readReport("camp")).resolves.toEqual(JSON.parse(payload));
  });

  test("the same payload has the same revision as in the file store, so an import keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-pg-report-"));
    try {
      const payload = '{"assets":[]}';
      await new FsReportStore(dir).writeReport("camp", payload);
      const fsRevision = await new FsReportStore(dir).getRevision("camp");
      await new PgReportStore(db, "local").writeReport("camp", payload);
      expect(await new PgReportStore(db, "local").getRevision("camp")).toBe(fsRevision);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a null expectation is refused once a report exists, and writes nothing", async () => {
    const store = new PgReportStore(db, "local");
    await store.writeReport("camp", '{"assets":[]}');
    const revision = await store.getRevision("camp");
    await expect(store.writeReport("camp", '{"assets":[1]}', null)).rejects.toMatchObject({
      code: "ECONFLICT",
      revision,
    });
    await expect(store.readReport("camp")).resolves.toEqual({ assets: [] });
  });

  test("a stale string is refused with the current revision, and writes nothing", async () => {
    const store = new PgReportStore(db, "local");
    await store.writeReport("camp", '{"assets":[]}', null);
    const firstRevision = await store.getRevision("camp");
    await store.writeReport("camp", '{"assets":[1]}', firstRevision);
    const secondRevision = await store.getRevision("camp");
    const stale = store.writeReport("camp", '{"assets":[2]}', firstRevision);
    await expect(stale).rejects.toBeInstanceOf(ReportConflictError);
    await expect(stale).rejects.toMatchObject({ code: "ECONFLICT", revision: secondRevision });
    await expect(store.readReport("camp")).resolves.toEqual({ assets: [1] });
  });

  test("an undefined expectation writes unconditionally, overwriting whatever is stored", async () => {
    const store = new PgReportStore(db, "local");
    await store.writeReport("camp", '{"assets":[]}', null);
    await store.writeReport("camp", '{"assets":[1]}');
    await expect(store.readReport("camp")).resolves.toEqual({ assets: [1] });
  });

  test("a string expectation against a campaign with no row is a conflict at a null revision", async () => {
    const store = new PgReportStore(db, "local");
    await expect(
      store.writeReport("fresh", '{"assets":[]}', "no-such-revision"),
    ).rejects.toMatchObject({ code: "ECONFLICT", revision: undefined });
  });

  test("another org's reports are invisible, and its own are separate", async () => {
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    const local = new PgReportStore(db, "local");
    const acmeStore = new PgReportStore(db, "acme");
    await local.writeReport("camp", '{"assets":["local"]}');
    await expect(acmeStore.readReport("camp")).resolves.toBeUndefined();
    await acmeStore.writeReport("camp", '{"assets":["acme"]}');
    await expect(local.readReport("camp")).resolves.toEqual({ assets: ["local"] });
  });

  test("an unsafe campaign id reads and hashes as nothing, and cannot be written", async () => {
    const store = new PgReportStore(db, "local");
    await expect(store.readReport("../evil")).resolves.toBeUndefined();
    await expect(store.getRevision("../evil")).resolves.toBeUndefined();
    await expect(store.writeReport("../evil", "{}")).rejects.toThrow(
      'Report campaign id "../evil" is not a safe id.',
    );
  });

  test("a stored JSON null round-trips as null, distinct from missing", async () => {
    const store = new PgReportStore(db, "local");
    await store.writeReport("camp", "null");
    await expect(store.readReport("camp")).resolves.toBeNull();
    await expect(store.readReport("fresh")).resolves.toBeUndefined();
  });

  test("a stored body that is not JSON rejects rather than reading as absent", async () => {
    const store = new PgReportStore(db, "local");
    await db.query(
      "insert into report (org_id, campaign_id, body, revision) values ($1, $2, $3, $4)",
      ["local", "camp", "{not json", "deadbeef"],
    );
    await expect(store.readReport("camp")).rejects.toThrow(SyntaxError);
  });

  test("a pg report write is refused for a lapsed lease (pre-seeded job row), and accepted for a live one", async () => {
    const store = new PgReportStore(db, "local");
    const payload = JSON.stringify({ assets: [{ productId: "alpha" }] });

    await db.query(
      `insert into job (id, org_id, campaign_id, status, lease_expires_at)
       values ($1, 'local', 'camp', 'running', now() - interval '10 seconds')`,
      ["lapsed-run"],
    );
    await expect(
      store.writeReport("camp", payload, undefined, { runId: "lapsed-run" }),
    ).rejects.toBeInstanceOf(JobLeaseLostError);

    await db.query(
      `insert into job (id, org_id, campaign_id, status, lease_expires_at)
       values ($1, 'local', 'camp-live', 'running', now() + interval '60 seconds')`,
      ["live-run"],
    );
    await expect(
      store.writeReport("camp-live", payload, undefined, { runId: "live-run" }),
    ).resolves.toBe("reports/camp-live.json");
  });

  test("no fence leaves behaviour unchanged", async () => {
    const store = new PgReportStore(db, "local");
    const payload = JSON.stringify({ assets: [{ productId: "alpha" }] });
    await expect(store.writeReport("camp-no-fence", payload)).resolves.toBe(
      "reports/camp-no-fence.json",
    );
  });
});


describe("STORE_BACKEND=postgres puts reports in the database, one store per org (PT-3c)", () => {
  const saved = process.env.STORE_BACKEND;
  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
    resetReportStore();
    resetDatabase();
  });

  test("the default is the file store", () => {
    delete process.env.STORE_BACKEND;
    expect(getReportStore(LOCAL_TENANT)).toBeInstanceOf(FsReportStore);
  });

  test("postgres builds a database store per org; a run's scope is its tenant's org", async () => {
    const db = await migratedDatabase();
    setDatabase(db);
    process.env.STORE_BACKEND = "postgres";
    const local = getReportStore(LOCAL_TENANT);
    expect(local).toBeInstanceOf(PgReportStore);
    expect(getReportStore(LOCAL_TENANT)).toBe(local);
    expect(getReportStore(acme)).not.toBe(local);
    await local.writeReport("camp", '{"assets":[]}');
    await expect(getReportStore(LOCAL_TENANT).readReport("camp")).resolves.toEqual({ assets: [] });
    await db.end();
  });
});
