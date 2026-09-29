import { describe, test, expect, vi } from "vitest";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { TenantContext } from "../../../lib/tenant.js";
import * as loadBrief from "../../../lib/load-brief.js";
import * as pools from "../../../lib/pools.js";
import { InvalidCopyPoolError } from "../../../lib/ports/pool-store.port.js";
import { getAssetStore, getBriefStore, getPoolStore } from "../../../lib/ports/index.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import createHandler from "../index.post.js";
import briefsGetHandler from "../briefs.get.js";
import resultGetHandler from "../result.get.js";
import decisionsGetHandler from "../decisions.get.js";
import assetsGetHandler from "../assets.get.js";
import poolGetHandler from "../pools/[briefId].get.js";
import jobsGetHandler from "../jobs/index.get.js";
import packageGetHandler from "../packages/[campaignId].get.js";
import briefsPostHandler from "../briefs.post.js";
import {
  LOCAL_TENANT,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
} from "../../__tests__/tenant-harness.js";

const t1Member: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };
const t2Member: TenantContext = { orgId: "local", userId: "u2", roles: [], teamIds: ["t2"] };

const createReq = (body: unknown) =>
  new Request("http://x/campaigns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function mount(tenant: TenantContext = LOCAL_TENANT) {
  const createBriefHandler = mountTenantRoute(briefsPostHandler, {
    method: "POST",
    path: "/campaigns/briefs",
    tenant,
  });
  /**
   * PT-5c2: `POST /campaigns/briefs` no longer mints a campaign that does not
   * exist — this suite's own fixtures still seed a SOURCE campaign with one
   * POST straight to `/campaigns/briefs` (what a sourced `POST /campaigns`
   * copies FROM is what these tests pin, not how the source itself got
   * saved), so the wrapper mints the body's `id` first — best-effort: an
   * EEXIST means an earlier step in the same test already reserved or saved
   * it. `req` is cloned to read `id` without consuming the body the real
   * handler still needs to parse.
   */
  const createBrief = async (req: Request): Promise<Response> => {
    try {
      const body = (await req.clone().json()) as { id?: unknown };
      if (typeof body.id === "string") {
        await getBriefStore(tenant)
          .createCampaign(body.id)
          .catch(() => undefined);
      }
    } catch {
      // Not JSON, or no string id — the real handler answers its own 400.
    }
    return createBriefHandler(req);
  };
  return {
    create: mountTenantRoute(createHandler, { method: "POST", path: "/campaigns", tenant }),
    list: mountTenantRoute(briefsGetHandler, { path: "/campaigns/briefs", tenant }),
    result: mountTenantRoute(resultGetHandler, { path: "/campaigns/result", tenant }),
    decisions: mountTenantRoute(decisionsGetHandler, { path: "/campaigns/decisions", tenant }),
    assets: mountTenantRoute(assetsGetHandler, { path: "/campaigns/assets", tenant }),
    pool: mountTenantRoute(poolGetHandler, {
      path: "/campaigns/pools/:briefId",
      tenant,
    }),
    jobs: mountTenantRoute(jobsGetHandler, { path: "/campaigns/jobs", tenant }),
    pkg: mountTenantRoute(packageGetHandler, {
      path: "/campaigns/packages/:campaignId",
      tenant,
    }),
    createBrief,
  };
}

