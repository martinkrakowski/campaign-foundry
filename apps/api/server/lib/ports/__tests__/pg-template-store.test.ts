import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SqlClient, SqlRows } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplate,
  CanonicalTemplateCollisionError,
  InvalidTemplateError,
  TemplateVersionExistsError,
} from "@campaignfoundry/CampaignOrchestration";
import { PgTemplateStore } from "../pg-template-store.js";
import {
  MAX_TEMPLATES_PER_ORG,
  MAX_VERSIONS_PER_TEMPLATE,
  TemplateLimitExceededError,
} from "../template-store.port.js";

/** A valid org template to save: the canonical image-text seed under a new id. */
function orgTemplate(overrides: Partial<CreativeTemplate> = {}): CreativeTemplate {
  const base = CANONICAL_TEMPLATES["image-text"];
  return { ...base, id: "org-banner", version: 1, name: "Org Banner", ...overrides };
}

/** Insert a template row directly, the way a previous save would have. */
async function seedRow(
  db: SqlClient,
  orgId: string,
  template: CreativeTemplate,
  createdBy = "u1",
): Promise<void> {
  await db.query(
    `insert into template (org_id, id, version, name, unit, creative_type, layers, created_by)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      orgId,
      template.id,
      template.version,
      template.name,
      template.unit,
      template.creativeType,
      JSON.stringify(template.layers),
      createdBy,
    ],
  );
}

/** A row the fake client keeps in memory, mirroring one `template` row. */
interface FakeTemplateRow {
  readonly org: string;
  readonly id: string;
  readonly version: number;
}

/** The gate a test parks the first writer on while a second writer commits. */
interface TestGate {
  /** Resolves when the parked writer reaches the gate. */
  readonly arrived: Promise<void>;
  /** Resolves when the test releases the parked writer. */
  readonly released: Promise<void>;
  /** Resolves `arrived`. */
  arrive(): void;
  /** Resolves `released`. */
  release(): void;
}

/** A one-shot gate: the writer signals `arrived` and parks until `release`. */
function oneShotGate(): TestGate {
  let arrive: () => void = () => undefined;
  let release: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrived, released, arrive, release };
}

/**
 * A `SqlClient` double that keeps rows in memory and evaluates the two
 * statements `saveTemplate` runs: the advisory lock and the capped
 * `INSERT ... SELECT`. Each statement is evaluated against a snapshot taken
 * when the statement STARTS — READ COMMITTED's semantics — so a statement
 * that parks on the gate still counts the rows its snapshot held, and a
 * statement issued after the gate releases counts what committed since.
 * `transaction` runs `work` against the same in-memory client, the way the
 * pg and PGlite adapters hold one connection for the transaction's statements.
 */
function fakeTemplateDb(rows: FakeTemplateRow[], gate?: TestGate): SqlClient {
  let gated = false;
  const client: SqlClient = {
    async query<R = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<SqlRows<R>> {
      // READ COMMITTED takes a statement's snapshot when the statement
      // starts, before it can park on the gate — so capture first, park after.
      const snapshot = [...rows];
      if (gate && !gated) {
        gated = true;
        gate.arrive();
        await gate.released;
      }
      if (text.includes("pg_advisory_xact_lock")) {
        return { rows: [] as R[] };
      }
      if (text.includes("insert into template")) {
        const [org, id, version] = params as [string, string, number];
        const distinctIds = new Set(snapshot.filter((r) => r.org === org).map((r) => r.id)).size;
        const idVersions = snapshot.filter((r) => r.org === org && r.id === id).length;
        if (
          (idVersions > 0 || distinctIds < MAX_TEMPLATES_PER_ORG) &&
          idVersions < MAX_VERSIONS_PER_TEMPLATE
        ) {
          rows.push({ org, id, version });
          return { rows: [{ id }] as R[] };
        }
        return { rows: [] as R[] };
      }
      throw new Error(`fakeTemplateDb cannot execute: ${text}`);
    },
    async transaction<T>(work: (tx: SqlClient) => Promise<T>) {
      return work(client);
    },
    async exec() {
      throw new Error("fakeTemplateDb cannot exec");
    },
    async end() {
      /* nothing to close */
    },
  };
  return client;
}

describe("PgTemplateStore (RW-22)", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query(`insert into org (id, name) values ('acme', 'Acme')`);
  }, 30_000);
  afterEach(async () => {
    await db.end();
  });

  test("listTemplates returns the canonical library plus the org's rows, ordered by id then version", async () => {
    await seedRow(db, "local", orgTemplate({ id: "org-banner", version: 2 }));
    await seedRow(db, "local", orgTemplate({ id: "org-banner", version: 1 }));
    await seedRow(db, "local", orgTemplate({ id: "org-alpha", version: 1 }));

    const store = new PgTemplateStore(db, "local");
    const templates = await store.listTemplates();
    expect(templates.map((t) => `${t.id}:${t.version}`)).toEqual([
      "canonical-image-html:1",
      "canonical-image-text:1",
      "canonical-video:1",
      "org-alpha:1",
      "org-banner:1",
      "org-banner:2",
    ]);
  });

  test("listTemplates sorts the merged list by id then version, not canonical-before-org", async () => {
    // an org id that sorts before every "canonical-..." id
    await seedRow(db, "local", orgTemplate({ id: "aaa-first", version: 1 }));

    const store = new PgTemplateStore(db, "local");
    const templates = await store.listTemplates();
    expect(templates.map((t) => `${t.id}:${t.version}`)).toEqual([
      "aaa-first:1",
      "canonical-image-html:1",
      "canonical-image-text:1",
      "canonical-video:1",
    ]);
  });

  test("mutating a returned canonical template does not change a later read", async () => {
    const store = new PgTemplateStore(db, "local");

    // the return type is readonly; mutate through a local view to prove the clone holds
    const listed = (await store.listTemplates()).find(
      (t) => t.id === "canonical-video",
    )! as unknown as { name: string; layers: unknown[] };
    listed.name = "Mutated";
    listed.layers.length = 0;

    const found = await store.findTemplate("canonical-video");
    expect(found).toEqual(CANONICAL_TEMPLATES.video);
    expect((await store.listTemplates()).find((t) => t.id === "canonical-video")).toEqual(
      CANONICAL_TEMPLATES.video,
    );
  });

  test("findTemplate answers a canonical template first, whatever the org's rows hold", async () => {
    const store = new PgTemplateStore(db, "local");
    expect(await store.findTemplate("canonical-video")).toEqual(CANONICAL_TEMPLATES.video);
    expect(await store.findTemplate("canonical-video", 1)).toEqual(CANONICAL_TEMPLATES.video);
    expect(await store.findTemplate("canonical-video", 99)).toBeUndefined();
  });

  test("findTemplate pins an exact version and answers the highest version without one", async () => {
    await seedRow(db, "local", orgTemplate({ id: "org-banner", version: 2 }));
    await seedRow(db, "local", orgTemplate({ id: "org-banner", version: 1 }));

    const store = new PgTemplateStore(db, "local");
    expect((await store.findTemplate("org-banner"))?.version).toBe(2);
    expect((await store.findTemplate("org-banner", 1))?.version).toBe(1);
    expect(await store.findTemplate("org-banner", 3)).toBeUndefined();
    expect(await store.findTemplate("no-such-template")).toBeUndefined();
    expect(await store.exists("no-such-template")).toBe(false);
    expect(await store.exists("org-banner", 1)).toBe(true);
    expect(await store.exists("org-banner", 3)).toBe(false);
  });

  test("a stored template round-trips: saveTemplate writes a row the reads serve", async () => {
    const store = new PgTemplateStore(db, "local");
    const template = orgTemplate();
    await store.saveTemplate(template, "u1");

    const found = await store.findTemplate("org-banner");
    expect(found).toEqual(template);
    expect(await store.exists("org-banner")).toBe(true);
    const { rows } = await db.query<{ created_by: string }>(
      `select created_by from template where org_id = 'local' and id = 'org-banner'`,
    );
    expect(rows[0]!.created_by).toBe("u1");
  });

  test("an org's templates are invisible to another org, across list, find and exists", async () => {
    await seedRow(db, "local", orgTemplate());
    const local = new PgTemplateStore(db, "local");
    const acme = new PgTemplateStore(db, "acme");

    expect((await local.listTemplates()).map((t) => t.id)).toContain("org-banner");
    expect((await acme.listTemplates()).map((t) => t.id)).not.toContain("org-banner");
    expect(await acme.findTemplate("org-banner")).toBeUndefined();
    expect(await acme.exists("org-banner")).toBe(false);
  });

  test("saveTemplate refuses an invalid template before any SQL runs", async () => {
    const store = new PgTemplateStore(db, "local");
    const invalid = orgTemplate({ layers: [] as unknown as CreativeTemplate["layers"] });
    await expect(store.saveTemplate(invalid, "u1")).rejects.toBeInstanceOf(InvalidTemplateError);

    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from template`);
    expect(rows[0]!.n).toBe(0);
  });

  test("saveTemplate refuses a canonical id collision and writes nothing", async () => {
    const store = new PgTemplateStore(db, "local");
    await expect(
      store.saveTemplate({ ...CANONICAL_TEMPLATES.video, version: 2 }, "u1"),
    ).rejects.toBeInstanceOf(CanonicalTemplateCollisionError);

    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from template`);
    expect(rows[0]!.n).toBe(0);
    expect(await store.findTemplate("canonical-video")).toEqual(CANONICAL_TEMPLATES.video);
  });

  test("saveTemplate refuses a duplicate (org, id, version) and the first row stays byte-identical", async () => {
    const store = new PgTemplateStore(db, "local");
    await store.saveTemplate(orgTemplate(), "u1");
    const { rows: before } = await db.query<{ row: string }>(
      `select t::text as row from template t where id = 'org-banner'`,
    );

    await expect(store.saveTemplate(orgTemplate({ name: "Renamed" }), "u2")).rejects.toBeInstanceOf(
      TemplateVersionExistsError,
    );

    const { rows: after } = await db.query<{ row: string }>(
      `select t::text as row from template t where id = 'org-banner'`,
    );
    expect(after).toEqual(before);
  });

  test("a store error that is NOT the 23505 race rethrows unchanged, not TemplateVersionExistsError", async () => {
    const store = new PgTemplateStore(db, "local");
    // A real pg failure the primary key does not describe — e.g. a lost
    // connection (SQLSTATE 08006). Only 23505 means "the first row already
    // exists"; everything else must reach the caller as itself, out of the
    // advisory-locked transaction the save runs in.
    const failure = Object.assign(new Error("connection refused"), { code: "08006" });
    const originalTransaction = db.transaction.bind(db);
    const seenSql: string[] = [];
    const spy = vi.spyOn(db, "transaction").mockImplementation((work) =>
      originalTransaction((tx) => {
        let calls = 0;
        const wrapped: typeof tx = {
          ...tx,
          query: (<R>(text: string, params?: readonly unknown[]) => {
            seenSql.push(text);
            calls += 1;
            if (calls === 1) return Promise.reject(failure);
            return tx.query<R>(text, params);
          }) as typeof tx.query,
        };
        return work(wrapped);
      }),
    );

    try {
      await expect(store.saveTemplate(orgTemplate(), "u1")).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
    // The first statement inside the transaction failed, and nothing else
    // ran: one statement issued, none of them an insert that committed.
    expect(seenSql).toHaveLength(1);
  });

  test("saveTemplate maps every 23505 error shape to TemplateVersionExistsError and rethrows the rest unchanged", async () => {
    // Every shape an error can take when the insert rejects: pg attaches
    // SQLSTATE as a string, but the mapping must survive a non-object, null,
    // a missing `code`, an `undefined` one, and a numeric one (String(23505)).
    const failures: Array<{ failure: unknown; exists: boolean }> = [
      { failure: "constraint failed", exists: false },
      { failure: null, exists: false },
      { failure: new Error("no code"), exists: false },
      { failure: Object.assign(new Error("code undefined"), { code: undefined }), exists: false },
      { failure: Object.assign(new Error("numeric sqlstate"), { code: 23505 }), exists: true },
      { failure: Object.assign(new Error("string sqlstate"), { code: "23505" }), exists: true },
    ];
    for (const { failure, exists } of failures) {
      const fake = {
        query: vi.fn().mockRejectedValue(failure),
      } as unknown as SqlClient;
      const store = new PgTemplateStore(fake, "local");

      const thrown = await store.saveTemplate(orgTemplate(), "u1").then(
        () => {
          throw new Error("saveTemplate should have rejected");
        },
        (error: unknown) => error,
      );
      if (exists) {
        expect(thrown, `expected TemplateVersionExistsError for ${String(failure)}`).toBeInstanceOf(
          TemplateVersionExistsError,
        );
      } else {
        expect(thrown, `expected the same error for ${String(failure)}`).toBe(failure);
      }
    }
  });

  test("the same id and version in two orgs are independent rows", async () => {
    const store = new PgTemplateStore(db, "local");
    await store.saveTemplate(orgTemplate(), "u1");
    const acme = new PgTemplateStore(db, "acme");
    await acme.saveTemplate(orgTemplate({ name: "Acme Banner" }), "u2");

    expect((await store.findTemplate("org-banner"))?.name).toBe("Org Banner");
    expect((await acme.findTemplate("org-banner"))?.name).toBe("Acme Banner");
  });

  test("skips malformed stored rows in listTemplates and reports skipped count while findTemplate still throws", async () => {
    await seedRow(db, "local", orgTemplate());
    await db.query(`update template set layers = '"not-an-array"'::jsonb where id = 'org-banner'`);

    const store = new PgTemplateStore(db, "local");
    await expect(store.findTemplate("org-banner")).rejects.toBeInstanceOf(InvalidTemplateError);
    await expect(store.exists("org-banner")).rejects.toBeInstanceOf(InvalidTemplateError);

    // The read no longer throws: the bad row is skipped and COUNTED — a
    // number, never the row's content — and the valid templates plus the
    // canonical library are still served.
    const listed = await store.listTemplates();
    expect(listed.map((t) => t.id)).toEqual([
      "canonical-image-html",
      "canonical-image-text",
      "canonical-video",
    ]);

    const page = await store.listTemplatesPage();
    expect(page.skipped).toBe(1);
    expect(page.templates.map((t) => t.id)).toEqual([
      "canonical-image-html",
      "canonical-image-text",
      "canonical-video",
    ]);
    expect(JSON.stringify(page)).not.toContain("not-an-array");
  });

  test("listTemplatesPage without a limit returns every merged template with nextCursor undefined", async () => {
    await seedRow(db, "local", orgTemplate({ id: "org-banner", version: 2 }));
    await seedRow(db, "local", orgTemplate({ id: "org-banner", version: 1 }));
    await seedRow(db, "local", orgTemplate({ id: "org-alpha", version: 1 }));

    const store = new PgTemplateStore(db, "local");
    const page = await store.listTemplatesPage();
    expect(page.templates.map((t) => `${t.id}:${t.version}`)).toEqual([
      "canonical-image-html:1",
      "canonical-image-text:1",
      "canonical-video:1",
      "org-alpha:1",
      "org-banner:1",
      "org-banner:2",
    ]);
    expect(page.skipped).toBe(0);
    expect(page.nextCursor).toBeUndefined();
  });

  test("listTemplatesPage paginates in byIdThenVersion order through cursor and nextCursor", async () => {
    await seedRow(db, "local", orgTemplate({ id: "org-banner", version: 1 }));
    await seedRow(db, "local", orgTemplate({ id: "org-banner", version: 2 }));
    const store = new PgTemplateStore(db, "local");

    const first = await store.listTemplatesPage({ limit: 2 });
    expect(first.templates.map((t) => `${t.id}:${t.version}`)).toEqual([
      "canonical-image-html:1",
      "canonical-image-text:1",
    ]);
    expect(first.nextCursor).toBeDefined();

    const second = await store.listTemplatesPage({ limit: 2, cursor: first.nextCursor });
    expect(second.templates.map((t) => `${t.id}:${t.version}`)).toEqual([
      "canonical-video:1",
      "org-banner:1",
    ]);
    expect(second.nextCursor).toBeDefined();

    const third = await store.listTemplatesPage({ limit: 2, cursor: second.nextCursor });
    expect(third.templates.map((t) => `${t.id}:${t.version}`)).toEqual(["org-banner:2"]);
    expect(third.nextCursor).toBeUndefined();
  });

  test("refuses saving a new template id once MAX_TEMPLATES_PER_ORG is reached, isolated per org", async () => {
    for (let i = 0; i < MAX_TEMPLATES_PER_ORG; i += 1) {
      await seedRow(db, "local", orgTemplate({ id: `org-cap-${i}`, version: 1 }));
    }
    const store = new PgTemplateStore(db, "local");
    await expect(
      store.saveTemplate(orgTemplate({ id: "org-cap-new" }), "u1"),
    ).rejects.toBeInstanceOf(TemplateLimitExceededError);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from template where org_id = 'local' and id = 'org-cap-new'`,
    );
    expect(rows[0]!.n).toBe(0);

    // A new VERSION of an existing id is not blocked by the distinct-id cap.
    await store.saveTemplate(orgTemplate({ id: "org-cap-0", version: 2 }), "u1");
    expect(await store.exists("org-cap-0", 2)).toBe(true);

    // Another org's rows never count against this org's cap: local's full
    // library leaves acme free to save the very same new id.
    const acme = new PgTemplateStore(db, "acme");
    await acme.saveTemplate(orgTemplate({ id: "org-cap-new" }), "u2");
    expect(await acme.exists("org-cap-new")).toBe(true);
  });

  test("refuses saving a new version once MAX_VERSIONS_PER_TEMPLATE is reached, without blocking other orgs", async () => {
    for (let v = 1; v <= MAX_VERSIONS_PER_TEMPLATE; v += 1) {
      await seedRow(db, "local", orgTemplate({ version: v }));
    }
    const store = new PgTemplateStore(db, "local");
    await expect(
      store.saveTemplate(orgTemplate({ version: MAX_VERSIONS_PER_TEMPLATE + 1 }), "u1"),
    ).rejects.toBeInstanceOf(TemplateLimitExceededError);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from template where org_id = 'local' and id = 'org-banner'`,
    );
    expect(rows[0]!.n).toBe(MAX_VERSIONS_PER_TEMPLATE);

    // The version cap is per template id: a different id in the same org
    // still saves.
    await store.saveTemplate(orgTemplate({ id: "org-other" }), "u1");
    expect(await store.exists("org-other")).toBe(true);

    // And another org holds its own versions of the same id, uncapped by
    // this org's row count.
    const acme = new PgTemplateStore(db, "acme");
    await acme.saveTemplate(orgTemplate({ name: "Acme Banner" }), "u2");
    expect(await acme.exists("org-banner")).toBe(true);
  });

  test("concurrent saves of different versions of the same id cannot overshoot the version cap", async () => {
    // Two writers saving DIFFERENT versions of the SAME id at cap - 1 do not
    // race the primary key (each inserts a distinct (org, id, version) row),
    // so only the per-template advisory lock closes this: the second writer's
    // capped INSERT runs as its own statement AFTER the incumbent committed,
    // recounts on a fresh statement snapshot, and refuses.
    const rows: FakeTemplateRow[] = [];
    for (let v = 1; v < MAX_VERSIONS_PER_TEMPLATE; v += 1) {
      rows.push({ org: "local", id: "org-banner", version: v });
    }
    const gate = oneShotGate();
    const db = fakeTemplateDb(rows, gate);
    const store = new PgTemplateStore(db, "local");

    // The first writer enters, takes the lock, and parks inside its
    // transaction; the second writer saves a different version to completion
    // under the parked lock, exactly the interleaving READ COMMITTED allows.
    const first = store.saveTemplate(orgTemplate({ version: MAX_VERSIONS_PER_TEMPLATE }), "u1");
    await gate.arrived;
    await store.saveTemplate(orgTemplate({ version: MAX_VERSIONS_PER_TEMPLATE + 1 }), "u1");
    gate.release();

    await expect(first).rejects.toBeInstanceOf(TemplateLimitExceededError);
    expect(rows.filter((r) => r.id === "org-banner")).toHaveLength(MAX_VERSIONS_PER_TEMPLATE);
  });

  test("sequential saves at cap - 1: the first of two new versions admits, the second refuses", async () => {
    // Not a concurrency test: PGlite is a single connection, so the two saves
    // serialize on the connection itself and nothing here can race. The
    // two-connection proof that concurrent saves admit exactly one lives in
    // pg-template-store.concurrency.test.ts, against a real server.
    const store = new PgTemplateStore(db, "local");
    for (let v = 1; v < MAX_VERSIONS_PER_TEMPLATE; v += 1) {
      await seedRow(db, "local", orgTemplate({ version: v }));
    }

    const [ok, refused] = await Promise.allSettled([
      store.saveTemplate(orgTemplate({ version: MAX_VERSIONS_PER_TEMPLATE }), "u1"),
      store.saveTemplate(orgTemplate({ version: MAX_VERSIONS_PER_TEMPLATE + 1 }), "u1"),
    ]);
    expect(ok.status).toBe("fulfilled");
    expect(refused.status).toBe("rejected");
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(TemplateLimitExceededError);

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from template where org_id = 'local' and id = 'org-banner'`,
    );
    expect(rows[0]!.n).toBe(MAX_VERSIONS_PER_TEMPLATE);
  });

  test("canonical templates do not count against the per-org cap", async () => {
    for (let i = 0; i < MAX_TEMPLATES_PER_ORG - 1; i += 1) {
      await seedRow(db, "local", orgTemplate({ id: `org-cap-${i}`, version: 1 }));
    }
    const store = new PgTemplateStore(db, "local");
    // One org row short of the cap, plus the three ownerless canonical
    // templates: the 50th ORG id still saves — the cap counts only this
    // org's own rows, never the in-memory library.
    await store.saveTemplate(orgTemplate({ id: "org-cap-last" }), "u1");
    expect(await store.exists("org-cap-last")).toBe(true);

    await expect(
      store.saveTemplate(orgTemplate({ id: "org-cap-over" }), "u1"),
    ).rejects.toBeInstanceOf(TemplateLimitExceededError);
  });
});
