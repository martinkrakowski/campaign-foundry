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
import { getDraftStore, setDraftStore, resetDraftStore } from "../../../lib/ports/index.js";
import type { DraftStorePort } from "../../../lib/ports/draft-store.port.js";
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
 * Fix round (bots) — `draft.user_id` is plain `text`, not a FK to
 * `"user"(id)` (0014_draft.sql, matching `brief_version.actor`): a real FK
 * broke every draft PUT under `AUTH_MODE=local` (`LOCAL_TENANT.userId`,
 * `"local"`, names no `"user"` row) and blocked deleting a user with a
 * saved draft. This seed is no longer load-bearing for that reason, but
 * still seeds a real `"user"` row before a Postgres-backed draft write —
 * the shape a real deployment (Better Auth) actually has, and what
 * `pg-draft-store.test.ts` and `membership.test.ts` seed by hand for the
 * same reason. A no-op on the fs backend, which has no such table.
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

    // Fix round (bots) — Qodo, real: the latest-draft lookup used to answer
    // the newest row by `updated_at` alone, with no regard for whether its
    // `baseRevision` still matched the campaign's current one. A save
    // landing anywhere leaves the draft it superseded stuck at the top of
    // that ordering forever (nothing else ever touches its `updated_at`),
    // so this route kept re-offering an unrestorable draft for resume on
    // every future call. It now skips a stale candidate — and deletes it,
    // self-cleaning rather than leaving it to hijack every later lookup too
    // — continuing to an older but still-restorable one underneath it.
    test("a stale draft (its save superseded) is skipped and deleted, not offered forever; an older but still-current one underneath it is offered instead", async () => {
      const harness = await setup();
      try {
        const api = mount();
        await seedUsers(harness, [LOCAL_TENANT]);

        // An OLDER draft, on a campaign that stays current — this is what
        // should surface once the newer one goes stale.
        const older = await mintCampaign(api, "Older Current");
        await api.putDraft(older.slug, { state: { x: "older" }, baseRevision: null });

        // A NEWER draft, then a save on that SAME campaign moves its
        // revision out from under the draft.
        const newer = await mintCampaign(api, "Newer Then Saved");
        await api.putDraft(newer.slug, { state: { x: "newer" }, baseRevision: null });
        await api.save(sampleBrief(newer.slug));

        const withOlderUnderneath = (await (await api.latest()).json()) as {
          latest: { campaignId: string } | null;
        };
        expect(withOlderUnderneath.latest?.campaignId).toBe(older.campaignId);

        // Self-cleaned: the stale draft is gone, not just skipped — a
        // second lookup (nothing else changed) does not need to re-derive
        // "still stale" every time, and a direct GET for it answers null.
        const staleDraft = (await (await api.getDraft(newer.slug)).json()) as { draft: unknown };
        expect(staleDraft.draft).toBeNull();

        // With the older one ALSO gone, none of the caller's drafts are
        // restorable any more — never a 404, the same 200 empty body as no
        // draft at all.
        await api.deleteDraft(older.slug);
        expect(await (await api.latest()).json()).toEqual({ latest: null });
      } finally {
        await harness.cleanup();
      }
    });

    // Fix round (bots) — a candidate `listDraftsByRecency` named can still
    // turn up gone by the time `readDraft` actually asks for it (a genuine
    // race: something else deleted it in between). Skipped, same as a
    // hidden campaign or a stale revision, continuing to the next
    // candidate rather than treating it as fatal.
    test("a draft listDraftsByRecency named but readDraft can no longer find (a race) is skipped, not fatal", async () => {
      const harness = await setup();
      try {
        const api = mount();
        await seedUsers(harness, [LOCAL_TENANT]);

        const real = await mintCampaign(api, "Really Has A Draft");
        await api.putDraft(real.slug, { state: { x: 1 }, baseRevision: null });
        // A second, real, VISIBLE campaign that never had a draft written —
        // stands in for "listed, then deleted before the read", without
        // needing a genuinely fabricated campaign id.
        const raced = await mintCampaign(api, "Listed Then Gone");

        // A class instance's methods live on its prototype, not as own
        // enumerable properties — `{ ...store }` would silently drop every
        // one of them. Bind each explicitly instead.
        const store = getDraftStore(LOCAL_TENANT);
        const wrapped: DraftStorePort = {
          readDraft: store.readDraft.bind(store),
          writeDraft: store.writeDraft.bind(store),
          writeDraftIfCurrent: store.writeDraftIfCurrent.bind(store),
          deleteDraft: store.deleteDraft.bind(store),
          async listDraftsByRecency(userId) {
            const list = await store.listDraftsByRecency(userId);
            return [{ campaignId: raced.campaignId, updatedAt: new Date().toISOString() }, ...list];
          },
        };
        setDraftStore(wrapped);
        try {
          const latest = (await (await api.latest()).json()) as {
            latest: { campaignId: string } | null;
          };
          expect(latest.latest?.campaignId).toBe(real.campaignId);
        } finally {
          resetDraftStore();
        }
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
      // Fix round (bots) — Qodo, twice over: `AUTH_MODE=local` names
      // `LOCAL_TENANT.userId = "local"`, and no migration ever seeds a
      // `"user"` row with that id (there is no Better Auth session under
      // local auth to seed one from). Deliberately no `seedUsers` call here
      // — that IS the point: a real FK to `"user"(id)` would refuse this
      // exact write with a 500, which `putServerDraft` swallows client-side,
      // so autosave and resume would silently do nothing for the single
      // most common local dev/ops combination this tool has always served.
      test('a draft PUT for LOCAL_TENANT succeeds on Postgres with no matching "user" row (AUTH_MODE=local has none to seed)', async () => {
        const harness = await setup();
        try {
          const api = mount(LOCAL_TENANT);
          const { slug } = await mintCampaign(api, "Local Auth");
          const res = await api.putDraft(slug, { state: { x: 1 }, baseRevision: null });
          expect(res.status).toBe(200);
          const body = (await api.getDraft(slug).then((r) => r.json())) as {
            draft: { state: unknown };
          };
          expect(body.draft.state).toEqual({ x: 1 });
        } finally {
          await harness.cleanup();
        }
      });

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

      // PT-9a2, D233 r2: the tombstone filter PT-9a1 shipped, through both draft
      // routes' `campaignMeta` gate. Each case is served BEFORE the tombstone and
      // refused after it, so the 404 below cannot be an id that was never a
      // campaign — and the PUT case reads the stored draft back, because a gate
      // that answered 404 after the write would still leave the row changed.
      //
      // The explicit 15000 is not politeness: `setupPgHarness` migrates a whole
      // database, which is over vitest's 5 s default under PGlite (the suite's
      // PGlite pass scopes to these cases by name, `-t "tombstone"`, and they have
      // to run there).
      test("GET /campaigns/:id/draft 404s for a tombstoned campaign", async () => {
        const harness = await setup();
        const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        try {
          const api = mount();
          const { slug } = await mintCampaign(api, "Tombstoned Draft Read");
          expect((await api.save(sampleBrief(slug))).status).toBe(201);
          expect(await (await api.getDraft(slug)).json()).toEqual({ draft: null });

          await pgHarness.db.query(
            `update campaign set deleted_at = now() where org_id = $1 and slug = $2`,
            ["local", slug],
          );

          const res = await api.getDraft(slug);
          expect(res.status).toBe(404);
          // The same body an unknown campaign answers — a deleted campaign cannot
          // be told from one that never existed.
          expect(await res.json()).toEqual({ error: `Campaign "${slug}" not found.` });
        } finally {
          await harness.cleanup();
        }
      }, 15000);

      test("PUT /campaigns/:id/draft 404s for a tombstoned campaign", async () => {
        const harness = await setup();
        const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        try {
          const api = mount();
          const { slug, campaignId } = await mintCampaign(api, "Tombstoned Draft Write");
          const saved = await api.save(sampleBrief(slug));
          expect(saved.status).toBe(201);
          const { revision } = (await saved.json()) as { revision: string };
          expect(
            (await api.putDraft(slug, { state: { v: 1 }, baseRevision: revision })).status,
          ).toBe(200);

          await pgHarness.db.query(
            `update campaign set deleted_at = now() where org_id = $1 and slug = $2`,
            ["local", slug],
          );

          const res = await api.putDraft(slug, { state: { v: 2 }, baseRevision: revision });
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ error: `Campaign "${slug}" not found.` });

          // The gate is `campaignMeta`, which runs BEFORE the body is parsed, so
          // the autosave write never reached the store: what is stored is still
          // what the pre-tombstone PUT wrote.
          const { rows } = await pgHarness.db.query<{ state: unknown }>(
            "select state from draft where campaign_id = $1",
            [campaignId],
          );
          expect(rows[0]!.state).toEqual({ v: 1 });
        } finally {
          await harness.cleanup();
        }
      }, 15000);
    }
  },
);
