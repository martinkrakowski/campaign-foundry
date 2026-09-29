import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { TenantContext } from "../../../lib/tenant.js";
import createHandler from "../index.post.js";
import briefsPostHandler from "../briefs.post.js";
import draftGetHandler from "../[id]/draft.get.js";
import draftPutHandler from "../[id]/draft.put.js";
import draftDeleteHandler from "../[id]/draft.delete.js";
import latestDraftHandler from "../briefs/draft.get.js";
import {
  LOCAL_TENANT,
  mountTenantApp,
  setupFsHarness,
  setupPgHarness,
} from "../../__tests__/tenant-harness.js";

type Harness =
  | Awaited<ReturnType<typeof setupFsHarness>>
  | Awaited<ReturnType<typeof setupPgHarness>>;

/**
 * `draft.user_id` is a genuine FK to `"user"(id)` (0014_draft.sql, unlike
 * `brief_version.actor`'s plain `text`), so a Postgres-backed draft write
 * needs a real row first — the same precondition `pg-draft-store.test.ts`
 * and `membership.test.ts` seed by hand. A no-op on the fs backend, which
 * has no such table.
 */
async function seedUsers(harness: Harness, tenants: readonly TenantContext[]): Promise<void> {
  if (harness.backend !== "postgres") return;
  for (const tenant of tenants) {
    await harness.db.query(
      'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $1, $2, true, now(), now()) on conflict (id) do nothing',
      [tenant.userId, `${tenant.userId}@example.com`],
    );
  }
}

function sampleBrief(id: string): CampaignBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id,
    targetRegion: "US",
    targetAudience: "developers",
    campaignMessage: "Build faster",
    products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  };
}

const jsonReq = (path: string, method: string, body: unknown) =>
  new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function mount(tenant: TenantContext | undefined = undefined) {
  const app = mountTenantApp(
    [
      { method: "post", path: "/campaigns", handler: createHandler },
      { method: "post", path: "/campaigns/briefs", handler: briefsPostHandler },
      { method: "get", path: "/campaigns/:id/draft", handler: draftGetHandler },
      { method: "put", path: "/campaigns/:id/draft", handler: draftPutHandler },
      { method: "delete", path: "/campaigns/:id/draft", handler: draftDeleteHandler },
      { method: "get", path: "/campaigns/briefs/draft", handler: latestDraftHandler },
    ],
    tenant,
  );
  return {
    create: (body: unknown) => app(jsonReq("/campaigns", "POST", body)),
    save: (body: unknown) => app(jsonReq("/campaigns/briefs", "POST", body)),
    getDraft: (id: string) => app(new Request(`http://x/campaigns/${id}/draft`)),
    putDraft: (id: string, body: unknown) => app(jsonReq(`/campaigns/${id}/draft`, "PUT", body)),
    deleteDraft: (id: string) =>
      app(new Request(`http://x/campaigns/${id}/draft`, { method: "DELETE" })),
    latest: () => app(new Request("http://x/campaigns/briefs/draft")),
  };
}

async function mintCampaign(
  api: ReturnType<typeof mount>,
  name: string,
): Promise<{ campaignId: string; slug: string }> {
  const res = await api.create({ name, type: "paid-social" });
  return (await res.json()) as { campaignId: string; slug: string };
}

