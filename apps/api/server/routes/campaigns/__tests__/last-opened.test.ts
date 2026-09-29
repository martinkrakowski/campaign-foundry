import { describe, test, expect } from "vitest";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { TenantContext } from "../../../lib/tenant.js";
import { SYMLINK_WRITE_ERROR } from "../../../lib/brief-files.js";
import {
  getBriefStore,
  getLastOpenedStore,
  resetLastOpenedStore,
  setLastOpenedStore,
  type LastOpenedStorePort,
} from "../../../lib/ports/index.js";
import createHandler from "../index.post.js";
import campaignGetHandler from "../[id].get.js";
import lastOpenedGetHandler from "../last-opened.get.js";
import lastOpenedPutHandler from "../last-opened.put.js";
import {
  ACME_TENANT,
  LOCAL_TENANT,
  mountTenantApp,
  setupFsHarness,
  setupPgHarness,
} from "../../__tests__/tenant-harness.js";

type Harness =
  | Awaited<ReturnType<typeof setupFsHarness>>
  | Awaited<ReturnType<typeof setupPgHarness>>;

/**
 * `last-opened` is a static route segment beside `[id]` (item 0's reservation
 * is what makes that safe). Both are mounted here, in the order Nitro resolves
 * them, so every test below proves the STATIC one answers `/campaigns/last-opened`
 * and that no campaign can be reached through this path.
 */
