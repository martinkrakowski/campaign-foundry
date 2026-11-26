import { describe, test, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  InMemoryObjectStore,
  PublicAdMediaStore,
} from "@campaignfoundry/CampaignOrchestration/infrastructure";
import type { PublicAdMediaPort } from "@campaignfoundry/CampaignOrchestration";
import handler from "../[id]/clips/[hash].delete.js";
import {
  setPublicAdMediaClient,
  resetPublicAdMediaClient,
} from "../../../lib/object-store/index.js";
import { PgPublishedClipStore } from "../../../lib/ports/pg-published-clip-store.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import {
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  type TenantContext,
  type WebCaller,
} from "../../__tests__/tenant-harness.js";

const owner: TenantContext = {
  orgId: "local",
  userId: "owner",
  roles: ["owner"],
  teamIds: [],
};
const teamlessMember: TenantContext = {
  orgId: "local",
  userId: "m1",
  roles: ["member"],
  teamIds: [],
};

const BYTES = new Uint8Array([1, 2, 3, 4]);

/** Every `PUBLIC_MEDIA_*` variable, the set `publicAdMediaClient()` builds from. */
const PUBLIC_MEDIA_VARS = [
  "PUBLIC_MEDIA_BUCKET",
  "PUBLIC_MEDIA_BASE_URL",
  "PUBLIC_MEDIA_ACCESS_KEY_ID",
  "PUBLIC_MEDIA_SECRET_ACCESS_KEY",
  "PUBLIC_MEDIA_ENDPOINT",
  "PUBLIC_MEDIA_REGION",
] as const;

/** Delete every `PUBLIC_MEDIA_*` variable, returning their prior values. */
function clearPublicMediaEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const name of PUBLIC_MEDIA_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  return saved;
}