describe.each([{ backend: "fs" as const }, { backend: "postgres" as const }])(
  "campaign draft routes (PT-5d, D173, D177) — $backend",
  ({ backend }) => {
    const setup = () => (backend === "fs" ? setupFsHarness() : setupPgHarness());

    test("a campaign with no draft yet reads as { draft: null }, not 404", async () => {
      const harness = await setup();
      try {
        const api = mount();
        const { slug } = await mintCampaign(api, "No Draft");
        const res = await api.getDraft(slug);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ draft: null });
      } finally {
        await harness.cleanup();
      }
    });

    test("a versionless campaign's draft carries a null base revision, and round-trips its state", async () => {
      const harness = await setup();
      try {
        const api = mount();
        await seedUsers(harness, [LOCAL_TENANT]);
        const { slug } = await mintCampaign(api, "Blank Draft");
        const putRes = await api.putDraft(slug, {
          state: { source: { kind: "new" }, mode: "single" },
          baseRevision: null,
        });
        expect(putRes.status).toBe(200);
        const putBody = (await putRes.json()) as { draft: { baseRevision: string | null } };
        expect(putBody.draft.baseRevision).toBeNull();

        const getRes = await api.getDraft(slug);
        const getBody = (await getRes.json()) as {
          draft: { state: unknown; baseRevision: string | null };
        };
        expect(getBody.draft.state).toEqual({ source: { kind: "new" }, mode: "single" });
        expect(getBody.draft.baseRevision).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });

    test("PUT never calls parseBrief: an arbitrary editor-state blob is accepted as-is", async () => {
      const harness = await setup();
      try {
        const api = mount();
        await seedUsers(harness, [LOCAL_TENANT]);
        const { slug } = await mintCampaign(api, "Opaque State");
        const res = await api.putDraft(slug, {
          state: { notABrief: true, nested: { anything: [1, 2, 3] } },
          baseRevision: null,
        });
        expect(res.status).toBe(200);
      } finally {
        await harness.cleanup();
      }
    });

    test("a PUT whose base revision matches the campaign's current one succeeds", async () => {
      const harness = await setup();
      try {
        const api = mount();
        await seedUsers(harness, [LOCAL_TENANT]);
        const { slug } = await mintCampaign(api, "Versioned");
        const saveRes = await api.save(sampleBrief(slug));
        expect(saveRes.status).toBe(201);
        const { revision } = (await saveRes.json()) as { revision: string };

        const res = await api.putDraft(slug, { state: { edited: true }, baseRevision: revision });
        expect(res.status).toBe(200);
      } finally {
        await harness.cleanup();
      }
    });

    test("a PUT whose base revision is stale answers 409 and leaves the stored draft", async () => {
      const harness = await setup();
      try {
        const api = mount();
        await seedUsers(harness, [LOCAL_TENANT]);
        const { slug } = await mintCampaign(api, "Stale");
        const saveRes = await api.save(sampleBrief(slug));
        const { revision } = (await saveRes.json()) as { revision: string };

        const first = await api.putDraft(slug, { state: { v: 1 }, baseRevision: revision });
        expect(first.status).toBe(200);

        const stale = await api.putDraft(slug, {
          state: { v: 2 },
          baseRevision: "not-the-real-revision",
        });
        expect(stale.status).toBe(409);

        const getRes = await api.getDraft(slug);
        const body = (await getRes.json()) as { draft: { state: unknown } };
        expect(body.draft.state).toEqual({ v: 1 });
      } finally {
        await harness.cleanup();
      }
    });

    test("DELETE removes the draft, and deleting again is a no-op", async () => {
      const harness = await setup();
      try {
        const api = mount();
        await seedUsers(harness, [LOCAL_TENANT]);
        const { slug } = await mintCampaign(api, "To Delete");
        await api.putDraft(slug, { state: { x: 1 }, baseRevision: null });
        const del = await api.deleteDraft(slug);
        expect(del.status).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });

        expect(await (await api.getDraft(slug)).json()).toEqual({ draft: null });

        const again = await api.deleteDraft(slug);
        expect(again.status).toBe(200);
      } finally {
        await harness.cleanup();
      }
    });

    test("two users' drafts on the same campaign are independent", async () => {
      const harness = await setup();
      try {
        const u1: TenantContext = { orgId: "local", userId: "u1", roles: ["owner"], teamIds: [] };
        const u2: TenantContext = { orgId: "local", userId: "u2", roles: ["owner"], teamIds: [] };
        await seedUsers(harness, [u1, u2]);
        const { slug } = await mintCampaign(mount(u1), "Shared Campaign");

        await mount(u1).putDraft(slug, { state: { owner: "u1" }, baseRevision: null });
        await mount(u2).putDraft(slug, { state: { owner: "u2" }, baseRevision: null });

        const u1Draft = (await (await mount(u1).getDraft(slug)).json()) as {
          draft: { state: unknown };
        };
        const u2Draft = (await (await mount(u2).getDraft(slug)).json()) as {
          draft: { state: unknown };
        };
        expect(u1Draft.draft.state).toEqual({ owner: "u1" });
        expect(u2Draft.draft.state).toEqual({ owner: "u2" });
      } finally {
        await harness.cleanup();
      }
    });

    test("the user comes from the session only: a body-supplied userId is ignored", async () => {
      const harness = await setup();
      try {
        const caller: TenantContext = {
          orgId: "local",
          userId: "real-user",
          roles: ["owner"],
          teamIds: [],
        };
        const attacker: TenantContext = {
          orgId: "local",
          userId: "attacker",
          roles: ["owner"],
          teamIds: [],
        };
        await seedUsers(harness, [caller, attacker]);
        const { slug } = await mintCampaign(mount(caller), "Session Only");

        await mount(caller).putDraft(slug, {
          state: { mine: true },
          baseRevision: null,
          userId: "attacker",
        });

        const asAttacker = (await (await mount(attacker).getDraft(slug)).json()) as {
          draft: unknown;
        };
        expect(asAttacker.draft).toBeNull();
        const asCaller = (await (await mount(caller).getDraft(slug)).json()) as {
          draft: { state: unknown };
        };
        expect(asCaller.draft.state).toEqual({ mine: true });
      } finally {
        await harness.cleanup();
      }
    });

    test("another org's draft answers 404, indistinguishable from unknown", async () => {
      const harness = await setup();
      try {
        const local: TenantContext = {
          orgId: "local",
          userId: "u1",
          roles: ["owner"],
          teamIds: [],
        };
        const acme: TenantContext = { orgId: "acme", userId: "u2", roles: ["owner"], teamIds: [] };
        await seedUsers(harness, [local]);
        const { slug } = await mintCampaign(mount(local), "Local Only");
        await mount(local).putDraft(slug, { state: { x: 1 }, baseRevision: null });

        const res = await mount(acme).getDraft(slug);
        expect(res.status).toBe(404);
      } finally {
        await harness.cleanup();
      }
    });

    test("an unknown campaign answers 404 for GET, PUT and DELETE alike", async () => {
      const harness = await setup();
      try {
        const api = mount();
        expect((await api.getDraft("never-created")).status).toBe(404);
        expect(
          (await api.putDraft("never-created", { state: {}, baseRevision: null })).status,
        ).toBe(404);
        expect((await api.deleteDraft("never-created")).status).toBe(404);
      } finally {
        await harness.cleanup();
      }
    });

    test("an unsafe id answers 400, never reaching the store", async () => {
      const harness = await setup();
      try {
        const api = mount();
        expect((await api.getDraft("..%2Fetc")).status).toBe(400);
        expect((await api.putDraft("..%2Fetc", { state: {}, baseRevision: null })).status).toBe(
          400,
        );
        expect((await api.deleteDraft("..%2Fetc")).status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("a malformed PUT body answers 400", async () => {
      const harness = await setup();
      try {
        const api = mount();
        const { slug } = await mintCampaign(api, "Bad Body");
        expect((await api.putDraft(slug, null)).status).toBe(400);
        expect((await api.putDraft(slug, [])).status).toBe(400);
        expect((await api.putDraft(slug, { baseRevision: null })).status).toBe(400);
        expect((await api.putDraft(slug, { state: {}, baseRevision: 42 })).status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("latestDraft: none for a fresh user, then the campaign just drafted, invisible to another user", async () => {
      const harness = await setup();
      try {
        const api = mount();
        await seedUsers(harness, [LOCAL_TENANT]);
        expect(await (await api.latest()).json()).toEqual({ latest: null });

        const { slug, campaignId } = await mintCampaign(api, "Resume Me");
        await api.putDraft(slug, { state: { x: 1 }, baseRevision: null });

        const latest = (await (await api.latest()).json()) as {
          latest: { campaignId: string } | null;
        };
        expect(latest.latest?.campaignId).toBe(campaignId);

        const other: TenantContext = {
          orgId: "local",
          userId: "someone-else",
          roles: ["owner"],
          teamIds: [],
        };
        expect(await (await mount(other).latest()).json()).toEqual({ latest: null });
      } finally {
        await harness.cleanup();
      }
    });

    if (backend === "fs") {
      test("a symlinked drafts/ directory answers 400, mapping SYMLINK_WRITE_ERROR", async () => {
        const harness = await setup();
        const fsHarness = harness as Awaited<ReturnType<typeof setupFsHarness>>;
        const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
        try {
          const api = mount();
          const { slug } = await mintCampaign(api, "Symlinked Drafts");
          const campaignDir = join(fsHarness.projectRoot, "briefs", slug);
          symlinkSync(outside, join(campaignDir, "drafts"));

          const res = await api.putDraft(slug, { state: { x: 1 }, baseRevision: null });
          expect(res.status).toBe(400);
        } finally {
          rmSync(outside, { recursive: true, force: true });
          await harness.cleanup();
        }
      });

      test("any other write failure propagates unchanged (not mapped to 400)", async () => {
        const harness = await setup();
        try {
          const escaping: TenantContext = {
            orgId: "local",
            // Enough "../" segments to climb past `this.dir` regardless of how
            // deeply the tmp harness nests it — a shallow "../escape" would
            // still resolve inside the campaign directory (harmless), so this
            // is the one shape that actually tests the escape refusal.
            userId: `${"../".repeat(20)}etc/passwd`,
            roles: ["owner"],
            teamIds: [],
          };
          const { slug } = await mintCampaign(mount(escaping), "Escaping User");
          const res = await mount(escaping).putDraft(slug, { state: {}, baseRevision: null });
          expect(res.status).toBe(500);
        } finally {
          await harness.cleanup();
        }
      });
    }

    if (backend === "postgres") {
      test("a TEAM-HIDDEN campaign's draft answers 404, indistinguishable from unknown", async () => {
        const harness = await setup();
        const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        try {
          await pgHarness.db.query(
            `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
            ["t1", "Team One", "local"],
          );
          const owner: TenantContext = {
            orgId: "local",
            userId: "owner",
            roles: ["owner"],
            teamIds: [],
          };
          await seedUsers(pgHarness, [owner]);
          const created = await mount(owner).create({
            name: "Team Only",
            type: "social-post",
            teamId: "t1",
          });
          const { slug } = (await created.json()) as { slug: string };
          await mount(owner).putDraft(slug, { state: { x: 1 }, baseRevision: null });

          const outsider: TenantContext = {
            orgId: "local",
            userId: "outsider",
            roles: [],
            teamIds: ["t-other"],
          };
          const res = await mount(outsider).getDraft(slug);
          expect(res.status).toBe(404);
        } finally {
          await harness.cleanup();
        }
      });

      // Fix round item 1 (grok-4.7): `latestDraft`'s old `limit 1` answered
      // whatever row sorted first by `updated_at`, with no regard for
      // whether campaignMeta still resolves it for this caller — the
      // migration cascades `draft` only on campaign DELETE, never on a team
      // reassignment, so a hidden campaign's draft row survives right where
      // `listDraftsByRecency` would otherwise still find it.
      test("a draft on a campaign that becomes team-hidden answers { latest: null }, identical to no draft — an older visible draft is returned instead", async () => {
        const harness = await setup();
        const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        try {
          await pgHarness.db.query(
            `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
            ["t1", "Team One", "local"],
          );
          const caller: TenantContext = {
            orgId: "local",
            userId: "caller",
            roles: [],
            teamIds: [],
          };
          await seedUsers(pgHarness, [caller]);
          const api = mount(caller);

          const { campaignId: hiddenId, slug: hiddenSlug } = await mintCampaign(
            api,
            "Later Hidden",
          );
          await api.putDraft(hiddenSlug, { state: { x: "hidden" }, baseRevision: null });
          // Assigned to a team this caller is not part of AFTER the draft was
          // taken — D166's own visibility rule now hides it from them, the
          // same as if it had never resolved at all.
          await pgHarness.db.query("update campaign set team_id = $1 where id = $2", [
            "t1",
            hiddenId,
          ]);

          const onlyHidden = (await (await api.latest()).json()) as { latest: unknown };
          expect(onlyHidden).toEqual({ latest: null });

          // An older draft, on a campaign that stays visible — once it
          // exists, IT is the answer, not the newer-but-hidden one, and
          // never a 404 either way.
          const { campaignId: olderId, slug: olderSlug } = await mintCampaign(api, "Older Visible");
          await api.putDraft(olderSlug, { state: { x: "older" }, baseRevision: null });
          await pgHarness.db.query(
            "update draft set updated_at = now() - interval '1 hour' where campaign_id = $1",
            [olderId],
          );

          const withOlder = (await (await api.latest()).json()) as {
            latest: { campaignId: string } | null;
          };
          expect(withOlder.latest?.campaignId).toBe(olderId);
        } finally {
          await harness.cleanup();
        }
      });
    }
  },
);