function mount(tenant: TenantContext | undefined = undefined) {
  const app = mountTenantApp(
    [
      { method: "get", path: "/campaigns/last-opened", handler: lastOpenedGetHandler },
      { method: "put", path: "/campaigns/last-opened", handler: lastOpenedPutHandler },
      { method: "get", path: "/campaigns/:id", handler: campaignGetHandler },
      { method: "post", path: "/campaigns", handler: createHandler },
    ],
    tenant,
  );
  return {
    create: (body: unknown) =>
      app(
        new Request("http://x/campaigns", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    get: () => app(new Request("http://x/campaigns/last-opened")),
    put: (body: unknown) =>
      app(
        new Request("http://x/campaigns/last-opened", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    campaign: (id: string) => app(new Request(`http://x/campaigns/${id}`)),
  };
}

async function mintCampaign(
  api: ReturnType<typeof mount>,
  name: string,
  tenant: TenantContext = LOCAL_TENANT,
): Promise<{ campaignId: string; slug: string }> {
  const res = await mount(tenant).create({ name, type: "social-post" });
  return (await res.json()) as { campaignId: string; slug: string };
}

/** Seed a real `"user"` row per tenant: `member.user_id` is FK'd to it (0008_auth.sql).
 *  `last_opened.user_id` deliberately is NOT (see 0015_last_opened.sql), which is
 *  what the local-auth test in `pg-last-opened-store.test.ts` pins. */
async function seedUsers(harness: Harness, tenants: readonly TenantContext[]): Promise<void> {
  if (harness.backend !== "postgres") return;
  for (const tenant of tenants) {
    await harness.db.query(
      'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $1, $2, true, now(), now()) on conflict (id) do nothing',
      [tenant.userId, `${tenant.userId}@example.com`],
    );
  }
}

/** Seed a team a caller is NOT in, so a campaign scoped to it is hidden from them. */
async function seedHiddenTeam(harness: Harness): Promise<void> {
  if (harness.backend !== "postgres") return;
  await harness.db.query(
    `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
    ["t1", "Team One", "local"],
  );
}

describe.each([{ backend: "fs" as const }, { backend: "postgres" as const }])(
  "/campaigns/last-opened — $backend (PT-5e, D173, D180)",
  ({ backend }) => {
    const setup = () => (backend === "fs" ? setupFsHarness() : setupPgHarness());

    test("a user who has opened nothing answers { campaignId: null }", async () => {
      const harness = await setup();
      try {
        const res = await mount().get();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ campaignId: null });
      } finally {
        await harness.cleanup();
      }
    });

    test("a PUT records the pointer and the GET hands it back", async () => {
      const harness = await setup();
      try {
        const api = mount();
        const { campaignId, slug } = await mintCampaign(api, "Pointed At");

        const put = await api.put({ campaignId: slug });
        expect(put.status).toBe(200);
        const putBody = (await put.json()) as { campaignId: string; updatedAt: string };
        // The real id behind the ref, not the string the caller sent: a slug on
        // Postgres still records the uuid, so the pointer survives a rename of
        // nothing and names one campaign, not a name.
        expect(putBody.campaignId).toBe(campaignId);
        expect(putBody.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

        const get = await api.get();
        expect(get.status).toBe(200);
        expect(await get.json()).toEqual({ campaignId });
      } finally {
        await harness.cleanup();
      }
    });

    test("a PUT by campaign uuid records the same pointer as one by slug", async () => {
      const harness = await setup();
      try {
        const api = mount();
        const { campaignId } = await mintCampaign(api, "By Uuid");
        await api.put({ campaignId });
        expect(await api.get().then((r) => r.json())).toEqual({ campaignId });
      } finally {
        await harness.cleanup();
      }
    });

    // The pointer's whole reason to exist (D173): it is per USER, on the
    // server, so it is the same on a reload and on another device. Two users
    // in one org are the cheapest honest proof that it is not a browser-local
    // record wearing a server coat.
    test("two users in one org keep independent pointers", async () => {
      const harness = await setup();
      try {
        const mine: TenantContext = { ...LOCAL_TENANT, userId: "u1" };
        const theirs: TenantContext = { ...LOCAL_TENANT, userId: "u2" };
        const myCampaign = await mintCampaign(mount(), "Mine", mine);
        const theirCampaign = await mintCampaign(mount(), "Theirs", theirs);

        await mount(mine).put({ campaignId: myCampaign.slug });
        await mount(theirs).put({ campaignId: theirCampaign.slug });

        expect(
          await mount(mine)
            .get()
            .then((r) => r.json()),
        ).toEqual({
          campaignId: myCampaign.campaignId,
        });
        expect(
          await mount(theirs)
            .get()
            .then((r) => r.json()),
        ).toEqual({
          campaignId: theirCampaign.campaignId,
        });
      } finally {
        await harness.cleanup();
      }
    });

    test("opening a second campaign moves the pointer", async () => {
      const harness = await setup();
      try {
        const api = mount();
        const first = await mintCampaign(api, "First");
        const second = await mintCampaign(api, "Second");
        await api.put({ campaignId: first.slug });
        await api.put({ campaignId: second.slug });
        expect(await api.get().then((r) => r.json())).toEqual({
          campaignId: second.campaignId,
        });
      } finally {
        await harness.cleanup();
      }
    });

    // A reload is a second request with no memory of the first — the pointer
    // has to be readable by a caller that has just arrived.
    test("the pointer survives a reload: a fresh request, with no prior state, reads it", async () => {
      const harness = await setup();
      try {
        const api = mount();
        const { campaignId, slug } = await mintCampaign(api, "Reload Survivor");
        await api.put({ campaignId: slug });
        // A brand new mount — nothing carried over from the request that wrote
        // it, exactly as a page reload leaves the browser.
        expect(
          await mount()
            .get()
            .then((r) => r.json()),
        ).toEqual({ campaignId });
      } finally {
        await harness.cleanup();
      }
    });

    test("another org's pointer never leaks", async () => {
      const harness = await setup();
      try {
        if (backend === "fs") {
          // On fs each org has its own project root, so the two stores are
          // different directories; the fs-specific shape of that is proved in
          // `fs-last-opened-store.test.ts`. Here the shared property is what
          // matters: acme never sees local's pointer.
          const local = await mintCampaign(mount(LOCAL_TENANT), "Local Only", LOCAL_TENANT);
          await mount(LOCAL_TENANT).put({ campaignId: local.slug });
          expect(
            await mount(ACME_TENANT)
              .get()
              .then((r) => r.json()),
          ).toEqual({
            campaignId: null,
          });
          return;
        }
        const pg = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        await pg.db.query("insert into org (id, name) values ($1, $2) on conflict do nothing", [
          "acme",
          "Acme",
        ]);
        // `member.user_id` really is FK'd to `"user"(id)` (0008_auth.sql), so a
        // membership row needs the user it names to exist first.
        await seedUsers(harness, [ACME_TENANT]);
        await pg.db.query(
          `insert into member (id, org_id, user_id, role, created_at) values ($1, $2, $3, 'owner', now())`,
          ["m1", "acme", "u1"],
        );
        const local = await mintCampaign(mount(LOCAL_TENANT), "Local Only", LOCAL_TENANT);
        const acme = await mintCampaign(mount(ACME_TENANT), "Acme Only", ACME_TENANT);
        await mount(LOCAL_TENANT).put({ campaignId: local.slug });
        await mount(ACME_TENANT).put({ campaignId: acme.slug });

        expect(
          await mount(ACME_TENANT)
            .get()
            .then((r) => r.json()),
        ).toEqual({
          campaignId: acme.campaignId,
        });
        expect(
          await mount(LOCAL_TENANT)
            .get()
            .then((r) => r.json()),
        ).toEqual({
          campaignId: local.campaignId,
        });
      } finally {
        await harness.cleanup();
      }
    });

    describe("item 4: a hidden campaign and a deleted one are the same answer", () => {
      test("a campaign that was deleted answers { campaignId: null }, byte for byte identical to a hidden one", async () => {
        const harness = await setup();
        try {
          const api = mount();
          const deleted = await mintCampaign(api, "Deleted");
          await api.put({ campaignId: deleted.slug });

          if (backend === "postgres") {
            const pg = harness as Awaited<ReturnType<typeof setupPgHarness>>;
            await pg.db.query("delete from campaign where id = $1", [deleted.campaignId]);
          } else {
            // fs has no FK to cascade, so the campaign is removed the way a
            // real deletion removes it there: its own reserved directory goes.
            // The pointer FILE survives (files have no cascade) — which is
            // exactly the case that proves the route, not the store, is what
            // decides a pointer is no longer answerable.
            const fs = harness as ReturnType<typeof setupFsHarness>;
            rmSync(join(fs.projectRoot, "briefs", deleted.slug), { recursive: true, force: true });
            expect(existsSync(join(fs.projectRoot, "state", "last-opened", "local.json"))).toBe(
              true,
            );
          }

          const body = (await api.get().then((r) => r.json())) as { campaignId: null };
          // The very body a user who never opened anything gets — same status,
          // same keys, same null. Anything else (a 404, a `hidden: true`) would
          // disclose that a campaign by that id exists.
          expect(body).toEqual({ campaignId: null });
        } finally {
          await harness.cleanup();
        }
      });

      test("a team-hidden campaign answers the same body as a deleted one", async () => {
        const harness = await setup();
        try {
          if (backend !== "postgres") {
            // fs has no teams (D166 item 5), so hiding is a Postgres-only
            // concept; the fs backend's equivalent — a campaign whose directory
            // is gone — is the test above.
            return;
          }
          await seedHiddenTeam(harness);
          const owner: TenantContext = {
            orgId: "local",
            userId: "owner",
            roles: ["owner"],
            teamIds: [],
          };
          const created = await mount(owner).create({
            name: "Team Only",
            type: "social-post",
            teamId: "t1",
          });
          const { campaignId, slug } = (await created.json()) as {
            campaignId: string;
            slug: string;
          };
          await mount(owner).put({ campaignId: slug });

          const outsider: TenantContext = {
            orgId: "local",
            userId: "outsider",
            roles: [],
            teamIds: ["t-other"],
          };
          const hidden = await mount(outsider).get();
          expect(hidden.status).toBe(200);
          expect(await hidden.json()).toEqual({ campaignId: null });

          // …and the owner, who can still see it, still gets the pointer: the
          // row is per user, not per campaign's visibility.
          expect(
            await mount(owner)
              .get()
              .then((r) => r.json()),
          ).toEqual({ campaignId });
        } finally {
          await harness.cleanup();
        }
      });

      test("a pointer to a campaign that became hidden falls back to the picker, never to a 404", async () => {
        const harness = await setup();
        try {
          if (backend !== "postgres") return;
          await seedHiddenTeam(harness);
          // A member of no team, not an owner: only D166's own visibility rule
          // can hide a campaign from them, which is the point.
          const caller: TenantContext = {
            orgId: "local",
            userId: "caller",
            roles: [],
            teamIds: [],
          };
          const { campaignId, slug } = await mintCampaign(mount(caller), "Later Hidden", caller);
          await mount(caller).put({ campaignId: slug });
          // Assigned to a team this caller is not part of AFTER they opened it
          // — the pointer row survives (the FK cascades on delete only), and
          // the route must still answer "no pointer".
          const pg = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          await pg.db.query("update campaign set team_id = $1 where id = $2", ["t1", campaignId]);

          const body = (await mount(caller)
            .get()
            .then((r) => r.json())) as { campaignId: null };
          expect(body).toEqual({ campaignId: null });
        } finally {
          await harness.cleanup();
        }
      });
    });

    describe("PUT refusals", () => {
      test("a hidden campaign answers 404 and writes nothing", async () => {
        const harness = await setup();
        try {
          if (backend !== "postgres") return;
          await seedHiddenTeam(harness);
          const owner: TenantContext = {
            orgId: "local",
            userId: "owner",
            roles: ["owner"],
            teamIds: [],
          };
          const created = await mount(owner).create({
            name: "Hidden Target",
            type: "social-post",
            teamId: "t1",
          });
          const { slug } = (await created.json()) as { slug: string };
          const outsider: TenantContext = {
            orgId: "local",
            userId: "outsider",
            roles: [],
            teamIds: ["t-other"],
          };

          const res = await mount(outsider).put({ campaignId: slug });
          expect(res.status).toBe(404);
          // Nothing was written: the refusal happens before the store is asked.
          expect(await getLastOpenedStore(outsider).read("outsider")).toBeUndefined();
        } finally {
          await harness.cleanup();
        }
      });

      test("a missing campaign answers 404 with the same body as a hidden one", async () => {
        const harness = await setup();
        try {
          const res = await mount().put({ campaignId: "no-such-campaign" });
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ error: 'Campaign "no-such-campaign" not found.' });
        } finally {
          await harness.cleanup();
        }
      });

      test("a body that is not an object answers 400", async () => {
        const harness = await setup();
        try {
          const app = mountTenantApp(
            [{ method: "put", path: "/campaigns/last-opened", handler: lastOpenedPutHandler }],
            LOCAL_TENANT,
          );
          const res = await app(
            new Request("http://x/campaigns/last-opened", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(["nope"]),
            }),
          );
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: "Body must be an object." });
        } finally {
          await harness.cleanup();
        }
      });

      test("a body with no campaignId answers 400", async () => {
        const harness = await setup();
        try {
          const res = await mount().put({});
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: '"campaignId" is required.' });
        } finally {
          await harness.cleanup();
        }
      });

      test("a campaignId that is not a path-safe slug answers 400", async () => {
        const harness = await setup();
        try {
          const res = await mount().put({ campaignId: "Not Safe" });
          expect(res.status).toBe(400);
          expect((await res.json()).error).toContain("must be a path-safe slug");
        } finally {
          await harness.cleanup();
        }
      });
    });

    // Item 0's other half: the static route really does own this path, and a
    // campaign can never be reached through it. On fs the slug IS the id (D179),
    // so a campaign literally named `last-opened` would have lost its own
    // `GET /campaigns/:id` — which is why the id is reserved.
    test("the static route answers /campaigns/last-opened, not [id]", async () => {
      const harness = await setup();
      try {
        const api = mount();
        const { campaignId, slug } = await mintCampaign(api, "Route Owner");
        await api.put({ campaignId: slug });
        // A campaign-addressed GET of a real slug still reaches [id]…
        const bySlug = await api.campaign(slug);
        expect(bySlug.status).toBe(200);
        // …while this path is the pointer, whatever a campaign is called.
        expect(await api.get().then((r) => r.json())).toEqual({ campaignId });
        // A campaign that wanted this exact name could not have it.
        const clash = await api.create({ name: "Last Opened", type: "social-post" });
        expect(((await clash.json()) as { slug: string }).slug).not.toBe("last-opened");
      } finally {
        await harness.cleanup();
      }
    });

    test("a store failure that is not the symlink refusal is not disguised as a 400", async () => {
      const harness = await setup();
      try {
        const { slug } = await mintCampaign(mount(), "Store Explodes");
        // A real store fault (a dead database, a full disk) is not the
        // symlink refusal, and the route must not dress it as one: only that
        // one refusal is a 400, and everything else keeps propagating.
        const boom = new Error("the database is on fire");
        expect(boom.message).not.toBe(SYMLINK_WRITE_ERROR);
        setLastOpenedStore({
          read: async () => undefined,
          write: async () => {
            throw boom;
          },
        } as LastOpenedStorePort);
        try {
          // h3 turns a thrown handler error into a 500; what matters is that it
          // is NOT the symlink refusal's 400, which would tell the client its
          // campaign was malformed when the store is what failed.
          const res = await mount().put({ campaignId: slug });
          expect(res.status).toBe(500);
          expect(await res.json()).not.toEqual({ error: SYMLINK_WRITE_ERROR });
        } finally {
          resetLastOpenedStore();
        }
      } finally {
        await harness.cleanup();
      }
    });

    if (backend === "fs") {
      test("a symlinked pointer directory answers 400 and writes nothing", async () => {
        const harness = await setup();
        try {
          const { slug } = await mintCampaign(mount(), "Symlinked");
          const dir = join(harness.projectRoot, "state");
          mkdirSync(dir, { recursive: true });
          symlinkSync(join(harness.projectRoot, "briefs"), join(dir, "last-opened"));

          const res = await mount().put({ campaignId: slug });
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: SYMLINK_WRITE_ERROR });
          // A read through the same symlink is fail-closed, not an error.
          expect(
            await mount()
              .get()
              .then((r) => r.json()),
          ).toEqual({ campaignId: null });
        } finally {
          await harness.cleanup();
        }
      });
    }
  },
);

describe("the fs pointer lives outside briefs/ (PT-5e item 1)", () => {
  test("a campaign's slug can never name a user's pointer file", async () => {
    const harness = setupFsHarness();
    try {
      const { slug } = await mintCampaign(mount(), "Not The Pointer");
      await mount().put({ campaignId: slug });
      const { readdirSync } = await import("node:fs");
      const pointerDir = join(harness.projectRoot, "state", "last-opened");
      expect(existsSync(pointerDir)).toBe(true);
      expect(readdirSync(pointerDir)).toEqual(["local.json"]);
      // The campaign's own reserved directory is untouched by the pointer, and
      // `releaseCampaign`'s teardown can never reach a user's pointer.
      expect(existsSync(join(harness.projectRoot, "briefs", slug))).toBe(true);
      expect(getBriefStore(LOCAL_TENANT)).toBeDefined();
    } finally {
      harness.cleanup();
    }
  });
});