/** Restore the values `clearPublicMediaEnv` returned. */
function restorePublicMediaEnv(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function mount(tenant: TenantContext = owner): WebCaller {
  return mountTenantRoute(handler, {
    method: "delete",
    path: "/campaigns/:id/clips/:hash",
    tenant,
  });
}

function del(call: WebCaller, id: string, hash: string): Promise<Response> {
  return call(new Request(`http://x/campaigns/${id}/clips/${hash}`, { method: "DELETE" }));
}

async function seedTeam(db: SqlClient, id: string, name: string): Promise<void> {
  await db.query(
    `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
    [id, name, "local"],
  );
}

async function seedCampaign(
  db: SqlClient,
  orgId: string,
  slug: string,
  opts: { teamId?: string | null; tombstoned?: boolean } = {},
): Promise<{ id: string; slug: string }> {
  const { rows } = await db.query<{ id: string; slug: string }>(
    `insert into campaign (org_id, slug, team_id, deleted_at)
       values ($1, $2, $3, $4) returning id, slug`,
    [orgId, slug, opts.teamId ?? null, opts.tombstoned ? new Date() : null],
  );
  return { id: rows[0]!.id, slug: rows[0]!.slug };
}

async function clipCount(db: SqlClient, orgId: string, campaignId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from published_clip where org_id = $1 and campaign_id = $2::uuid`,
    [orgId, campaignId],
  );
  return rows[0]!.n;
}

afterEach(() => {
  resetPublicAdMediaClient();
});

describe("DELETE /campaigns/:id/clips/:hash (PT-4k)", () => {
  test("returns 400 for malformed campaign id", async () => {
    const harness = await setupPgHarness();
    try {
      const res = await del(mount(), "Not A Safe Id!", "a".repeat(64));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("returns 400 for invalid clip hash", async () => {
    const harness = await setupPgHarness();
    try {
      const campaign = await seedCampaign(harness.db, "local", "hash-refusal");
      for (const bad of ["nothex", `${"a".repeat(63)}`, `${"A".repeat(64)}`]) {
        const res = await del(mount(), campaign.id, bad);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid clip hash." });
      }
      // Not even a row lookup happened: the campaign survives untouched.
      expect(await clipCount(harness.db, "local", campaign.id)).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("returns identical 404 for missing, cross-org, hidden, and tombstoned campaigns", async () => {
    const harness = await setupPgHarness();
    try {
      await seedTeam(harness.db, "t1", "Team One");
      const hash = "b".repeat(64);
      const missing = await del(mount(), randomUUID(), hash);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "Not found." });

      await harness.db.query("insert into org (id, name) values ($1, $2)", ["other", "Other"]);
      const foreign = await seedCampaign(harness.db, "other", "foreign-camp");
      const crossOrg = await del(mount(), foreign.id, hash);
      expect(crossOrg.status).toBe(404);
      expect(await crossOrg.json()).toEqual({ error: "Not found." });

      await seedCampaign(harness.db, "local", "hidden-camp", { teamId: "t1" });
      const hidden = await del(mount(teamlessMember), "hidden-camp", hash);
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual({ error: "Not found." });

      const gone = await seedCampaign(harness.db, "local", "gone-camp", { tombstoned: true });
      const tombstoned = await del(mount(), gone.id, hash);
      expect(tombstoned.status).toBe(404);
      expect(await tombstoned.json()).toEqual({ error: "Not found." });
    } finally {
      await harness.cleanup();
    }
  });

  test("returns identical 404 for unknown hash", async () => {
    const harness = await setupPgHarness();
    try {
      const campaign = await seedCampaign(harness.db, "local", "unknown-hash");
      const res = await del(mount(), campaign.id, "c".repeat(64));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found." });
    } finally {
      await harness.cleanup();
    }
  });

  test("unpublishes the public object and the published_clip row, answering 204", async () => {
    const harness = await setupPgHarness();
    try {
      const campaign = await seedCampaign(harness.db, "local", "unpublish-me");
      const hash = "d".repeat(64);
      const publicStore = new InMemoryObjectStore();
      const media = new PublicAdMediaStore({ store: publicStore, baseUrl: "https://media.test" });
      setPublicAdMediaClient(media);
      const published = await media.publish("local", BYTES, hash);
      await new PgPublishedClipStore(harness.db).record(
        "local",
        campaign.id,
        published.key,
        published.url,
        hash,
      );
      expect(await publicStore.list("local/")).toHaveLength(1);
      expect(await clipCount(harness.db, "local", campaign.id)).toBe(1);

      const res = await del(mount(), campaign.id, hash);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");

      expect(await publicStore.list("local/")).toHaveLength(0);
      expect(await clipCount(harness.db, "local", campaign.id)).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("returns 500 with fixed body when public media is unconfigured or store fails", async () => {
    const harness = await setupPgHarness();
    // The "unconfigured" branch below assumes no public-media settings: with
    // `PUBLIC_MEDIA_*` left in the environment the env-backed client would be
    // built and attempt a real removal. Clear them and restore after.
    const savedEnv = clearPublicMediaEnv();
    try {
      const campaign = await seedCampaign(harness.db, "local", "unconfigured");
      const hash = "e".repeat(64);
      // The clip exists in the ledger; only the unpublish step can fail.
      await harness.db.query(
        `insert into published_clip (org_id, campaign_id, content_hash, key, url)
           values ('local', $1::uuid, $2, $3, $4)`,
        [
          campaign.id,
          hash,
          `local/${"a".repeat(32)}/${hash}.mp4`,
          `https://media.test/${hash}.mp4`,
        ],
      );

      // No PUBLIC_MEDIA_* settings: the ledger row exists, the unpublish is
      // refused, and the response names nothing about the configuration.
      resetPublicAdMediaClient();
      const unconfigured = await del(mount(), campaign.id, hash);
      expect(unconfigured.status).toBe(500);
      expect(await unconfigured.json()).toEqual({ error: "Failed to unpublish clip." });
      expect(await clipCount(harness.db, "local", campaign.id)).toBe(1);

      // A configured client whose object removal throws: the SAME fixed body,
      // never the adapter's error text.
      const failing: PublicAdMediaPort = {
        publish: async () => {
          throw new Error("not used here");
        },
        remove: async () => {
          throw new Error("boom");
        },
        removeOrg: async () => {
          throw new Error("boom");
        },
        urlFor: (key) => `https://media.test/${key}`,
        listPages: async function* () {},
      };
      setPublicAdMediaClient(failing);
      const failingRes = await del(mount(), campaign.id, hash);
      expect(failingRes.status).toBe(500);
      expect(await failingRes.json()).toEqual({ error: "Failed to unpublish clip." });
      // The record stays: the object removal failed first, retryable.
      expect(await clipCount(harness.db, "local", campaign.id)).toBe(1);
    } finally {
      restorePublicMediaEnv(savedEnv);
      await harness.cleanup();
    }
  });

  test("answers the same 404 on the file backend without touching database()", async () => {
    const harness = await setupFsHarness();
    try {
      // On `fs`, `database()` would throw "DATABASE_URL is not set." — a 500.
      // The identical 404 proves the backend check answers first.
      const res = await del(mount(), "some-campaign", "f".repeat(64));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found." });
    } finally {
      harness.cleanup();
    }
  });
});