describe.each([{ backend: "fs" as const }, { backend: "postgres" as const }])(
  "POST /campaigns — $backend",
  ({ backend }) => {
    const setup = () => (backend === "fs" ? setupFsHarness() : setupPgHarness());

    test("blank create mints a campaign with no version yet, and answers no revision", async () => {
      const harness = await setup();
      try {
        const { create, list } = mount();
        const res = await create(createReq({ name: "My Campaign", type: "social-post" }));
        expect(res.status).toBe(201);
        const json = (await res.json()) as { campaignId: string; slug: string; revision?: string };
        expect(json.slug).toBe("my-campaign");
        expect(json.campaignId).toBeTruthy();
        expect(json.revision).toBeUndefined();

        if (backend === "fs") {
          expect(existsSync(join(harness.projectRoot, "briefs", "my-campaign"))).toBe(true);
          expect(existsSync(join(harness.projectRoot, "briefs", "my-campaign.yaml"))).toBe(false);
        }

        const listed = await list(new Request("http://x/campaigns/briefs"));
        const listedJson = (await listed.json()) as { briefs: unknown[] };
        expect(listedJson.briefs).toEqual([]);
      } finally {
        await harness.cleanup();
      }
    });

    test("a name that slugifies to empty answers 400", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "!!!" }));
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("a missing name answers 400", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ type: "social-post" }));
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("a non-object body answers 400 rather than throwing", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq(42));
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("an invalid type answers 400", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "Bad Type", type: "nonsense" }));
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("a non-string source answers 400", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "Bad Source", source: 123 }));
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("an empty-string source answers 400", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "Bad Source", source: "" }));
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("a non-string teamId answers 400 before parsing anything else", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "Bad Team", teamId: 42 }));
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("a non-string teamOf answers 400", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "Bad TeamOf", teamOf: 42 }));
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("an empty-string teamOf answers 400", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "Bad TeamOf", teamOf: "" }));
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    test("dedupes against an existing campaign: -2, then -3", async () => {
      const harness = await setup();
      try {
        const { create } = mount();
        const first = await create(createReq({ name: "Same Name" }));
        expect(((await first.json()) as { slug: string }).slug).toBe("same-name");
        const second = await create(createReq({ name: "Same Name" }));
        expect(((await second.json()) as { slug: string }).slug).toBe("same-name-2");
        const third = await create(createReq({ name: "Same Name" }));
        expect(((await third.json()) as { slug: string }).slug).toBe("same-name-3");
      } finally {
        await harness.cleanup();
      }
    });

    test("skips a reserved-word slug and lands on the next suffix", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "Cache" }));
        expect(((await res.json()) as { slug: string }).slug).toBe("cache-2");
      } finally {
        await harness.cleanup();
      }
    });

    // HX1/D181: `templates` is a directory under `routes/campaigns/` (a saved
    // creative template's own route), so a campaign slugged `templates` would
    // shadow it — the same collision `cache` above is reserved to prevent, just
    // via RESERVED_ROUTE_SEGMENTS rather than RESERVED_STORE_AREAS.
    test("a campaign named `Templates` gets a slug other than `templates`", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "Templates" }));
        expect(((await res.json()) as { slug: string }).slug).toBe("templates-2");
      } finally {
        await harness.cleanup();
      }
    });

    // PT-5e item 0: `last-opened` is reserved BEFORE `GET /campaigns/last-opened`
    // exists, because a static route of that name shadows a campaign slugged
    // `last-opened`'s own `GET /campaigns/:id` — and on fs that slug is the
    // campaign's only id (D179), so the shadowing would cost it the route
    // entirely. `slugify("Last Opened")` is exactly `last-opened`, so this is
    // the one realistic way a user reaches the reserved id by accident.
    test("a campaign named `Last Opened` gets a slug other than `last-opened`", async () => {
      const harness = await setup();
      try {
        const { create } = mount();
        const first = await create(createReq({ name: "Last Opened" }));
        const firstBody = (await first.json()) as { campaignId: string; slug: string };
        expect(firstBody.slug).not.toBe("last-opened");
        expect(firstBody.slug).toBe("last-opened-2");

        // …and the campaign it minted is reachable by its own id, which is the
        // property the reservation exists to protect (on fs the slug IS the id).
        const meta = await getBriefStore(LOCAL_TENANT).campaignMeta(firstBody.slug);
        expect(meta?.campaignId).toBe(firstBody.campaignId);
      } finally {
        await harness.cleanup();
      }
    });

    if (backend === "fs") {
      // coderabbit PRRT_kwDOSzP1zc6mgBu7 / qodo PRRT_kwDOSzP1zc6mgEyH:
      // FsBriefStore.createCampaign must see an id living in a differently
      // named file, not just a file named after the slug.
      test("dedupes past a slug already taken by an id in a differently-named file", async () => {
        const harness = await setup();
        try {
          const fsHarness = harness as Awaited<ReturnType<typeof setupFsHarness>>;
          mkdirSync(join(fsHarness.projectRoot, "briefs"), { recursive: true });
          writeFileSync(
            join(fsHarness.projectRoot, "briefs", "sample-campaign.yaml"),
            "id: my-copy\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n",
          );
          const res = await mount().create(createReq({ name: "My Copy" }));
          expect(((await res.json()) as { slug: string }).slug).toBe("my-copy-2");
        } finally {
          await harness.cleanup();
        }
      });
    }

    test("skips a uuid-shaped slug (D178: it would collide with ref resolution)", async () => {
      const harness = await setup();
      try {
        const uuidName = "12345678-1234-1234-1234-123456789012";
        const res = await mount().create(createReq({ name: uuidName }));
        expect(((await res.json()) as { slug: string }).slug).toBe(`${uuidName}-2`);
      } finally {
        await harness.cleanup();
      }
    });

    test("two concurrent creates of the same name never collide on the same slug", async () => {
      const harness = await setup();
      try {
        const { create } = mount();
        const [a, b] = await Promise.all([
          create(createReq({ name: "Racer" })),
          create(createReq({ name: "Racer" })),
        ]);
        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        const slugs = [
          ((await a.json()) as { slug: string }).slug,
          ((await b.json()) as { slug: string }).slug,
        ].sort();
        expect(slugs).toEqual(["racer", "racer-2"]);
      } finally {
        await harness.cleanup();
      }
    });

    test("a second create of the same slug, once it has a version, is still refused", async () => {
      const harness = await setup();
      try {
        const { create, createBrief } = mount();
        const created = await create(createReq({ name: "Versioned" }));
        const { slug } = (await created.json()) as { slug: string };
        await createBrief(
          new Request("http://x/campaigns/briefs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(sampleBrief(slug)),
          }),
        );

        // "Versioned" now dedupes past the versioned slug too.
        const again = await create(createReq({ name: "Versioned" }));
        expect(((await again.json()) as { slug: string }).slug).toBe("versioned-2");
      } finally {
        await harness.cleanup();
      }
    });

    if (backend === "fs") {
      test("teamId answers 400 on the fs backend (teams are Postgres-only)", async () => {
        const harness = await setup();
        try {
          const res = await mount().create(createReq({ name: "Teamed", teamId: "t1" }));
          expect(res.status).toBe(400);
        } finally {
          await harness.cleanup();
        }
      });
    }

    if (backend === "postgres") {
      test("teamId the caller may not assign answers 403, and mints nothing", async () => {
        const harness = await setup();
        try {
          const res = await mount(t1Member).create(createReq({ name: "Teamed", teamId: "t2" }));
          expect(res.status).toBe(403);
        } finally {
          await harness.cleanup();
        }
      });

      test("an unknown teamId answers 403 (EFORBIDDEN), even for an owner", async () => {
        const harness = await setup();
        try {
          const res = await mount().create(createReq({ name: "Teamed", teamId: "ghost" }));
          expect(res.status).toBe(403);
        } finally {
          await harness.cleanup();
        }
      });

      test("teamId the caller belongs to is assigned, and the row exists with no version", async () => {
        const harness = await setup();
        const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        try {
          await pgHarness.db.query(
            `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
            ["t1", "Team One", "local"],
          );
          const res = await mount(t1Member).create(createReq({ name: "Teamed", teamId: "t1" }));
          expect(res.status).toBe(201);
          const { rows } = await pgHarness.db.query<{ team_id: string | null; count: number }>(
            `select c.team_id, (select count(*)::int from brief_version where campaign_id = c.id) as count
               from campaign c where c.org_id = 'local' and c.slug = 'teamed'`,
          );
          expect(rows[0]).toMatchObject({ team_id: "t1", count: 0 });
        } finally {
          await harness.cleanup();
        }
      });

      describe("teamOf (PT-5c2): a blank create inherits another campaign's team", () => {
        test("teamOf from a team-1 source lands the new campaign in team-1", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            await pgHarness.db.query(
              `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
              ["t1", "Team One", "local"],
            );
            const source = await mount(t1Member).create(
              createReq({ name: "Team One Source", teamId: "t1" }),
            );
            const { slug: sourceSlug } = (await source.json()) as { slug: string };

            const res = await mount(t1Member).create(
              createReq({ name: "Copy Of Teamed", teamOf: sourceSlug }),
            );
            expect(res.status).toBe(201);
            const { slug } = (await res.json()) as { slug: string };
            const { rows } = await pgHarness.db.query<{ team_id: string | null }>(
              `select team_id from campaign where org_id = 'local' and slug = $1`,
              [slug],
            );
            expect(rows[0]!.team_id).toBe("t1");
          } finally {
            await harness.cleanup();
          }
        });

        // canAssignTeam rejects an EXPLICIT teamId: null for a non-owner, but
        // teamOf never goes through canAssignTeam — the caller already sees
        // the org-wide source, so inheriting its (lack of a) team is not an
        // assignment.
        test("a non-owner member's Save as of an org-wide source answers 201 and stays org-wide", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            const source = await mount().create(createReq({ name: "Org Wide Source" }));
            const { slug: sourceSlug } = (await source.json()) as { slug: string };

            const res = await mount(t1Member).create(
              createReq({ name: "Copy Of Org Wide", teamOf: sourceSlug }),
            );
            expect(res.status).toBe(201);
            const { slug } = (await res.json()) as { slug: string };
            const { rows } = await pgHarness.db.query<{ team_id: string | null }>(
              `select team_id from campaign where org_id = 'local' and slug = $1`,
              [slug],
            );
            expect(rows[0]!.team_id).toBeNull();
          } finally {
            await harness.cleanup();
          }
        });

        test("a hidden teamOf answers 404 and mints nothing", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            await pgHarness.db.query(
              `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
              ["t1", "Team One", "local"],
            );
            const hidden = await mount(LOCAL_TENANT).create(
              createReq({ name: "Hidden Source", teamId: "t1" }),
            );
            const { slug: hiddenSlug } = (await hidden.json()) as { slug: string };

            const res = await mount(t2Member).create(
              createReq({ name: "Copy Of Hidden", teamOf: hiddenSlug }),
            );
            expect(res.status).toBe(404);
            expect(await res.json()).toEqual({ error: `Brief "${hiddenSlug}" not found.` });

            const { rows } = await pgHarness.db.query(
              `select 1 from campaign where org_id = 'local' and slug = 'copy-of-hidden'`,
            );
            expect(rows).toHaveLength(0);
          } finally {
            await harness.cleanup();
          }
        });

        test("an unexpected resolveCampaign failure for teamOf (not CampaignNotFoundError) surfaces as 500", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            const source = await mount().create(createReq({ name: "Failing Source" }));
            const { slug: sourceSlug } = (await source.json()) as { slug: string };
            const spy = vi
              .spyOn(getBriefStore(LOCAL_TENANT), "resolveCampaign")
              .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
            const res = await mount().create(createReq({ name: "Copy", teamOf: sourceSlug }));
            expect(res.status).toBe(500);
            spy.mockRestore();
            const { rows } = await pgHarness.db.query(
              `select 1 from campaign where org_id = 'local' and slug = 'copy'`,
            );
            expect(rows).toHaveLength(0);
          } finally {
            await harness.cleanup();
          }
        });

        // qodo PRRT_kwDOSzP1zc6m7iqy (High, security): `resolveCampaignRef`
        // and `campaignTeam` are two separate reads — if the source vanishes
        // or becomes hidden between them (a race, or another request), the
        // second read answers `undefined`. That must never fall through to
        // "no team" (org-wide); it must refuse, same as if the ref had never
        // resolved at all.
        test("teamOf's team vanishing between resolve and the team lookup (a race) answers 404, never org-wide", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            await pgHarness.db.query(
              `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
              ["t1", "Team One", "local"],
            );
            const source = await mount(t1Member).create(
              createReq({ name: "Racing Source", teamId: "t1" }),
            );
            const { slug: sourceSlug } = (await source.json()) as { slug: string };
            const spy = vi
              .spyOn(getBriefStore(LOCAL_TENANT), "campaignTeam")
              .mockResolvedValueOnce(undefined);
            const res = await mount().create(createReq({ name: "Copy", teamOf: sourceSlug }));
            expect(res.status).toBe(404);
            expect(await res.json()).toEqual({ error: `Brief "${sourceSlug}" not found.` });
            spy.mockRestore();
            const { rows } = await pgHarness.db.query(
              `select 1 from campaign where org_id = 'local' and slug = 'copy'`,
            );
            expect(rows).toHaveLength(0);
          } finally {
            await harness.cleanup();
          }
        });

        test("an unknown teamOf answers 404 and mints nothing", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            const res = await mount().create(
              createReq({ name: "Copy Of Nothing", teamOf: "no-such-campaign" }),
            );
            expect(res.status).toBe(404);
            const { rows } = await pgHarness.db.query(
              `select 1 from campaign where org_id = 'local' and slug = 'copy-of-nothing'`,
            );
            expect(rows).toHaveLength(0);
          } finally {
            await harness.cleanup();
          }
        });

        test("an explicit teamId wins over teamOf", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            await pgHarness.db.query(
              `insert into team (id, name, "memberCount", org_id, created_at) values
                 ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
              ["t1", "Team One", "local", "t2", "Team Two"],
            );
            const source = await mount(LOCAL_TENANT).create(
              createReq({ name: "Team One Source Again", teamId: "t1" }),
            );
            const { slug: sourceSlug } = (await source.json()) as { slug: string };

            const res = await mount(LOCAL_TENANT).create(
              createReq({ name: "Explicit Wins", teamOf: sourceSlug, teamId: "t2" }),
            );
            expect(res.status).toBe(201);
            const { slug } = (await res.json()) as { slug: string };
            const { rows } = await pgHarness.db.query<{ team_id: string | null }>(
              `select team_id from campaign where org_id = 'local' and slug = $1`,
              [slug],
            );
            expect(rows[0]!.team_id).toBe("t2");
          } finally {
            await harness.cleanup();
          }
        });
      });
    }

    if (backend === "fs") {
      test("teamOf on fs is ignored (D166 item 5), and the create still answers 201", async () => {
        const harness = await setup();
        try {
          const res = await mount().create(
            createReq({ name: "Ignored TeamOf", teamOf: "whatever" }),
          );
          expect(res.status).toBe(201);
        } finally {
          await harness.cleanup();
        }
      });
    }

    test("an unexpected createCampaign failure (not EFORBIDDEN) surfaces as 500", async () => {
      const harness = await setup();
      try {
        const spy = vi
          .spyOn(getBriefStore(LOCAL_TENANT), "createCampaign")
          .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
        const res = await mount().create(createReq({ name: "Broken" }));
        expect(res.status).toBe(500);
        spy.mockRestore();
      } finally {
        await harness.cleanup();
      }
    });

    describe("sourced create (copies the source's latest version as version 1)", () => {
      // PT-5c2: duplicate's own dedupe (`name`, not a literal `newId`) means a
      // failure at duplicate's copyAssets step lands on a candidate slug IT
      // minted (the derived slug dedupes past whatever another request
      // already reserved), so it only ever releases its OWN reservation —
      // never one another request made. That EIO-mid-copy release shape is
      // already covered directly: "a failure at createBrief leaves no listed
      // brief and no dest pool" (briefs.test.ts) and this describe block's
      // own sourced-create race tests below exercise the identical
      // release-on-failure path for `index.post.ts`'s attempt().
      test("mints the campaign, writes version 1, and answers a revision", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );

          const res = await create(createReq({ name: "Copy Of Source", source: "source-camp" }));
          expect(res.status).toBe(201);
          const json = (await res.json()) as { slug: string; revision?: string };
          expect(json.slug).toBe("copy-of-source");
          expect(json.revision).toMatch(/^[a-f0-9]{64}$/);

          const listed = await mount().list(new Request("http://x/campaigns/briefs"));
          const listedJson = (await listed.json()) as { briefs: { brief: { id: string } }[] };
          expect(listedJson.briefs.map((b) => b.brief.id).sort()).toEqual([
            "copy-of-source",
            "source-camp",
          ]);
        } finally {
          await harness.cleanup();
        }
      });

      test("copies the source's pool into the new slug", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          const { getPoolStore } = await import("../../../lib/ports/index.js");
          await getPoolStore(LOCAL_TENANT).writePool({
            briefId: "source-camp",
            generatedAt: new Date().toISOString(),
            model: "test-model",
            entries: [{ id: "e1", text: "Hi there", status: "approved" }],
          });

          const res = await create(createReq({ name: "Copy Of Source", source: "source-camp" }));
          expect(res.status).toBe(201);
          const { slug } = (await res.json()) as { slug: string };
          const copied = await getPoolStore(LOCAL_TENANT).readPool(slug);
          expect(copied?.pool.entries).toEqual([
            { id: "e1", text: "Hi there", status: "approved" },
          ]);
          if (backend === "fs") {
            expect(existsSync(join(harness.projectRoot, "briefs", slug, "pools.json"))).toBe(true);
          }
        } finally {
          await harness.cleanup();
        }
      });

      test("an unexpected parseBrief failure on the re-validated source answers 400", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          const spy = vi.spyOn(loadBrief, "parseBrief").mockImplementationOnce(() => {
            throw new Error("mock: source brief no longer valid");
          });
          const res = await create(createReq({ name: "Copy", source: "source-camp" }));
          expect(res.status).toBe(400);
          spy.mockRestore();
        } finally {
          await harness.cleanup();
        }
      });

      test("an unexpected assertOwnedCampaign failure (not CampaignNotFoundError) surfaces as 500", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          const spy = vi
            .spyOn(getBriefStore(LOCAL_TENANT), "findBriefById")
            .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
          const res = await create(createReq({ name: "Copy", source: "source-camp" }));
          expect(res.status).toBe(500);
          spy.mockRestore();
        } finally {
          await harness.cleanup();
        }
      });

      // withDerivedSlug's retry loop and the outer catch's specific branches
      // (symlink, hidden-source 404, EFORBIDDEN, InvalidCopyPoolError) cover
      // every ANTICIPATED failure inside `attempt`; anything else — a raw
      // storage failure copying assets, here — must still surface as an
      // uncaught 500, never be swallowed as a false 422/404/403.
      test("an unanticipated failure inside attempt (asset copy) surfaces as 500", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          const { getAssetStore } = await import("../../../lib/ports/index.js");
          const spy = vi
            .spyOn(getAssetStore(LOCAL_TENANT), "copyAssets")
            .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
          const res = await create(createReq({ name: "Copy", source: "source-camp" }));
          expect(res.status).toBe(500);
          spy.mockRestore();
        } finally {
          await harness.cleanup();
        }
      });

      // PT-5b2 fix-round item 2 (coderabbit PRRT_kwDOSzP1zc6mgBvA / qodo
      // PRRT_kwDOSzP1zc6mgEyP): a failure AFTER createCampaign reserved the
      // slug must release it — a retry gets the SAME slug, never `-2`, and no
      // versionless row/directory is left behind.
      test("copyAssets failing after reservation releases it: a retry gets the same slug", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          const spy = vi
            .spyOn(getAssetStore(LOCAL_TENANT), "copyAssets")
            .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
          const failed = await create(createReq({ name: "Copy Of Source", source: "source-camp" }));
          expect(failed.status).toBe(500);
          spy.mockRestore();

          expect(await getBriefStore(LOCAL_TENANT).campaignTeam("copy-of-source")).toBeUndefined();

          const retried = await create(
            createReq({ name: "Copy Of Source", source: "source-camp" }),
          );
          expect(retried.status).toBe(201);
          expect(((await retried.json()) as { slug: string }).slug).toBe("copy-of-source");
        } finally {
          await harness.cleanup();
        }
      });

      test("createBrief failing after reservation releases it and the assets already copied", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          const spy = vi
            .spyOn(getBriefStore(LOCAL_TENANT), "createBrief")
            .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
          const failed = await create(createReq({ name: "Copy Of Source", source: "source-camp" }));
          expect(failed.status).toBe(500);
          spy.mockRestore();

          expect(await getBriefStore(LOCAL_TENANT).campaignTeam("copy-of-source")).toBeUndefined();
          expect(await getAssetStore(LOCAL_TENANT).listAssets("copy-of-source")).toEqual([]);

          const retried = await create(
            createReq({ name: "Copy Of Source", source: "source-camp" }),
          );
          expect(retried.status).toBe(201);
          expect(((await retried.json()) as { slug: string }).slug).toBe("copy-of-source");
        } finally {
          await harness.cleanup();
        }
      });

      // PT-5b2 fix-round item 3 (qodo PRRT_kwDOSzP1zc6mgEyM): an EEXIST raised
      // AFTER the reservation held (a concurrent writer's own Save landing
      // version 1 on the SAME slug) must answer 409, never be mistaken for a
      // taken candidate and retried onto "-2" — which would abandon the
      // racing writer's own save silently.
      test("a Save racing between reservation and the first-version write answers 409, not a retry", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          const store = getBriefStore(LOCAL_TENANT);
          const assetStore = getAssetStore(LOCAL_TENANT);
          const originalCopyAssets = assetStore.copyAssets.bind(assetStore);
          const spy = vi
            .spyOn(assetStore, "copyAssets")
            .mockImplementationOnce(async (from: string, to: string) => {
              // Simulate a concurrent writer's own plain Save landing version 1
              // on the reserved slug BEFORE this attempt's own createBrief runs.
              await store.createBrief({ ...sampleBrief(to), campaignMessage: "Racer's own save" });
              return originalCopyAssets(from, to);
            });

          const res = await create(createReq({ name: "Copy Of Source", source: "source-camp" }));
          expect(res.status).toBe(409);
          spy.mockRestore();

          // The racing writer's own version 1 survived untouched, and no
          // second candidate ("-2") was ever minted.
          const raced = await store.findBriefById("copy-of-source");
          expect(raced?.brief.campaignMessage).toBe("Racer's own save");
          expect(await store.campaignTeam("copy-of-source-2")).toBeUndefined();
        } finally {
          await harness.cleanup();
        }
      });

      if (backend === "postgres") {
        test("an unexpected resolveCampaign failure (not CampaignNotFoundError) surfaces as 500", async () => {
          const harness = await setup();
          try {
            const { create, createBrief } = mount();
            await createBrief(
              new Request("http://x/campaigns/briefs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(sampleBrief("source-camp")),
              }),
            );
            const spy = vi
              .spyOn(getBriefStore(LOCAL_TENANT), "resolveCampaign")
              .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
            const res = await create(createReq({ name: "Copy", source: "source-camp" }));
            expect(res.status).toBe(500);
            spy.mockRestore();
          } finally {
            await harness.cleanup();
          }
        });

        test("teamId the caller may not assign on a sourced create answers 403", async () => {
          const harness = await setup();
          try {
            const { create, createBrief } = mount();
            await createBrief(
              new Request("http://x/campaigns/briefs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(sampleBrief("source-camp")),
              }),
            );
            const res = await create(
              createReq({ name: "Copy", source: "source-camp", teamId: "ghost" }),
            );
            expect(res.status).toBe(403);
          } finally {
            await harness.cleanup();
          }
        });

        // qodo PRRT_kwDOSzP1zc6mgEyD (HIGH, security): a sourced create with
        // no explicit teamId must inherit the source's team, not default to
        // org-wide.
        test("with no explicit teamId, inherits the source's team, hidden from another team's member", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            await pgHarness.db.query(
              `insert into team (id, name, "memberCount", org_id, created_at) values
                 ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
              ["t1", "Team One", "local", "t2", "Team Two"],
            );
            const owner = new PgBriefStore(pgHarness.db, "local", "owner", ["owner"], []);
            await owner.createBrief(sampleBrief("source-camp"), { teamId: "t1" });

            const res = await mount(t1Member).create(
              createReq({ name: "Copy Of Teamed", source: "source-camp" }),
            );
            expect(res.status).toBe(201);
            const { slug } = (await res.json()) as { slug: string };

            const { rows } = await pgHarness.db.query<{ team_id: string | null }>(
              `select team_id from campaign where org_id = 'local' and slug = $1`,
              [slug],
            );
            expect(rows[0]!.team_id).toBe("t1");

            const t2Store = new PgBriefStore(pgHarness.db, "local", "u2", [], ["t2"]);
            expect(await t2Store.campaignVisibility(slug)).toBe("hidden");
          } finally {
            await harness.cleanup();
          }
        });

        // The rule's other half: clearing a team-scoped source to org-wide
        // (explicit teamId: null) is an owner/admin action, exactly like
        // canAssignTeam already requires for createBrief.
        test("an explicit teamId: null on a sourced create is refused for a plain member", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            await pgHarness.db.query(
              `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
              ["t1", "Team One", "local"],
            );
            const owner = new PgBriefStore(pgHarness.db, "local", "owner", ["owner"], []);
            await owner.createBrief(sampleBrief("source-camp"), { teamId: "t1" });

            const res = await mount(t1Member).create(
              createReq({ name: "Copy Cleared", source: "source-camp", teamId: null }),
            );
            expect(res.status).toBe(403);
          } finally {
            await harness.cleanup();
          }
        });

        test("a malformed source pool answers 422, and writes no brief", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            const { create, createBrief } = mount();
            await createBrief(
              new Request("http://x/campaigns/briefs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(sampleBrief("source-camp")),
              }),
            );
            await pgHarness.db.query(
              `insert into pool (org_id, campaign_id, body, revision) values ($1, $2, $3, $4)`,
              ["local", "source-camp", "{not-json", "deadbeef"],
            );
            const res = await create(createReq({ name: "Copy Of Broken", source: "source-camp" }));
            expect(res.status).toBe(422);
            const listed = await mount().list(new Request("http://x/campaigns/briefs"));
            const listedJson = (await listed.json()) as { briefs: { brief: { id: string } }[] };
            expect(listedJson.briefs.map((b) => b.brief.id)).toEqual(["source-camp"]);

            // PT-5b2 fix-round item 2: readPool runs before any slug is ever
            // reserved, so nothing needs releasing — a retry gets the SAME
            // slug, never "-2".
            expect(
              await getBriefStore(LOCAL_TENANT).campaignTeam("copy-of-broken"),
            ).toBeUndefined();
            const retried = await create(
              createReq({ name: "Copy Of Broken", source: "source-camp" }),
            );
            expect(retried.status).toBe(422);
          } finally {
            await harness.cleanup();
          }
        });

        // The preflight readPool above cannot catch a source pool that
        // becomes malformed AFTER it but before this attempt's own copyPool
        // call reads it again (a narrow, real race — copyPool re-reads the
        // source to rewrite its briefId, C9/D71) — that failure lands
        // post-reservation and must release it too.
        // The pool is written BEFORE version 1 (coderabbit
        // PRRT_kwDOSzP1zc6mg8ci), so this failure leaves nothing versioned:
        // the reservation is released, and a retry gets the same slug.
        test("a source pool that only fails validation during the copy answers 422 and releases the reservation", async () => {
          const harness = await setup();
          try {
            const { create, createBrief } = mount();
            await createBrief(
              new Request("http://x/campaigns/briefs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(sampleBrief("source-camp")),
              }),
            );
            await getPoolStore(LOCAL_TENANT).writePool({
              briefId: "source-camp",
              generatedAt: new Date().toISOString(),
              model: "test-model",
              entries: [{ id: "e1", text: "Hi", status: "approved" }],
            });
            const spy = vi
              .spyOn(pools, "copyPool")
              .mockRejectedValueOnce(new InvalidCopyPoolError("source-camp", "raced invalid"));

            const res = await create(createReq({ name: "Copy Of Source", source: "source-camp" }));
            expect(res.status).toBe(422);
            spy.mockRestore();

            expect(
              await getBriefStore(LOCAL_TENANT).findBriefById("copy-of-source"),
            ).toBeUndefined();
            const retried = await create(
              createReq({ name: "Copy Of Source", source: "source-camp" }),
            );
            expect(retried.status).toBe(201);
            expect(((await retried.json()) as { slug: string }).slug).toBe("copy-of-source");
          } finally {
            await harness.cleanup();
          }
        });

        // D166 item 2: the source brief's own logoPath names a THIRD campaign,
        // hidden from this caller by team — checked before any copy runs.
        test("a source referencing a campaign hidden by team answers 404, and copies nothing", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            await pgHarness.db.query(
              `insert into team (id, name, "memberCount", org_id, created_at) values
                 ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
              ["t1", "Team One", "local", "t2", "Team Two"],
            );
            const owner = new PgBriefStore(pgHarness.db, "local", "owner", ["owner"], []);
            await owner.createBrief(sampleBrief("t1-camp"), { teamId: "t1" });
            const hiddenAssets = join(pgHarness.projectRoot, "assets", "inputs", "t1-camp");
            mkdirSync(hiddenAssets, { recursive: true });
            writeFileSync(join(hiddenAssets, "secret.png"), "T1-SECRET");

            const t2Store = new PgBriefStore(pgHarness.db, "local", "u2", [], ["t2"]);
            await t2Store.createBrief(
              {
                ...sampleBrief("t2-source"),
                products: [
                  {
                    id: "p1",
                    name: "P1",
                    primaryColor: "#1473E6",
                    logoPath: "assets/inputs/t1-camp/secret.png",
                  },
                ],
              },
              { teamId: "t2" },
            );

            const res = await mount(t2Member).create(
              createReq({ name: "Copy Of Hidden Ref", source: "t2-source" }),
            );
            expect(res.status).toBe(404);
            expect(
              existsSync(join(pgHarness.projectRoot, "assets", "inputs", "copy-of-hidden-ref")),
            ).toBe(false);
            // PT-5b2 fix-round item 2: assertSourceVisible runs before any
            // slug is ever reserved — nothing to release.
            expect(
              await getBriefStore(LOCAL_TENANT).campaignTeam("copy-of-hidden-ref"),
            ).toBeUndefined();
          } finally {
            await harness.cleanup();
          }
        });

        // D166 item 2's happy path: an additional source id the caller CAN
        // see — its assets copy into the new campaign too, not just the
        // primary source's.
        test("a source referencing a visible campaign also copies that campaign's assets", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            const owner = new PgBriefStore(pgHarness.db, "local", "owner", ["owner"], []);
            await owner.createBrief(sampleBrief("other-camp"));
            const otherAssets = join(pgHarness.projectRoot, "assets", "inputs", "other-camp");
            mkdirSync(otherAssets, { recursive: true });
            writeFileSync(join(otherAssets, "shared.png"), "SHARED-LOGO");

            await owner.createBrief({
              ...sampleBrief("multi-source"),
              products: [
                {
                  id: "p1",
                  name: "P1",
                  primaryColor: "#1473E6",
                  logoPath: "assets/inputs/other-camp/shared.png",
                },
              ],
            });

            const res = await mount().create(
              createReq({ name: "Copy Of Multi Source", source: "multi-source" }),
            );
            expect(res.status).toBe(201);
            const { slug } = (await res.json()) as { slug: string };
            expect(
              existsSync(join(pgHarness.projectRoot, "assets", "inputs", slug, "shared.png")),
            ).toBe(true);
          } finally {
            await harness.cleanup();
          }
        });

        test("an unexpected assertSourceVisible failure (not CampaignNotFoundError) surfaces as 500", async () => {
          const harness = await setup();
          const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
          try {
            const owner = new PgBriefStore(pgHarness.db, "local", "owner", ["owner"], []);
            await owner.createBrief(sampleBrief("other-camp"));
            await owner.createBrief({
              ...sampleBrief("multi-source"),
              products: [
                {
                  id: "p1",
                  name: "P1",
                  primaryColor: "#1473E6",
                  logoPath: "assets/inputs/other-camp/shared.png",
                },
              ],
            });
            const spy = vi
              .spyOn(getBriefStore(LOCAL_TENANT), "campaignVisibility")
              .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));

            const res = await mount().create(
              createReq({ name: "Copy Of Multi Source", source: "multi-source" }),
            );
            expect(res.status).toBe(500);
            spy.mockRestore();
          } finally {
            await harness.cleanup();
          }
        });
      }

      if (backend === "fs") {
        test("refuses a symlinked briefs/<slug> directory with 400", async () => {
          const harness = await setup();
          const fsHarness = harness as Awaited<ReturnType<typeof setupFsHarness>>;
          try {
            const { create, createBrief } = mount();
            await createBrief(
              new Request("http://x/campaigns/briefs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(sampleBrief("source-camp")),
              }),
            );
            const elsewhere = join(fsHarness.tmpDir, "elsewhere");
            mkdirSync(elsewhere, { recursive: true });
            symlinkSync(elsewhere, join(fsHarness.projectRoot, "briefs", "linked-copy"));

            const res = await create(createReq({ name: "Linked Copy", source: "source-camp" }));
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: "Refusing to write through a symlink." });
            expect(existsSync(join(elsewhere, "linked-copy.yaml"))).toBe(false);
          } finally {
            await harness.cleanup();
          }
        });
      }

      test("ignores type: the copy carries the source brief's own type", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          const res = await create(
            createReq({ name: "Bad Type Ignored", source: "source-camp", type: "not-a-real-type" }),
          );
          expect(res.status).toBe(201);
        } finally {
          await harness.cleanup();
        }
      });

      test("a missing source answers 404", async () => {
        const harness = await setup();
        try {
          const res = await mount().create(createReq({ name: "Orphan", source: "nope" }));
          expect(res.status).toBe(404);
        } finally {
          await harness.cleanup();
        }
      });

      test("an unexpected preflight readPool failure (not InvalidCopyPoolError) surfaces as 500", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          const spy = vi
            .spyOn(getPoolStore(LOCAL_TENANT), "readPool")
            .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
          const res = await create(createReq({ name: "Copy", source: "source-camp" }));
          expect(res.status).toBe(500);
          spy.mockRestore();
        } finally {
          await harness.cleanup();
        }
      });

      // D177's correction: a blank brief cannot be a version, so a versionless
      // campaign has nothing to copy — this must 404 like any other unknown
      // source, never crash on the row that createCampaign minted.
      test("a versionless source (nothing to copy yet) answers 404", async () => {
        const harness = await setup();
        try {
          const { create } = mount();
          await create(createReq({ name: "Blank Source" }));

          const res = await create(createReq({ name: "Copy Of Blank", source: "blank-source" }));
          expect(res.status).toBe(404);
        } finally {
          await harness.cleanup();
        }
      });

      test("dedupes the target slug against an existing campaign", async () => {
        const harness = await setup();
        try {
          const { create, createBrief } = mount();
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("source-camp")),
            }),
          );
          await createBrief(
            new Request("http://x/campaigns/briefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sampleBrief("copy-of-source")),
            }),
          );

          const res = await create(createReq({ name: "Copy Of Source", source: "source-camp" }));
          expect(((await res.json()) as { slug: string }).slug).toBe("copy-of-source-2");
        } finally {
          await harness.cleanup();
        }
      });
    });

    describe("a versionless campaign reads as no stored brief everywhere (D177, PT-5b2)", () => {
      test("never 500s on briefs.get, result.get, decisions.get, assets.get, pools, jobs or packages", async () => {
        const harness = await setup();
        try {
          const { create, list, result, decisions, assets, pool, jobs, pkg } = mount();
          const created = await create(createReq({ name: "Blank Campaign" }));
          const { slug } = (await created.json()) as { slug: string };

          const listed = await list(new Request("http://x/campaigns/briefs"));
          expect(listed.status).toBe(200);
          expect(((await listed.json()) as { briefs: unknown[] }).briefs).toEqual([]);

          // Each of these answers 404 today for a genuinely unsaved draft (no
          // report, no assets, no pool, no job, no package) — a versionless
          // campaign must read exactly the same way, never a 500. result.get
          // and decisions.get reach it through `campaignKnown` (no report/asset,
          // then `findBriefById` misses); pools/jobs/packages reach it through
          // their own store's plain "nothing here yet" answer, after the same
          // hidden-by-team gate every campaign-addressed route runs.
          const resultRes = await result(
            new Request(`http://x/campaigns/result?campaignId=${slug}`),
          );
          expect(resultRes.status).toBe(404);

          const decisionsRes = await decisions(
            new Request(`http://x/campaigns/decisions?campaignId=${slug}`),
          );
          expect(decisionsRes.status).toBe(404);

          const assetsRes = await assets(new Request(`http://x/campaigns/assets?briefId=${slug}`));
          expect(assetsRes.status).toBe(404);

          const poolRes = await pool(new Request(`http://x/campaigns/pools/${slug}`));
          expect(poolRes.status).toBe(404);

          const jobsRes = await jobs(new Request(`http://x/campaigns/jobs?campaignId=${slug}`));
          expect(jobsRes.status).toBe(404);

          const pkgRes = await pkg(new Request(`http://x/campaigns/packages/${slug}`));
          expect(pkgRes.status).toBe(404);
        } finally {
          await harness.cleanup();
        }
      });
    });
  },
);

