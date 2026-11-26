import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CANONICAL_TEMPLATES,
  type BriefTemplate,
  type CreativeTemplate,
} from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../db/sql-client.js";
import { migratedDatabase } from "../db/__tests__/pglite-client.js";
import { PgTemplateStore } from "../ports/pg-template-store.js";
import { setTemplateStore, resetTemplateStore } from "../ports/index.js";
import { LOCAL_TENANT, type TenantContext } from "../tenant.js";
import { PinnedTemplateError, resolvePinnedOrgTemplate } from "../pinned-template.js";

const TEMPLATE_ID = "tpl-123e4567-e89b-42d3-a456-426614174000";

const acmeTenant: TenantContext = { ...LOCAL_TENANT, orgId: "acme" };

/** A brief pinning an org template id (shape from pinned-template.test.ts, redefined locally). */
const pinned = (over: Record<string, unknown> = {}): BriefTemplate =>
  ({
    id: TEMPLATE_ID,
    version: 1,
    creativeType: "image-text",
    unit: "standard-web",
    layers: CANONICAL_TEMPLATES["image-text"].layers,
    ...over,
  }) as BriefTemplate;

/** A stored template: a canonical seed re-keyed to the test's org template id. */
const storedTemplate = (over: Partial<CreativeTemplate> = {}): CreativeTemplate => {
  const base = CANONICAL_TEMPLATES[over.creativeType === "video" ? "video" : "image-text"];
  return { ...base, id: TEMPLATE_ID, name: "Org Saver's Template", ...over };
};

const seed = async (db: SqlClient, orgId: string, template: CreativeTemplate): Promise<void> => {
  await new PgTemplateStore(db, orgId).saveTemplate(template, "u1");
};

describe("resolvePinnedOrgTemplate on PGlite (RW-22)", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query(`insert into org (id, name) values ('acme', 'Acme')`);
  }, 30_000);
  afterEach(async () => {
    resetTemplateStore();
    await db.end();
  });

  test("org A resolves its own pinned template on PGlite", async () => {
    await seed(db, "local", storedTemplate({ version: 1, creativeType: "image-text" }));
    setTemplateStore(new PgTemplateStore(db, "local"));

    await expect(
      resolvePinnedOrgTemplate(LOCAL_TENANT, pinned({ id: TEMPLATE_ID, version: 1 })),
    ).resolves.toBeUndefined();
  });

  test("org B pinning org A's template id and version throws PinnedTemplateError matching the missing-id template", async () => {
    await seed(db, "local", storedTemplate({ version: 1 }));
    setTemplateStore(new PgTemplateStore(db, "acme"));

    let errCrossOrg: unknown;
    await resolvePinnedOrgTemplate(acmeTenant, pinned({ id: TEMPLATE_ID, version: 1 })).catch(
      (e) => (errCrossOrg = e),
    );
    let errMissing: unknown;
    await resolvePinnedOrgTemplate(
      acmeTenant,
      pinned({ id: "tpl-00000000-0000-4000-8000-000000000000", version: 1 }),
    ).catch((e) => (errMissing = e));

    expect(errCrossOrg).toBeInstanceOf(PinnedTemplateError);
    expect((errCrossOrg as PinnedTemplateError).statusCode).toBe(400);
    expect((errCrossOrg as Error).name).toBe("PinnedTemplateError");
    expect((errCrossOrg as Error).message).toBe(
      `Campaign brief field "template.id" references unknown template "${TEMPLATE_ID}" (version 1).`,
    );
    expect(errMissing).toBeInstanceOf(PinnedTemplateError);
    expect((errMissing as Error).message).toBe(
      `Campaign brief field "template.id" references unknown template "tpl-00000000-0000-4000-8000-000000000000" (version 1).`,
    );
  });

  test("org B pinning a version that only org A has is refused with PinnedTemplateError", async () => {
    await seed(db, "local", storedTemplate({ version: 1 }));
    await seed(db, "local", storedTemplate({ version: 2 }));
    await seed(db, "acme", storedTemplate({ version: 1 }));
    setTemplateStore(new PgTemplateStore(db, "acme"));

    await expect(
      resolvePinnedOrgTemplate(acmeTenant, pinned({ id: TEMPLATE_ID, version: 2 })),
    ).rejects.toThrow(
      new PinnedTemplateError(
        `Campaign brief field "template.id" references unknown template "${TEMPLATE_ID}" (version 2).`,
      ),
    );
  });

  test("org B and org A holding their own rows of the same id resolve only their own version and creativeType", async () => {
    const video = CANONICAL_TEMPLATES.video;
    await seed(db, "local", storedTemplate({ version: 1, creativeType: "video" }));
    await seed(db, "acme", storedTemplate({ version: 1, creativeType: "image-text" }));
    await seed(db, "acme", storedTemplate({ version: 2, creativeType: "image-text" }));

    setTemplateStore(new PgTemplateStore(db, "acme"));
    await expect(
      resolvePinnedOrgTemplate(
        acmeTenant,
        pinned({ id: TEMPLATE_ID, version: 2, creativeType: "image-text" }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolvePinnedOrgTemplate(
        acmeTenant,
        pinned({ id: TEMPLATE_ID, version: 1, creativeType: "image-text" }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolvePinnedOrgTemplate(
        acmeTenant,
        pinned({
          id: TEMPLATE_ID,
          version: 1,
          creativeType: "video",
          unit: video.unit,
          layers: video.layers,
        }),
      ),
    ).rejects.toThrow(PinnedTemplateError);

    setTemplateStore(new PgTemplateStore(db, "local"));
    await expect(
      resolvePinnedOrgTemplate(
        LOCAL_TENANT,
        pinned({
          id: TEMPLATE_ID,
          version: 1,
          creativeType: "video",
          unit: video.unit,
          layers: video.layers,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolvePinnedOrgTemplate(
        LOCAL_TENANT,
        pinned({ id: TEMPLATE_ID, version: 1, creativeType: "image-text" }),
      ),
    ).rejects.toThrow(PinnedTemplateError);
  });
});
