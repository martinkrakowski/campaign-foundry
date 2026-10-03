import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  PipelineExecutionLog,
  templateFromCanonical,
  type CampaignBrief,
  type PipelineResult,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import { inputKey, renderPrefix } from "../../../lib/object-store/object-keys.js";
import { readReport, writeReport } from "../../../lib/report.js";
// The module OBJECT, so `reportRevision` can be spied on: `signed-urls.ts` calls it
// through this namespace, and the hidden-campaign test needs to know whether a
// report was opened at all for a campaign the caller may not see.
import * as reportModule from "../../../lib/report.js";
import { getAssetStore, getBriefStore, resetAssetStore } from "../../../lib/ports/index.js";
import resultGetHandler from "../result.get.js";
import {
  ACME_TENANT,
  LOCAL_TENANT,
  mountTenantRoute,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";

/**
 * `GET /campaigns/result` mints the URLs (PT-4f, D204, D209).
 *
 * STATIC handler imports and a harness per test, as `assets.postgres.test.ts`
 * does: a helper that re-imports per request would rebuild the module each time,
 * so the injected object store and database would never reach the route and every
 * assertion would be about a PGlite the module built for itself.
 *
 * What this file owns and the lib-level one does not is the ORDERING — no
 * `presignGet` may be called before `campaignKnown` has answered — and the
 * tenancy of it: a caller who may not see the campaign gets 404 with the store
 * never asked. Both are asserted with a spy on the store's own `presignGet`,
 * counting real calls rather than inferring them from the body.
 */

const SLUG = "winter-sale";
const CAMPAIGN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WINDOW_START = 1_700_000_100_000;
const MINUTE = 60 * 1000;

const PUBLIC_ENDPOINT = "https://objects.example";
const BUCKET = "campaign-foundry";

const OUTPUT = `${SLUG}/p1/1x1.png`;
const VIDEO = `${SLUG}/p1/1x1.mp4`;
const FALLBACK = `${SLUG}/p1/1x1/fallback.png`;
const BUNDLE = `${SLUG}/p1/1x1/index.html`;
const PROOF = `${SLUG}/proofs/p1.pdf`;

const makeBrief = (id: string): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  treatments: [{ id: "bold", layout: "headline-bottom", tone: "bold" }],
});

/** One row carrying every path the five URL fields are built from. */
const fullRow = (): Record<string, unknown> => ({
  productId: "p1",
  aspectRatio: "1:1",
  treatment: "default",
  format: "html",
  outputPath: OUTPUT,
  videoPath: VIDEO,
  htmlFallbackPath: FALLBACK,
  htmlBundlePath: BUNDLE,
  proofPath: PROOF,
  brandCompliant: true,
});

const resultWith = (campaignId: string, row: Record<string, unknown>): PipelineResult =>
  ({
    halted: false,
    assets: [row],
    log: new PipelineExecutionLog(campaignId, () => new Date("2026-01-01T00:00:00.000Z")),
  }) as unknown as PipelineResult;

interface Answered {
  assets: Array<Record<string, string>>;
  halted: boolean;
  log: unknown;
}

