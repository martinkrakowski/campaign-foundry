import { describe, test, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { TenantContext } from "../../../lib/tenant.js";
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

const createReq = (body: unknown) =>
  new Request("http://x/campaigns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function mount(tenant: TenantContext = LOCAL_TENANT) {
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
    createBrief: mountTenantRoute(briefsPostHandler, {
      method: "POST",
      path: "/campaigns/briefs",
      tenant,
    }),
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

    test("an invalid type answers 400", async () => {
      const harness = await setup();
      try {
        const res = await mount().create(createReq({ name: "Bad Type", type: "nonsense" }));
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
    }

    describe("sourced create (copies the source's latest version as version 1)", () => {
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
