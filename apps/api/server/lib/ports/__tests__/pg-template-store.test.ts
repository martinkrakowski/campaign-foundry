import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplate,
  CanonicalTemplateCollisionError,
  InvalidTemplateError,
  TemplateVersionExistsError,
} from "@campaignfoundry/CampaignOrchestration";
import { PgTemplateStore } from "../pg-template-store.js";

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
    // exists"; everything else must reach the caller as itself.
    const failure = Object.assign(new Error("connection refused"), { code: "08006" });
    const spy = vi.spyOn(db, "query").mockRejectedValueOnce(failure);

    await expect(store.saveTemplate(orgTemplate(), "u1")).rejects.toBe(failure);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("the same id and version in two orgs are independent rows", async () => {
    const store = new PgTemplateStore(db, "local");
    await store.saveTemplate(orgTemplate(), "u1");
    const acme = new PgTemplateStore(db, "acme");
    await acme.saveTemplate(orgTemplate({ name: "Acme Banner" }), "u2");

    expect((await store.findTemplate("org-banner"))?.name).toBe("Org Banner");
    expect((await acme.findTemplate("org-banner"))?.name).toBe("Acme Banner");
  });

  test("a malformed persisted row on read throws InvalidTemplateError, not a corrupt record", async () => {
    await seedRow(db, "local", orgTemplate());
    await db.query(`update template set layers = '"not-an-array"'::jsonb where id = 'org-banner'`);

    const store = new PgTemplateStore(db, "local");
    await expect(store.findTemplate("org-banner")).rejects.toBeInstanceOf(InvalidTemplateError);
    await expect(store.listTemplates()).rejects.toBeInstanceOf(InvalidTemplateError);
    await expect(store.exists("org-banner")).rejects.toBeInstanceOf(InvalidTemplateError);
  });
});