describe("GET /campaigns/result mints a URL per asset (PT-4f, D204/D209)", () => {
  let harness: PgHarness;
  let store: InMemoryObjectStore;
  const SAVED = process.env.OBJECT_STORE;

  /** The route's body for one ref, as JSON. */
  const ask = async (tenant: typeof LOCAL_TENANT, ref: string): Promise<Response> => {
    const call = mountTenantRoute(resultGetHandler, {
      path: "/campaigns/result",
      tenant,
    });
    return call(new Request(`http://x/campaigns/result?campaignId=${ref}`));
  };

  beforeEach(async () => {
    harness = await setupPgHarness();
    store = new InMemoryObjectStore({ publicEndpoint: PUBLIC_ENDPOINT, bucket: BUCKET });
    setObjectStoreClient(store);
    // `Date` ONLY. The harness migrates a database and awaits real I/O; a faked
    // `setTimeout` under that would stall it. The window is the only clock here.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WINDOW_START + 30_000);
  });

  afterEach(async () => {
    vi.useRealTimers();
    // The spies are pass-through, but a spy left installed is shared state: the
    // next test in this worker would run under a module namespace this one edited.
    vi.restoreAllMocks();
    resetAssetStore();
    resetObjectStoreClient();
    if (SAVED === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED;
    await harness.cleanup();
  });

  describe("on fs (OBJECT_STORE unset)", () => {
    beforeEach(() => {
      delete process.env.OBJECT_STORE;
    });

    test("'never ran' is answered unchanged, and signs nothing", async () => {
      await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      const presign = vi.spyOn(store, "presignGet");
      const res = await ask(LOCAL_TENANT, SLUG);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ halted: false, assets: [], log: null });
      // No rows, so no revision is read either — and nothing to sign.
      expect(presign).not.toHaveBeenCalled();
    });

    test("a JSON null report is answered unchanged", async () => {
      await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      const { getReportStore } = await import("../../../lib/ports/index.js");
      await getReportStore(LOCAL_TENANT).writeReport(SLUG, "null");
      const res = await ask(LOCAL_TENANT, SLUG);
      // `null` is what the store parsed and what this handler returns — the same
      // value it returned before PT-4f, so nothing here is new. h3 encodes a
      // `null` return as no content, hence 204 rather than 200; asserted so a
      // later change cannot quietly turn the pass-through into a 200 or a 500.
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });

    test("every field is the output route plus the path, carrying the revision once", async () => {
      const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));

      const body = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      const row = body.assets[0]!;
      // fs URLs are the route's own, so they are relative: read the query off a
      // resolved URL rather than assuming an origin the server never sends.
      const revision = new URL(row["outputUrl"]!, "http://x").searchParams.get("v")!;

      expect(revision).toMatch(/^[0-9a-f]{64}$/);
      for (const [field, path] of [
        ["outputUrl", OUTPUT],
        ["videoUrl", VIDEO],
        ["htmlFallbackUrl", FALLBACK],
        ["htmlBundleUrl", BUNDLE],
        ["proofUrl", PROOF],
      ] as const) {
        expect(row[field]).toBe(`/api/pipeline/output/${path}?v=${revision}`);
      }
      // And the row keeps every key the STORE holds, in order, with the URLs at
      // the end — compared against what was written, not against the row this
      // test built, because `writeReport` derives `brandCompliant` from the raw
      // signals and the stored row is the one the client reads back.
      const storedReport = (await readReport(LOCAL_TENANT, SLUG)) as Answered;
      expect(Object.keys(row)).toStrictEqual([
        ...Object.keys(storedReport.assets[0]!),
        "outputUrl",
        "videoUrl",
        "htmlFallbackUrl",
        "proofUrl",
        "htmlBundleUrl",
      ]);
      expect(stored.campaignId).toMatch(CAMPAIGN_ID_PATTERN);
    });

    test("by slug and by uuid the answers are identical, URLs included", async () => {
      const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const bySlug = await (await ask(LOCAL_TENANT, SLUG)).json();
      const byUuid = await (await ask(LOCAL_TENANT, stored.campaignId!)).json();
      // `toStrictEqual` on the whole body: the `*Url` fields are part of the answer
      // now, so a resolver that produced a different one would show up here.
      expect(byUuid).toStrictEqual(bySlug);
    });

    test("a non-array assets and a non-object row pass through unchanged", async () => {
      await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      const { getReportStore } = await import("../../../lib/ports/index.js");
      const store2 = getReportStore(LOCAL_TENANT);
      await store2.writeReport(SLUG, JSON.stringify({ halted: false, assets: { rows: [] } }));
      const resNotArray = await ask(LOCAL_TENANT, SLUG);
      expect(await resNotArray.json()).toEqual({ halted: false, assets: { rows: [] } });

      await store2.writeReport(
        SLUG,
        JSON.stringify({ halted: false, assets: [null, "row", { ...fullRow() }] }),
      );
      const body = (await (await ask(LOCAL_TENANT, SLUG)).json()) as unknown as Answered;
      expect(body.assets[0]).toBeNull();
      expect(body.assets[1]).toBe("row");
      expect(body.assets[2]!["outputUrl"]).toBeDefined();
    });
  });

  describe("on s3", () => {
    let campaignId: string;

    beforeEach(async () => {
      process.env.OBJECT_STORE = "s3";
      const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      campaignId = stored.campaignId!;
    });

    test("all five fields are signed under this campaign's own prefix", async () => {
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const body = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      const row = body.assets[0]!;
      const prefix = renderPrefix(LOCAL_TENANT.orgId, campaignId);

      expect(Object.keys(row).slice(-5)).toStrictEqual([
        "outputUrl",
        "videoUrl",
        "htmlFallbackUrl",
        "proofUrl",
        "htmlBundleUrl",
      ]);
      for (const field of [
        "outputUrl",
        "videoUrl",
        "htmlFallbackUrl",
        "proofUrl",
        "htmlBundleUrl",
      ]) {
        const parsed = new URL(row[field]!);
        // /<bucket>/org/<orgId>/campaign/<uuid>/renders/<rest> — the key the run's
        // own exporter wrote, and no key under any other campaign or org.
        expect(parsed.pathname.startsWith(`/${BUCKET}/${prefix}`)).toBe(true);
        expect(parsed.searchParams.get("X-Amz-Expires")).toBe("1200");
        expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(new URL(row["proofUrl"]!).searchParams.get("response-content-disposition")).toBe(
        'attachment; filename="p1.pdf"',
      );
      expect(new URL(row["htmlBundleUrl"]!).searchParams.get("response-content-disposition")).toBe(
        'attachment; filename="index.html"',
      );
    });

    test("one window signs one URL and the next window signs another", async () => {
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      vi.setSystemTime(WINDOW_START + MINUTE);
      const first = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      vi.setSystemTime(WINDOW_START + 14 * MINUTE);
      const second = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;

      // `toBe`-IDENTICAL: this is the whole point of aligning the signature. A grid
      // polling every tick reuses one cache entry rather than re-downloading.
      expect(second.assets[0]!["outputUrl"]).toBe(first.assets[0]!["outputUrl"]);
      expect(new URL(first.assets[0]!["outputUrl"]!).searchParams.get("X-Amz-Expires")).toBe(
        "1200",
      );

      vi.setSystemTime(WINDOW_START + 15 * MINUTE + 1);
      const third = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      expect(third.assets[0]!["outputUrl"]).not.toBe(first.assets[0]!["outputUrl"]);
    });

    test("the revision rides signed, so two revisions give two URLs and one gives one", async () => {
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const first = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      const firstRevision = new URL(first.assets[0]!["outputUrl"]!).searchParams.get("v")!;

      // Same revision, re-read: the identical URL.
      const same = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      expect(same.assets[0]!["outputUrl"]).toBe(first.assets[0]!["outputUrl"]);

      // A re-run rewrites the report, so the revision moves and the URL must too.
      await writeReport(
        LOCAL_TENANT,
        resultWith(SLUG, { ...fullRow(), clickDestination: "https://example.test/next" }),
      );
      const second = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      const secondRevision = new URL(second.assets[0]!["outputUrl"]!).searchParams.get("v")!;
      expect(secondRevision).not.toBe(firstRevision);
      expect(second.assets[0]!["outputUrl"]).not.toBe(first.assets[0]!["outputUrl"]);
      // Every field carries it, not just the output.
      expect(new URL(second.assets[0]!["proofUrl"]!).searchParams.get("v")).toBe(secondRevision);
    });

    test("a refused path costs its field only, and a ref with no campaign row mints none", async () => {
      await writeReport(
        LOCAL_TENANT,
        resultWith(SLUG, {
          productId: "p1",
          aspectRatio: "1:1",
          treatment: "default",
          outputPath: "p1/1x1.png",
        }),
      );
      const body = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      // The fixture shape `routes-campaign-refs.test.ts` carries: no slug segment,
      // so `renderObjectKey` refuses it and the row gets no URL at all.
      expect(body.assets[0]!["outputUrl"]).toBeUndefined();
      expect(body.assets[0]!["outputPath"]).toBe("p1/1x1.png");

      // A report under a slug with NO campaign row: 200, and no `*Url` anywhere,
      // because there is no uuid for a key to hang under.
      await writeReport(
        LOCAL_TENANT,
        resultWith("no-row", {
          productId: "p9",
          outputPath: "no-row/p1/1x1.png",
        }),
      );
      const orphan = (await (await ask(LOCAL_TENANT, "no-row")).json()) as Answered;
      expect(Object.keys(orphan.assets[0]!).filter((key) => key.endsWith("Url"))).toStrictEqual([]);
    });
  });

  describe("tenancy: nothing is signed before the campaign is known to be the caller's", () => {
    beforeEach(async () => {
      process.env.OBJECT_STORE = "s3";
      await harness.db.query(
        `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
        ["t-hidden", "Hidden Team", LOCAL_TENANT.orgId],
      );
    });

    test("a team-hidden campaign answers 404 with ZERO presignGet calls", async () => {
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG), { teamId: "t-hidden" });

      // A caller in neither team: the campaign is hidden from them by D166.
      const restricted = {
        orgId: LOCAL_TENANT.orgId,
        userId: "restricted",
        roles: [],
        teamIds: [],
      };
      const presign = vi.spyOn(store, "presignGet");
      // The READ spy is what carries the ordering claim, and it has to be here: for
      // a hidden campaign `PgBriefStore.resolveCampaign` answers undefined
      // (team-filtered), so `withAssetUrls` is handed no campaign uuid and mints NO
      // presigned URL even if it runs. A `presignGet` count alone would therefore
      // stay zero with the URL minting moved ABOVE the gate, and pass. `reportRevision`
      // is read once per answered report and by nothing else on this path
      // (`campaignKnown` goes to the port's own `getRevision`), so one call means a
      // report was opened for a campaign this caller may not see.
      const revision = vi.spyOn(reportModule, "reportRevision");
      const res = await ask(restricted, SLUG);

      expect(res.status).toBe(404);
      // The mutation that moves `withAssetUrls` above `campaignKnown` fails HERE.
      expect(revision).not.toHaveBeenCalled();
      expect(presign).not.toHaveBeenCalled();
    });

    test("org B asking for org A's slug and uuid answers 404 with ZERO presignGet calls", async () => {
      const stored = await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));

      const presign = vi.spyOn(store, "presignGet");
      const bySlug = await ask(ACME_TENANT, SLUG);
      const byUuid = await ask(ACME_TENANT, stored.campaignId!);
      expect(bySlug.status).toBe(404);
      expect(byUuid.status).toBe(404);
      expect(presign).not.toHaveBeenCalled();
    });

    test("org A's own caller gets URLs, and every one of them is under org/A/", async () => {
      await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const body = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      const signed = Object.entries(body.assets[0]!).filter(([key]) => key.endsWith("Url"));
      expect(signed.length).toBe(5);
      for (const [field, url] of signed) {
        expect(new URL(url).pathname, field).toContain(`/org/${LOCAL_TENANT.orgId}/`);
      }
    });

    test("two orgs at once: each caller signs under its OWN org, neither under the other's", async () => {
      // The concurrency question this lane actually has: one process-wide object
      // store, one `OBJECT_STORE`, two tenants asking at the same moment. Run
      // together rather than one after the other, because the failure a shared
      // store invites is a URL that carries the OTHER org's prefix — and two
      // sequential calls would not put two orgs in flight over the same client.
      await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));

      // Org B holds the SAME slug in its own org — a slug is unique per org, not
      // globally, so this is a real second campaign rather than a hypothetical.
      await getBriefStore(ACME_TENANT).createBrief(makeBrief(SLUG));
      await writeReport(ACME_TENANT, resultWith(SLUG, fullRow()));

      const [localBody, acmeBody] = (await Promise.all([
        ask(LOCAL_TENANT, SLUG).then((res) => res.json() as Promise<Answered>),
        ask(ACME_TENANT, SLUG).then((res) => res.json() as Promise<Answered>),
      ])) as [Answered, Answered];

      expect(new URL(localBody.assets[0]!["outputUrl"]!).pathname).toContain("/org/local/");
      expect(new URL(acmeBody.assets[0]!["outputUrl"]!).pathname).toContain("/org/acme/");
      // Same slug, same render path, two keys — the campaign uuid is in each, so
      // neither org's URL can name the other's object even by accident.
      expect(localBody.assets[0]!["outputUrl"]).not.toBe(acmeBody.assets[0]!["outputUrl"]);
    });

    test("an input asset's key is never what a render URL points at", async () => {
      // One store serves both: renders under `renders/`, inputs under `inputs/`.
      // A key built from the wrong half would be a signed URL to somebody's
      // uploaded logo wearing a report row's field name.
      await getBriefStore(LOCAL_TENANT).createBrief(makeBrief(SLUG));
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const written = await getAssetStore(LOCAL_TENANT).writeAsset(
        SLUG,
        "logo.png",
        Buffer.from([1]),
      );
      expect(written.id).toBeDefined();

      const body = (await (await ask(LOCAL_TENANT, SLUG)).json()) as Answered;
      const input = inputKey(LOCAL_TENANT.orgId, campaignIdFor(body), written.id!);
      for (const [field, url] of Object.entries(body.assets[0]!)) {
        if (!field.endsWith("Url")) continue;
        expect(new URL(url).pathname).not.toContain(input);
      }
    });
  });
});

/** The campaign uuid the answered report's keys are under, read off its own prefix. */
function campaignIdFor(body: Answered): string {
  const marker = "/campaign/";
  const start = new URL(body.assets[0]!["outputUrl"]!).pathname.indexOf(marker) + marker.length;
  return new URL(body.assets[0]!["outputUrl"]!).pathname.slice(start, start + 36);
}