/**
 * D181 fix round (grok-4.7 pre-PR review): a reserved id must be refused at
 * Save only when NOTHING exists for it yet — an already-minted campaign
 * (grandfathered, D181's own scope note: existing campaigns keep their id)
 * must still complete its first Save. These tests call the raw
 * `briefs.post.ts` handler directly (never `mount().createBrief`'s own
 * best-effort auto-mint wrapper, which tries `createCampaign` first and
 * would either interfere with a deliberately-missing fixture or mask the
 * exact refusal/success this suite is pinning).
 */
const briefsReq = (body: unknown) =>
  new Request("http://x/campaigns/briefs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /campaigns/briefs onto a grandfathered reserved slug (D181 fix round)", () => {
  describe.each([{ backend: "fs" as const }, { backend: "postgres" as const }])(
    "$backend",
    ({ backend }) => {
      const setup = () => (backend === "fs" ? setupFsHarness() : setupPgHarness());

      test("a pre-minted versionless `templates` campaign accepts its first Save as version 1", async () => {
        const harness = await setup();
        try {
          // Mint directly through the store, bypassing `createCampaign`'s own
          // (correct, unchanged) reserved-id refusal — simulating a campaign
          // minted BEFORE this lane, when `templates` was not yet reserved.
          // On fs this must be GENUINE evidence — a real campaign.json, the
          // same shape `createCampaign` itself writes — not a bare directory
          // (D181 fix round 2, Fable: a bare directory is exactly what
          // `FsPoolStore.writePool`'s inline-brief path can create for ANY
          // id, so `hasGenuineReservation` no longer trusts it alone).
          if (backend === "fs") {
            const fsHarness = harness as Awaited<ReturnType<typeof setupFsHarness>>;
            mkdirSync(join(fsHarness.projectRoot, "briefs", "templates"), { recursive: true });
            writeFileSync(
              join(fsHarness.projectRoot, "briefs", "templates", "campaign.json"),
              JSON.stringify({ name: "Templates", type: null }),
            );
          } else {
            const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
            await pgHarness.db.query(
              `insert into campaign (org_id, slug, team_id, name, type) values ($1, $2, $3, $4, $5)`,
              ["local", "templates", null, null, null],
            );
          }

          const createBrief = mountTenantRoute(briefsPostHandler, {
            method: "POST",
            path: "/campaigns/briefs",
            tenant: LOCAL_TENANT,
          });
          const res = await createBrief(briefsReq(sampleBrief("templates")));
          expect(res.status).toBe(201);
          const body = (await res.json()) as { brief: { id: string } };
          expect(body.brief.id).toBe("templates");

          const meta = await getBriefStore(LOCAL_TENANT).campaignMeta("templates");
          expect(meta?.hasVersion).toBe(true);
        } finally {
          await harness.cleanup();
        }
      });

      test("a reserved id with no campaign at all is still refused with today's status and body", async () => {
        const harness = await setup();
        try {
          const createBrief = mountTenantRoute(briefsPostHandler, {
            method: "POST",
            path: "/campaigns/briefs",
            tenant: LOCAL_TENANT,
          });
          const res = await createBrief(briefsReq(sampleBrief("templates")));
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({
            error: `"templates" is reserved; choose another campaign id.`,
          });

          // S1 (D181 fix round 2): the refused mint leaves nothing behind —
          // a genuinely rolled-back attempt, not a row/directory some later
          // caller could stumble into and read as a real reservation.
          if (backend === "postgres") {
            const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
            const { rows } = await pgHarness.db.query(
              `select 1 from campaign where org_id = 'local' and slug = 'templates'`,
            );
            expect(rows).toEqual([]);
          } else {
            const fsHarness = harness as Awaited<ReturnType<typeof setupFsHarness>>;
            expect(existsSync(join(fsHarness.projectRoot, "briefs", "templates"))).toBe(false);
          }
        } finally {
          await harness.cleanup();
        }
      });

      if (backend === "fs") {
        // Bug 2 (Fable, D181 fix round 2): `FsPoolStore.writePool`'s
        // inline-brief path (`POST /campaigns/pools/copy` with `{ brief }`)
        // `mkdir`s `briefs/<id>/` as a side effect, for ANY id — reserved or
        // not — with no campaign behind it. Before this fix that bare
        // directory alone made `campaignMeta` (and so the old grandfather
        // check) answer "known", letting a fresh reserved mint through a
        // side door `createCampaign` itself would have refused.
        test("a bare briefs/templates/ directory (pools.json, no campaign.json, no version) does not grandfather a reserved mint", async () => {
          const harness = await setup();
          const fsHarness = harness as Awaited<ReturnType<typeof setupFsHarness>>;
          try {
            mkdirSync(join(fsHarness.projectRoot, "briefs", "templates"), { recursive: true });
            writeFileSync(
              join(fsHarness.projectRoot, "briefs", "templates", "pools.json"),
              JSON.stringify({
                briefId: "templates",
                generatedAt: new Date().toISOString(),
                model: "test",
                entries: [],
              }),
            );

            const createBrief = mountTenantRoute(briefsPostHandler, {
              method: "POST",
              path: "/campaigns/briefs",
              tenant: LOCAL_TENANT,
            });
            const res = await createBrief(briefsReq(sampleBrief("templates")));
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({
              error: `"templates" is reserved; choose another campaign id.`,
            });
            expect(
              existsSync(join(fsHarness.projectRoot, "briefs", "templates.yaml")),
            ).toBe(false);
          } finally {
            await harness.cleanup();
          }
        });
      }
    },
  );

  test("a hidden (other team) pre-minted `templates` campaign answers the identical 400 a genuinely missing reserved id does (PT-2d)", async () => {
    const harness = await setupPgHarness();
    try {
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t1", "Team One", "local"],
      );
      // Mint directly through the store (raw SQL), bypassing BOTH
      // `createCampaign`'s and `createBrief`'s own reserved-id refusals —
      // simulating a pre-lane blank `POST /campaigns` whose team is t1.
      await harness.db.query(
        `insert into campaign (org_id, slug, team_id, name, type) values ($1, $2, $3, $4, $5)`,
        ["local", "templates", "t1", null, null],
      );

      const createBrief = mountTenantRoute(briefsPostHandler, {
        method: "POST",
        path: "/campaigns/briefs",
        tenant: t2Member,
      });

      // D181 fix round 2 (Fable, PT-2d): a hidden reserved campaign must NOT
      // be distinguishable from a genuinely missing reserved id — either
      // status alone would leak that a hidden campaign exists under that
      // slug to a caller who cannot see it.
      const hidden = await createBrief(briefsReq(sampleBrief("templates")));
      const expectedBody = { error: `"templates" is reserved; choose another campaign id.` };
      expect(hidden.status).toBe(400);
      expect(await hidden.json()).toEqual(expectedBody);

      // Now the SAME slug, SAME harness, SAME caller — genuinely missing
      // (the row deleted, not merely hidden) — for a same-id, same-db
      // apples-to-apples comparison rather than two different reserved ids.
      await harness.db.query(`delete from campaign where org_id = 'local' and slug = 'templates'`);
      const missing = await createBrief(briefsReq(sampleBrief("templates")));
      expect(missing.status).toBe(hidden.status);
      expect(await missing.json()).toEqual(expectedBody);
    } finally {
      await harness.cleanup();
    }
  });
});

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
