import { describe, test, expect } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { TenantContext } from "../../../lib/tenant.js";
import idGetHandler from "../[id].get.js";
import capabilitiesHandler from "../capabilities.get.js";
import createHandler from "../index.post.js";
import briefsPostHandler from "../briefs.post.js";
import duplicateHandler from "../briefs/[id]/duplicate.post.js";
import { mountTenantApp, setupFsHarness, setupPgHarness } from "../../__tests__/tenant-harness.js";

function sampleBrief(id: string, type?: CampaignBrief["type"]): CampaignBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(type ?? DEFAULT_CAMPAIGN_TYPE),
    id,
    type,
    targetRegion: "US",
    targetAudience: "developers",
    campaignMessage: "Build faster",
    products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  };
}

function mount(tenant: TenantContext | undefined = undefined) {
  const app = mountTenantApp(
    [
      { method: "get", path: "/campaigns/capabilities", handler: capabilitiesHandler },
      { method: "get", path: "/campaigns/:id", handler: idGetHandler },
      { method: "post", path: "/campaigns", handler: createHandler },
      { method: "post", path: "/campaigns/briefs", handler: briefsPostHandler },
      { method: "post", path: "/campaigns/briefs/:id/duplicate", handler: duplicateHandler },
    ],
    tenant,
  );
  const jsonReq = (path: string, method: string, body: unknown) =>
    new Request(`http://x${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    get: (path: string) => app(new Request(`http://x${path}`)),
    create: (body: unknown) => app(jsonReq("/campaigns", "POST", body)),
    save: (body: unknown, replace = false) =>
      app(jsonReq(`/campaigns/briefs${replace ? "?replace=1" : ""}`, "POST", body)),
    duplicate: (id: string, body: unknown) =>
      app(jsonReq(`/campaigns/briefs/${id}/duplicate`, "POST", body)),
  };
}

