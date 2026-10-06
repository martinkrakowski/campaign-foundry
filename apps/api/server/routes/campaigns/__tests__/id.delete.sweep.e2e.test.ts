import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect, vi } from "vitest";
import { listDue } from "../../../lib/deletion/deletion-store.js";
import { getBriefStore } from "../../../lib/ports/index.js";
import {
  ACME_TENANT,
  mountTenantApp,
  resetAllStores,
  setupPgHarness,
  type PgHarness,
  type RouteRegistration,
  type WebCaller,
} from "../../__tests__/tenant-harness.js";
import deleteHandler from "../[id].delete.js";
import assetsPostHandler from "../assets.post.js";
import createHandler from "../index.post.js";

/**
 * The one place this file imports a `bin/` module — deliberately crossing the
 * `server/` → `bin/` boundary to prove the CLI's own claim loop reaches the
 * shipped engines as an integration, not a unit test's stubs. A crossing that
 * `lint:arch` objects to must be reported, NOT worked around by editing
 * `lib/deletion/`.
 */
import { sweep } from "../../../../bin/purge.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ROUTES: RouteRegistration[] = [
  { method: "post", path: "/campaigns", handler: createHandler },
  { method: "post", path: "/campaigns/assets", handler: assetsPostHandler },
  { method: "delete", path: "/campaigns/:id", handler: deleteHandler },
];

test("DELETE /campaigns/:id then the shipped sweep purges the campaign end to end", async () => {
  const savedMode = process.env.OBJECT_STORE;
  const savedGrace = process.env.PURGE_GRACE_HOURS;
  let harness: PgHarness | undefined;
  try {
    delete process.env.OBJECT_STORE;
    delete process.env.PURGE_GRACE_HOURS;
    harness = await setupPgHarness();
    resetAllStores();
    const api: WebCaller = mountTenantApp(ROUTES, ACME_TENANT);

    // 1. POST /campaigns -> 201 { campaignId, slug }
    const created = await api(
      new Request("http://x/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme Campaign", type: "social-post" }),
      }),
    );
    expect(created.status).toBe(201);
    const { campaignId, slug } = (await created.json()) as {
      campaignId: string;
      slug: string;
    };

    // POST /campaigns/assets -> 201
    const asset = await api(
      new Request("http://x/campaigns/assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          briefId: slug,
          name: "logo.png",
          contentBase64: PNG_B64,
        }),
      }),
    );
    expect(asset.status).toBe(201);

    // The fs tree the purge frees exists before delete.
    expect(existsSync(join(harness.projectRoot, "orgs", "acme", "assets", "inputs", slug))).toBe(
      true,
    );

    // 2. DELETE /campaigns/<slug> -> 202 { deletionId }
    const deleted = await api(new Request(`http://x/campaigns/${slug}`, { method: "DELETE" }));
    expect(deleted.status).toBe(202);
    const { deletionId } = (await deleted.json()) as { deletionId: string };

    // Before sweep: the campaign is hidden at once, the deletion row is due.
    expect(await getBriefStore(ACME_TENANT).resolveCampaign(slug)).toBeUndefined();
    const due = await listDue(harness.db);
    expect(due.some((r) => r.subject === campaignId && r.orgId === ACME_TENANT.orgId)).toBe(true);

    // 3. sweep -> { purged: 1, failed: 0 }
    const { purged, failed } = await sweep(harness.db, () => undefined);
    expect(purged).toBe(1);
    expect(failed).toBe(0);

    // 4. After: deletion.purged_at set; campaign row gone; asset rows gone;
    //    input tree freed; a second DELETE by uuid answers 404.
    const purgedRows = await harness.db.query<{ purged_at: Date | null }>(
      `select purged_at from deletion where id = $1`,
      [deletionId],
    );
    expect(purgedRows.rows[0]!.purged_at).not.toBeNull();

    const campCount = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from campaign where org_id = $1 and id = $2`,
      [ACME_TENANT.orgId, campaignId],
    );
    expect(campCount.rows[0]!.n).toBe(0);

    const assetCount = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from asset where org_id = $1 and campaign_id = $2`,
      [ACME_TENANT.orgId, campaignId],
    );
    expect(assetCount.rows[0]!.n).toBe(0);

    expect(existsSync(join(harness.projectRoot, "orgs", "acme", "assets", "inputs", slug))).toBe(
      false,
    );

    const secondDelete = await api(
      new Request(`http://x/campaigns/${campaignId}`, { method: "DELETE" }),
    );
    expect(secondDelete.status).toBe(404);
  } finally {
    vi.restoreAllMocks();
    resetAllStores();
    if (harness) {
      await harness.cleanup();
    }
    if (savedMode === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = savedMode;
    if (savedGrace === undefined) delete process.env.PURGE_GRACE_HOURS;
    else process.env.PURGE_GRACE_HOURS = savedGrace;
  }
}, 60_000);