describe.each([{ backend: "fs" as const }, { backend: "postgres" as const }])(
  "GET /campaigns/:id — $backend",
  ({ backend }) => {
    const setup = () => (backend === "fs" ? setupFsHarness() : setupPgHarness());

    test("a blank create answers its name, type and hasVersion: false", async () => {
      const harness = await setup();
      try {
        const { get, create } = mount();
        const created = await create({ name: "My Campaign", type: "paid-social" });
        const { slug, campaignId } = (await created.json()) as {
          slug: string;
          campaignId: string;
        };

        const res = await get(`/campaigns/${slug}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          campaignId,
          slug,
          name: "My Campaign",
          type: "paid-social",
          hasVersion: false,
        });
      } finally {
        await harness.cleanup();
      }
    });

    test("resolves by uuid as well as by slug", async () => {
      const harness = await setup();
      try {
        const { get, create } = mount();
        const created = await create({ name: "Uuid Ref", type: "social-post" });
        const { slug, campaignId } = (await created.json()) as {
          slug: string;
          campaignId: string;
        };

        const byId = await get(`/campaigns/${campaignId}`);
        expect(byId.status).toBe(200);
        expect(((await byId.json()) as { slug: string }).slug).toBe(slug);
      } finally {
        await harness.cleanup();
      }
    });

    test("saving a version never clears the recorded name and type (item 4)", async () => {
      const harness = await setup();
      try {
        const { get, create, save } = mount();
        const created = await create({ name: "Keeps Meta", type: "paid-social" });
        const { slug } = (await created.json()) as { slug: string };

        const saveRes = await save(sampleBrief(slug));
        expect(saveRes.status).toBe(201);

        const res = await get(`/campaigns/${slug}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          name: string | null;
          type: string | null;
          hasVersion: boolean;
        };
        expect(body.name).toBe("Keeps Meta");
        expect(body.type).toBe("paid-social");
        expect(body.hasVersion).toBe(true);

        // A second Save (replace) must not clear them either.
        const secondSave = await save({ ...sampleBrief(slug), campaignMessage: "v2" }, true);
        expect(secondSave.status).toBe(201);
        const again = (await (await get(`/campaigns/${slug}`)).json()) as {
          name: string | null;
          type: string | null;
        };
        expect(again).toMatchObject({ name: "Keeps Meta", type: "paid-social" });
      } finally {
        await harness.cleanup();
      }
    });

    test("a sourced create takes the SOURCE's type, and the caller's own typed name", async () => {
      const harness = await setup();
      try {
        const { get, create, save } = mount();
        const sourceCreated = await create({ name: "Source Campaign", type: "display-ad" });
        const { slug: sourceSlug } = (await sourceCreated.json()) as { slug: string };
        // The saved BRIEF's own `type` field (not the campaign meta stored at
        // Create) is what `template.type` reads at copy time (index.post.ts).
        // "social-post" is the campaign type whose preset needs no further
        // fields (no `variation.count`, no display sizes) to pass `parseBrief`.
        await save(sampleBrief(sourceSlug, "social-post"));

        const copyRes = await create({ name: "Copy Campaign", source: sourceSlug });
        expect(copyRes.status).toBe(201);
        const { slug: copySlug } = (await copyRes.json()) as { slug: string };

        const res = await get(`/campaigns/${copySlug}`);
        const body = (await res.json()) as { name: string | null; type: string | null };
        expect(body.name).toBe("Copy Campaign");
        // The SOURCE brief's own type ("social-post"), never the caller's
        // Create-time type ("display-ad") nor the caller's own (absent) type
        // on this sourced request.
        expect(body.type).toBe("social-post");
      } finally {
        await harness.cleanup();
      }
    });

    test("duplicate's name path also stores the SOURCE's type", async () => {
      const harness = await setup();
      try {
        const { get, create, save, duplicate } = mount();
        const sourceCreated = await create({ name: "Dup Source", type: "paid-social" });
        const { slug: sourceSlug } = (await sourceCreated.json()) as { slug: string };
        await save(sampleBrief(sourceSlug, "paid-social"));

        const dupRes = await duplicate(sourceSlug, { name: "Dup Target" });
        expect(dupRes.status).toBe(201);
        const { brief } = (await dupRes.json()) as { brief: CampaignBrief };

        const res = await get(`/campaigns/${brief.id}`);
        const body = (await res.json()) as { name: string | null; type: string | null };
        expect(body.name).toBe("Dup Target");
        expect(body.type).toBe("paid-social");
      } finally {
        await harness.cleanup();
      }
    });

    test("a campaign minted with no type answers null type, keeps its name, and still 200", async () => {
      const harness = await setup();
      try {
        const { get, create } = mount();
        const created = await create({ name: "No Type Given" });
        const { slug } = (await created.json()) as { slug: string };

        const res = await get(`/campaigns/${slug}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { name: string | null; type: string | null };
        expect(body.name).toBe("No Type Given");
        expect(body.type).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });

    test("an unknown ref answers 404 with the route family's body", async () => {
      const harness = await setup();
      try {
        const res = await mount().get("/campaigns/never-created");
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/never-created/);
      } finally {
        await harness.cleanup();
      }
    });

    test("an unsafe id answers 400, never reaching the store", async () => {
      const harness = await setup();
      try {
        const res = await mount().get("/campaigns/..%2Fetc");
        expect(res.status).toBe(400);
      } finally {
        await harness.cleanup();
      }
    });

    // PT-9a1, D231/D233. Two cases, not one, because `campaignMeta`'s uuid branch and
    // its slug branch are two queries with two filters, and a single case would pass
    // on either one alone. The mutation manifest anchors on the by-slug case for
    // exactly that reason.
    if (backend === "postgres") {
      test("a tombstoned campaign answers 404 by uuid, indistinguishable from unknown", async () => {
        const harness = await setup();
        const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        try {
          const created = await mount().create({ name: "Gone", type: "social-post" });
          const { slug, campaignId } = (await created.json()) as {
            slug: string;
            campaignId: string;
          };
          expect((await mount().save(sampleBrief(slug))).status).toBe(201);
          // Served before the tombstone, so the 404 below cannot be an absent row.
          expect((await mount().get(`/campaigns/${campaignId}`)).status).toBe(200);

          await pgHarness.db.query(
            `update campaign set deleted_at = now() where org_id = $1 and id = $2`,
            ["local", campaignId],
          );
          const res = await mount().get(`/campaigns/${campaignId}`);
          expect(res.status).toBe(404);
          const body = (await res.json()) as { error: string };
          expect(body.error).toMatch(/gone|not found/i);
        } finally {
          await harness.cleanup();
        }
      });

      test("a tombstoned campaign answers 404 by slug", async () => {
        const harness = await setup();
        const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        try {
          const created = await mount().create({ name: "Gone", type: "social-post" });
          const { slug } = (await created.json()) as { slug: string };
          expect((await mount().save(sampleBrief(slug))).status).toBe(201);
          expect((await mount().get(`/campaigns/${slug}`)).status).toBe(200);

          await pgHarness.db.query(
            `update campaign set deleted_at = now() where org_id = $1 and slug = $2`,
            ["local", slug],
          );
          const res = await mount().get(`/campaigns/${slug}`);
          expect(res.status).toBe(404);
          // The same body an unknown ref answers, so a deleted campaign cannot be
          // told from one that never existed.
          const body = (await res.json()) as { error: string };
          expect(body.error).toMatch(/gone/);
        } finally {
          await harness.cleanup();
        }
      });

      test("a live campaign is served by uuid and by slug after a sibling is tombstoned", async () => {
        // The unchanged-behaviour control. Both ref shapes, and a live row beside
        // a tombstoned one in the same org, so a filter that over-reaches (or that
        // matched on something other than this row) fails here rather than passing
        // on the 404s above.
        const harness = await setup();
        const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        try {
          const doomed = await mount().create({ name: "Gone", type: "social-post" });
          const { slug: gone } = (await doomed.json()) as { slug: string };
          expect((await mount().save(sampleBrief(gone))).status).toBe(201);
          await pgHarness.db.query(
            `update campaign set deleted_at = now() where org_id = $1 and slug = $2`,
            ["local", gone],
          );
          const live = await mount().create({ name: "Live", type: "social-post" });
          const liveBody = (await live.json()) as { slug: string; campaignId: string };
          expect((await mount().save(sampleBrief(liveBody.slug))).status).toBe(201);

          expect((await mount().get(`/campaigns/${liveBody.slug}`)).status).toBe(200);
          const byUuid = await mount().get(`/campaigns/${liveBody.campaignId}`);
          expect(byUuid.status).toBe(200);
          expect(((await byUuid.json()) as { slug: string }).slug).toBe(liveBody.slug);
        } finally {
          await harness.cleanup();
        }
      });

      test("a campaign hidden from the caller by team answers 404, indistinguishable from unknown", async () => {
        const harness = await setup();
        const pgHarness = harness as Awaited<ReturnType<typeof setupPgHarness>>;
        try {
          await pgHarness.db.query(
            `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
            ["t1", "Team One", "local"],
          );
          const created = await mount().create({
            name: "Team Only",
            type: "social-post",
            teamId: "t1",
          });
          const { slug } = (await created.json()) as { slug: string };

          const outsiderNoTeam: TenantContext = {
            orgId: "local",
            userId: "u2",
            roles: [],
            teamIds: ["t-other"],
          };
          const res = await mount(outsiderNoTeam).get(`/campaigns/${slug}`);
          expect(res.status).toBe(404);
        } finally {
          await harness.cleanup();
        }
      });
    }
  },
);

describe("route precedence: static campaign routes win over the dynamic :id route", () => {
  test("GET /campaigns/capabilities still reaches its own handler, not [id].get.ts", async () => {
    const harness = setupFsHarness();
    try {
      const { get } = mount();
      const res = await get("/campaigns/capabilities");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { motion?: boolean; hasVersion?: boolean };
      // capabilities.get.ts's own shape; [id].get.ts would answer 404
      // ("Campaign \"capabilities\" not found") since no such campaign exists.
      expect(body.hasVersion).toBeUndefined();
      expect(typeof body.motion).toBe("boolean");
    } finally {
      harness.cleanup();
    }
  });
});
