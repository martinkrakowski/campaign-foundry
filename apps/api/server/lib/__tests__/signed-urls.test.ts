import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PipelineExecutionLog, type PipelineResult } from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { ObjectExporter } from "@campaignfoundry/Distribution";
import {
  objectStoreClient,
  resetObjectStoreClient,
  setObjectStoreClient,
} from "../object-store/index.js";
import { inputKey, renderPrefix } from "../object-store/object-keys.js";
import { readReport, reportRevision, writeReport } from "../report.js";
// The module OBJECT, so `reportRevision` can be spied on: `signed-urls.ts` calls it
// through this namespace, and these tests need a store whose revision READ fails —
// the one thing a real fs report store does not do on demand.
import * as reportModule from "../report.js";
import { resetAssetStore, setAssetStore, type AssetStorePort } from "../ports/index.js";
import {
  inputAssetRedirect,
  inputAssetUrl,
  SIGNED_URL_EXPIRES_SECONDS,
  SIGNING_WINDOW_MS,
  signingInstant,
  withAssetUrls,
  type UrlTarget,
} from "../signed-urls.js";
import { LOCAL_TENANT } from "../tenant.js";
import {
  ACME_TENANT,
  setupFsHarness,
  type FsHarness,
} from "../../routes/__tests__/tenant-harness.js";

/**
 * `lib/signed-urls.ts` offline (PT-4f, D204, D209).
 *
 * The store under test is `InMemoryObjectStore` through `setObjectStoreClient`,
 * so nothing here reads an `S3_*` variable and nothing reaches a network. What
 * the fake gives this file that a mock could not is the KEY each URL names: the
 * exporter writes the bytes, a listing reads back the key it really wrote, and
 * `get()` on the key parsed out of the URL has to hold those same bytes. A second
 * implementation of the path→key join would make that comparison tautological,
 * so there is none — the key under test is the one the exporter chose.
 *
 * The revision is REAL throughout (`writeReport` on the fs harness, read back
 * through `reportRevision`), because `?v=` and the signed `v` are the whole point
 * of it and a faked digest would assert nothing about either.
 */

const SLUG = "winter-sale";
const OTHER_SLUG = "summer-sale";
/** A campaign uuid, so `renderPrefix` builds the prefix an export hangs keys under. */
const CAMPAIGN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ASSET_ID = "00000000-0000-4000-8000-000000000000";

const PUBLIC_ENDPOINT = "https://objects.example";
const BUCKET = "campaign-foundry";

/**
 * A window boundary at an exact millisecond, so "inside" and "outside" are exact.
 *
 * It has to be a whole multiple of `SIGNING_WINDOW_MS` (1 700 000 100 000 = 1 888 889
 * windows), or "14 minutes from here" lands in the NEXT window and every same-window
 * assertion below would be testing the floor against itself.
 */
const WINDOW_START = 1_700_000_100_000;
const MINUTE = 60 * 1000;
const RENDERS = renderPrefix(LOCAL_TENANT.orgId, CAMPAIGN_ID);

const OUTPUT = `${SLUG}/p1/1x1.png`;
const VIDEO = `${SLUG}/p1/1x1.mp4`;
const FALLBACK = `${SLUG}/p1/1x1/fallback.png`;
const BUNDLE = `${SLUG}/p1/1x1/index.html`;
const PROOF = `${SLUG}/proofs/p1.pdf`;

/** Distinct bytes per field, so a URL naming another field's key is unmistakable. */
const bytesFor = (name: string): Uint8Array => new Uint8Array(Buffer.from(name, "utf8"));

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

/** A report as `writeReport` would persist it: `{ …row }` under `assets`. */
const resultWith = (campaignId: string, row: Record<string, unknown>): PipelineResult =>
  ({
    halted: false,
    assets: [row],
    log: new PipelineExecutionLog(campaignId, () => new Date("2026-01-01T00:00:00.000Z")),
  }) as unknown as PipelineResult;

/** The report a stored campaign has, read back exactly as `result.get.ts` reads it. */
const storedReportOf = (slug: string): Promise<unknown> => readReport(LOCAL_TENANT, slug);

/** What `withAssetUrls` answers, typed as the route consumes it. */
type Answered = { assets: Array<Record<string, string>> };

/** Every `*Url` key stripped off a row, so the rest can be compared to the store. */
function withoutUrls(row: unknown): unknown {
  if (typeof row !== "object" || row === null) return row;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.endsWith("Url")) kept[key] = value;
  }
  return kept;
}

/**
 * The `[result]` lines a `console.warn` spy collected, in order.
 *
 * **Filtered, because a global `console.warn` spy catches more than this module.**
 * The first `objectStore()` read in a worker runs `loadEnv()`, which announces the
 * absent image-generation keys once — a real `console.warn` on the same method.
 * Counting raw calls would make the count depend on which test happened to be
 * first, and the claim under test is about THIS module's lines.
 */
function resultWarnings(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("[result] "));
}

describe("signed-urls (PT-4f, D204/D209)", () => {
  let harness: FsHarness;
  let store: InMemoryObjectStore;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const target: UrlTarget = { slug: SLUG, campaignId: CAMPAIGN_ID };

  beforeEach(() => {
    harness = setupFsHarness();
    store = new InMemoryObjectStore({ publicEndpoint: PUBLIC_ENDPOINT, bucket: BUCKET });
    setObjectStoreClient(store);
    // `Date` ONLY: the harness awaits real I/O, and a faked `setTimeout` under a
    // migration would stall it. The window is the only clock under test.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WINDOW_START + 30_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    // Every spy here is shared state if it outlives its test: a `reportRevision`
    // left rejecting would make the NEXT test's report lose its version, and a
    // `console.warn` left mocked would swallow the next test's own line.
    vi.restoreAllMocks();
    resetAssetStore();
    resetObjectStoreClient();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    harness.cleanup();
  });

  describe("signingInstant", () => {
    test("floors to its window's start, at a boundary and either side of one", () => {
      // AT the boundary: the start of its own window, so it floors to itself.
      expect(signingInstant(WINDOW_START)).toBe(WINDOW_START);
      // JUST BEFORE: the previous window — one whole window earlier.
      expect(signingInstant(WINDOW_START - 1)).toBe(WINDOW_START - SIGNING_WINDOW_MS);
      // JUST AFTER: this window, and the floor must NOT round up to the next.
      expect(signingInstant(WINDOW_START + 1)).toBe(WINDOW_START);
      expect(signingInstant(WINDOW_START + SIGNING_WINDOW_MS - 1)).toBe(WINDOW_START);
    });

    test("one window is one instant and the next window is a different one", () => {
      const first = signingInstant(WINDOW_START);
      // 14 minutes in: the same window, so the same instant — which is what makes
      // every URL inside a window `toBe`-identical.
      expect(signingInstant(WINDOW_START + 14 * MINUTE)).toBe(first);
      expect(signingInstant(WINDOW_START + SIGNING_WINDOW_MS)).toBe(first + SIGNING_WINDOW_MS);
      expect(signingInstant(WINDOW_START + SIGNING_WINDOW_MS)).not.toBe(first);
    });

    test("the expiry outlives its window by five minutes (D204, asserted not assumed)", () => {
      // The arithmetic D204 rests on: a URL minted in a window's LAST second must
      // still be valid after that window's end, or a page loaded just before a
      // boundary would find every image, video and proof 403.
      expect(SIGNED_URL_EXPIRES_SECONDS * 1000 - SIGNING_WINDOW_MS).toBe(5 * MINUTE);
      expect(SIGNED_URL_EXPIRES_SECONDS).toBe(1200);
    });
  });

  describe("withAssetUrls on fs (OBJECT_STORE unset)", () => {
    // Item 1: before this lane the route read no revision at all, so a store that
    // could not answer one cost the caller nothing. Letting the rejection through
    // would trade a cosmetic omission for losing a report that READS FINE.
    test("a revision that cannot be read costs the ?v=, never the report", async () => {
      delete process.env.OBJECT_STORE;
      vi.spyOn(reportModule, "reportRevision").mockRejectedValue(
        new Error("connection reset by peer"),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const out = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [fullRow()] },
        {
          slug: SLUG,
          campaignId: undefined,
        },
      )) as Answered;

      // Every row, every stored key, and the URL — with no version to sign.
      expect(out.assets[0]!["productId"]).toBe("p1");
      expect(out.assets[0]!["outputUrl"]).toBe(`/api/pipeline/output/${OUTPUT}`);
      expect(out.assets[0]!["proofUrl"]).toBe(`/api/pipeline/output/${PROOF}`);
      expect(resultWarnings(warn)).toStrictEqual([
        `[result] could not read the report revision for ${SLUG}: connection reset by peer`,
      ]);
      warn.mockRestore();
    });

    test("'never ran' is answered before the revision is even read", async () => {
      delete process.env.OBJECT_STORE;
      const revision = vi.spyOn(reportModule, "reportRevision");
      // Not an object and no `assets`: there are no rows to carry a URL, so the
      // revision is not read and cannot fail a report that has nothing to say.
      for (const report of [null, "text", { halted: false, assets: { rows: [] } }]) {
        expect(await withAssetUrls(LOCAL_TENANT, report, target)).toStrictEqual(report);
      }
      expect(revision).not.toHaveBeenCalled();
    });

    test("every field is the output route plus the path, with the revision as one query", async () => {
      delete process.env.OBJECT_STORE;
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const revision = (await reportRevision(LOCAL_TENANT, SLUG))!;
      expect(revision).toMatch(/^[0-9a-f]{64}$/);

      const presign = vi.spyOn(store, "presignGet");
      const out = (await withAssetUrls(
        LOCAL_TENANT,
        await storedReportOf(SLUG),
        target,
      )) as Answered;
      const row = out.assets[0]!;

      expect(row["outputUrl"]).toBe(`/api/pipeline/output/${OUTPUT}?v=${revision}`);
      expect(row["videoUrl"]).toBe(`/api/pipeline/output/${VIDEO}?v=${revision}`);
      expect(row["htmlFallbackUrl"]).toBe(`/api/pipeline/output/${FALLBACK}?v=${revision}`);
      expect(row["htmlBundleUrl"]).toBe(`/api/pipeline/output/${BUNDLE}?v=${revision}`);
      expect(row["proofUrl"]).toBe(`/api/pipeline/output/${PROOF}?v=${revision}`);
      // fs mints no URL for the store to have signed, so it was never asked.
      expect(presign).not.toHaveBeenCalled();
    });

    test("with nothing stored there is no query at all", async () => {
      delete process.env.OBJECT_STORE;
      expect(await reportRevision(LOCAL_TENANT, "no-such-report")).toBeUndefined();

      const out = (await withAssetUrls(LOCAL_TENANT, resultWith("no-such-report", fullRow()), {
        slug: "no-such-report",
        campaignId: undefined,
      })) as Answered;

      expect(out.assets[0]!["outputUrl"]).toBe(`/api/pipeline/output/${OUTPUT}`);
      for (const [field, url] of Object.entries(out.assets[0]!)) {
        if (!field.endsWith("Url")) continue;
        expect(url).not.toContain("?");
      }
    });

    test("stripping the *Url fields gives back the stored report byte for byte", async () => {
      delete process.env.OBJECT_STORE;
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const stored = (await storedReportOf(SLUG)) as { assets: unknown[] };

      const out = (await withAssetUrls(LOCAL_TENANT, stored, target)) as { assets: unknown[] };

      // `toStrictEqual`, not `toEqual`: the claim is that a consumer reading the
      // report it already knows sees exactly that — key order, value types, and
      // the absence of anything `toEqual` would forgive.
      expect(out.assets.map(withoutUrls)).toStrictEqual(stored.assets);
    });

    test("each SEGMENT is encoded, never the whole path", async () => {
      delete process.env.OBJECT_STORE;
      // A slug or product name carrying a space, a `#` and a `?`: raw, the first
      // would break the URL and the other two would truncate it at the fragment
      // or start a query — a URL naming a DIFFERENT file.
      const spaced = `${SLUG}/p 1/a#b?c/1 x 1.png`;
      const out = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [{ outputPath: spaced }] },
        {
          slug: SLUG,
          campaignId: undefined,
        },
      )) as Answered;

      expect(out.assets[0]!["outputUrl"]).toBe(
        `/api/pipeline/output/${SLUG}/p%201/a%23b%3Fc/1%20x%201.png`,
      );
    });

    test("fs needs no campaign uuid at all, which is the deliberate asymmetry", async () => {
      delete process.env.OBJECT_STORE;
      const out = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [fullRow()] },
        {
          slug: SLUG,
          campaignId: undefined,
        },
      )) as Answered;
      expect(out.assets[0]!["outputUrl"]).toBe(`/api/pipeline/output/${OUTPUT}`);
    });
  });

  describe("withAssetUrls on s3", () => {
    beforeEach(() => {
      process.env.OBJECT_STORE = "s3";
    });

    // The s3 half of item 1: the same degrade with a signed URL, so the omission
    // is `v` rather than a whole query.
    test("a revision that cannot be read signs without `v`, never failing the report", async () => {
      vi.spyOn(reportModule, "reportRevision").mockRejectedValue(
        new Error("connection reset by peer"),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const out = (await withAssetUrls(LOCAL_TENANT, { assets: [fullRow()] }, target)) as Answered;
      const parsed = new URL(out.assets[0]!["outputUrl"]!);

      // Signed for its window as usual — only the version is missing.
      expect(parsed.pathname).toContain(`/${BUCKET}/${RENDERS}`);
      expect(parsed.searchParams.get("X-Amz-Expires")).toBe("1200");
      expect(parsed.searchParams.get("v")).toBeNull();
      expect(out.assets[0]!["productId"]).toBe("p1");
      expect(resultWarnings(warn)).toStrictEqual([
        `[result] could not read the report revision for ${SLUG}: connection reset by peer`,
      ]);
      warn.mockRestore();
    });

    /**
     * The keys the EXPORTER really wrote, read back from the store.
     *
     * This is the whole point of the per-field cases: a URL is only right if it
     * names the object the run's own exporter put there, and the only honest way
     * to say that is to let the exporter write it and then ask the store which
     * keys exist. A hand-joined expected key here would make the assertion
     * tautological — it would be the same expression twice.
     */
    async function exportedKeys(): Promise<string[]> {
      const exporter = new ObjectExporter(store, {
        prefix: RENDERS,
        campaignSegment: SLUG,
      });
      await exporter.saveToDirectory(bytesFor(OUTPUT), OUTPUT);
      await exporter.saveToDirectory(bytesFor(VIDEO), VIDEO);
      await exporter.saveToDirectory(bytesFor(FALLBACK), FALLBACK);
      await exporter.saveToDirectory(bytesFor(BUNDLE), BUNDLE);
      await exporter.saveToDirectory(bytesFor(PROOF), PROOF);
      return (await store.list(RENDERS)).map((entry) => entry.key);
    }

    /** The one field under test, with the bytes the exporter wrote behind it. */
    async function fieldUnder(
      field: string,
      path: string,
      keys: readonly string[],
    ): Promise<string> {
      // Every field is read off whichever raw row key names `path`, so this is the
      // row shape a report really carries — the `*Url` key beside it is what the
      // field table looks its path up by.
      const row: Record<string, unknown> = { productId: "p1" };
      row[field === "outputUrl" ? "outputPath" : `${field.replace(/Url$/, "")}Path`] = path;
      const out = (await withAssetUrls(LOCAL_TENANT, { assets: [row] }, target)) as Answered;
      const url = out.assets[0]![field]!;

      const key = new URL(url).pathname.slice(`/${BUCKET}/`.length);
      expect(keys).toContain(key);
      // And the object behind it is the exporter's own bytes for that path.
      expect(Buffer.from((await store.get(key))!.bytes)).toEqual(Buffer.from(bytesFor(path)));
      return url;
    }

    test("outputUrl: signed for its window, no disposition, key holds what the exporter wrote", async () => {
      const keys = await exportedKeys();
      const url = await fieldUnder("outputUrl", OUTPUT, keys);
      const parsed = new URL(url);
      expect(parsed.host).toBe("objects.example");
      // D204's path shape: /<bucket>/org/<orgId>/campaign/<uuid>/renders/<rest>
      expect(parsed.pathname).toContain(`/${BUCKET}/${RENDERS}`);
      expect(parsed.pathname.endsWith(OUTPUT.slice(SLUG.length + 1))).toBe(true);
      expect(parsed.searchParams.get("X-Amz-Expires")).toBe("1200");
      expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      // No disposition: an `<img src>` served as `attachment` is a download dialog
      // on a poster, which is the opposite of what `outputUrl` is for.
      expect(parsed.searchParams.get("response-content-disposition")).toBeNull();
    });

    test("videoUrl: no disposition, so a <video src> plays rather than downloads", async () => {
      const keys = await exportedKeys();
      const url = await fieldUnder("videoUrl", VIDEO, keys);
      expect(new URL(url).searchParams.get("response-content-disposition")).toBeNull();
    });

    test("htmlFallbackUrl: no disposition — it is the PNG the browser renders", async () => {
      const keys = await exportedKeys();
      const url = await fieldUnder("htmlFallbackUrl", FALLBACK, keys);
      expect(new URL(url).searchParams.get("response-content-disposition")).toBeNull();
    });

    test("proofUrl: attachment under the path's own last segment (D209d)", async () => {
      const keys = await exportedKeys();
      const url = await fieldUnder("proofUrl", PROOF, keys);
      // Every web consumer of a proof is a `download` link, and `download` is
      // ignored cross-origin — so only the disposition keeps it a download.
      expect(new URL(url).searchParams.get("response-content-disposition")).toBe(
        'attachment; filename="p1.pdf"',
      );
    });

    test("htmlBundleUrl: attachment, and named index.html whatever the path is called", async () => {
      const keys = await exportedKeys();
      const url = await fieldUnder("htmlBundleUrl", BUNDLE, keys);
      // Stored tenant HTML must not render on the store's origin, and fs serves it
      // as octet-stream anyway — so the bundle is only ever a download.
      expect(new URL(url).searchParams.get("response-content-disposition")).toBe(
        'attachment; filename="index.html"',
      );
    });

    test("every URL is under THIS caller's org and THIS campaign", async () => {
      await exportedKeys();
      const forLocal = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [fullRow()] },
        target,
      )) as Answered;
      for (const [field, url] of Object.entries(forLocal.assets[0]!)) {
        if (!field.endsWith("Url")) continue;
        expect(new URL(url).pathname).toContain(
          `/org/${LOCAL_TENANT.orgId}/campaign/${CAMPAIGN_ID}/`,
        );
      }
      // Org B's own caller gets B's prefix: the org comes from the caller's scope,
      // never from anything the report says about itself.
      const forAcme = (await withAssetUrls(
        ACME_TENANT,
        { assets: [fullRow()] },
        target,
      )) as Answered;
      for (const [field, url] of Object.entries(forAcme.assets[0]!)) {
        if (!field.endsWith("Url")) continue;
        expect(new URL(url).pathname).toContain(
          `/org/${ACME_TENANT.orgId}/campaign/${CAMPAIGN_ID}/`,
        );
      }
    });

    test("one window signs one URL, and the next window signs another", async () => {
      vi.setSystemTime(WINDOW_START + MINUTE);
      const first = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [fullRow()] },
        target,
      )) as Answered;
      // 14 minutes later — still the same window, so `toBe`-IDENTICAL. This is the
      // entire reason the signature is aligned: a grid polling every tick reuses
      // one cache entry instead of re-downloading every creative.
      vi.setSystemTime(WINDOW_START + 14 * MINUTE);
      const second = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [fullRow()] },
        target,
      )) as Answered;
      expect(second.assets[0]!["outputUrl"]).toBe(first.assets[0]!["outputUrl"]);
      expect(new URL(first.assets[0]!["outputUrl"]!).searchParams.get("X-Amz-Expires")).toBe(
        "1200",
      );

      // Across the boundary the window moved, so the signature did too.
      vi.setSystemTime(WINDOW_START + SIGNING_WINDOW_MS + 1);
      const third = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [fullRow()] },
        target,
      )) as Answered;
      expect(third.assets[0]!["outputUrl"]).not.toBe(first.assets[0]!["outputUrl"]);
    });

    test("the revision rides as the signed `v`, and only when one is stored", async () => {
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const first = await reportRevision(LOCAL_TENANT, SLUG);

      const withFirst = (await withAssetUrls(
        LOCAL_TENANT,
        await storedReportOf(SLUG),
        target,
      )) as Answered;
      expect(new URL(withFirst.assets[0]!["outputUrl"]!).searchParams.get("v")).toBe(first!);
      // A re-read with the revision unchanged is the IDENTICAL url — the whole
      // reason the revision went into the signature rather than into the path.
      const again = (await withAssetUrls(
        LOCAL_TENANT,
        await storedReportOf(SLUG),
        target,
      )) as Answered;
      expect(again.assets[0]!["outputUrl"]).toBe(withFirst.assets[0]!["outputUrl"]);

      // A second revision gives a second URL whose `v` is that revision.
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const second = await reportRevision(LOCAL_TENANT, SLUG);
      expect(second).toBe(first!);
      // A DIFFERENT revision, forced rather than hoped for: a byte the previous
      // write did not have.
      await writeReport(
        LOCAL_TENANT,
        resultWith(SLUG, { ...fullRow(), clickDestination: "https://example.test/" }),
      );
      const third = await reportRevision(LOCAL_TENANT, SLUG);
      expect(third).not.toBe(first!);
      const withThird = (await withAssetUrls(
        LOCAL_TENANT,
        await storedReportOf(SLUG),
        target,
      )) as Answered;
      expect(new URL(withThird.assets[0]!["outputUrl"]!).searchParams.get("v")).toBe(third!);
      expect(withThird.assets[0]!["outputUrl"]).not.toBe(withFirst.assets[0]!["outputUrl"]);

      // Nothing stored: no `v`, and the window's own expiry still stands. The
      // target names a slug with no report, which is the only way to say "no
      // revision" while a report sits under the other slug in this same test.
      const bare = (await withAssetUrls(
        LOCAL_TENANT,
        // And paths under THAT slug, since `renderObjectKey` refuses a path whose
        // first segment is not the campaign it is signing for.
        resultWith("no-such-report", { productId: "p1", outputPath: "no-such-report/p1/1x1.png" }),
        { slug: "no-such-report", campaignId: CAMPAIGN_ID },
      )) as Answered;
      const parsed = new URL(bare.assets[0]!["outputUrl"]!);
      expect(parsed.searchParams.get("v")).toBeNull();
      expect(parsed.searchParams.get("X-Amz-Expires")).toBe("1200");
    });

    test("a refused path costs ITS field only, and its siblings still answer", async () => {
      const out = (await withAssetUrls(
        LOCAL_TENANT,
        {
          assets: [
            // No campaign segment — the fixture `routes-campaign-refs.test.ts` carries.
            { productId: "p1", outputPath: "p1/1x1.png" },
            // A path belonging to ANOTHER campaign, which the segment check refuses.
            { productId: "p2", outputPath: `${OTHER_SLUG}/p2/1x1.png` },
            // A traversal out of `renders/`, which `assertObjectKey` refuses.
            { productId: "p3", outputPath: `${SLUG}/../x.png` },
            // An empty segment, which is an empty key segment.
            { productId: "p4", outputPath: `${SLUG}//x.png` },
            // The campaign segment alone, which names nothing below the campaign.
            { productId: "p5", outputPath: SLUG },
            // A sibling that must still answer.
            { productId: "p6", outputPath: OUTPUT },
          ],
        },
        target,
      )) as Answered;

      expect(out.assets.map((row) => row["outputUrl"])).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        expect.stringContaining(`/org/${LOCAL_TENANT.orgId}/`),
      ]);
      // A refusal drops one field, never the row: every stored key survives.
      expect(out.assets[0]).toStrictEqual({ productId: "p1", outputPath: "p1/1x1.png" });
      expect(Object.keys(out.assets[4]!)).toStrictEqual(["productId", "outputPath"]);
    });

    test("with no campaign uuid there is no *Url field at all", async () => {
      const out = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [fullRow()] },
        {
          slug: SLUG,
          campaignId: undefined,
        },
      )) as Answered;
      // A key needs a uuid to hang under, and there is none — so no field, rather
      // than a field naming a key in no campaign's namespace.
      expect(Object.keys(out.assets[0]!).filter((key) => key.endsWith("Url"))).toStrictEqual([]);
    });

    test("a store that cannot sign costs that field and never the response", async () => {
      vi.spyOn(store, "presignGet").mockRejectedValue(
        new Error("The object store could not be reached for presignGet."),
      );
      const out = (await withAssetUrls(LOCAL_TENANT, { assets: [fullRow()] }, target)) as Answered;
      expect(out.assets[0]!["outputUrl"]).toBeUndefined();
      // The report is still the report the caller asked for.
      expect(out.assets[0]!["productId"]).toBe("p1");
      expect(out.assets[0]!["outputPath"]).toBe(OUTPUT);
    });

    // Item 2: a refusal and an outage are DIFFERENT events, and only one of them
    // is worth a log line.
    test("a refused key is SILENT — it is expected, and the path is never echoed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const presign = vi.spyOn(store, "presignGet");
      // The three refusals `renderObjectKey` makes, in one report.
      const out = (await withAssetUrls(
        LOCAL_TENANT,
        {
          assets: [
            { productId: "p1", outputPath: "p1/1x1.png" },
            { productId: "p2", outputPath: `${OTHER_SLUG}/p2/1x1.png` },
            { productId: "p3", outputPath: `${SLUG}/../x.png` },
            { productId: "p6", outputPath: OUTPUT },
          ],
        },
        target,
      )) as Answered;

      // Nothing was signed, so nothing could fail, and nothing is logged: a report
      // with one stale path is not an incident.
      expect(presign).toHaveBeenCalledTimes(1);
      expect(resultWarnings(warn)).toStrictEqual([]);
      expect(out.assets.map((row) => row["outputUrl"])).toEqual([
        undefined,
        undefined,
        undefined,
        expect.stringContaining("/renders/p1/1x1.png"),
      ]);
      warn.mockRestore();
    });

    test("a rejecting presignGet warns ONCE per request, naming no key, prefix or org", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(store, "presignGet").mockRejectedValue(
        new Error("The object store could not be reached for presignGet."),
      );
      // FIVE fields on TWO rows: one outage, one line. A line per field would bury
      // the outage under ten identical copies of itself.
      const out = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [fullRow(), fullRow()] },
        target,
      )) as Answered;

      const lines = resultWarnings(warn);
      expect(lines).toStrictEqual([
        `[result] could not sign asset URLs for ${SLUG}: The object store could not be reached for presignGet.`,
      ]);
      // The line names the campaign and nothing that locates bytes or a tenancy.
      expect(lines[0]).not.toContain("org/");
      expect(lines[0]).not.toContain(CAMPAIGN_ID);
      expect(lines[0]).not.toContain("renders");
      // Still 200-shaped: every row, every stored key, every field omitted.
      expect(out.assets).toHaveLength(2);
      for (const row of out.assets) {
        expect(row["outputUrl"]).toBeUndefined();
        expect(row["productId"]).toBe("p1");
        expect(row["outputPath"]).toBe(OUTPUT);
      }
      warn.mockRestore();
    });
  });

  describe("the shape withAssetUrls preserves", () => {
    test("every top-level key and every row key keeps its place, and *Url is appended", async () => {
      await writeReport(LOCAL_TENANT, resultWith(SLUG, fullRow()));
      const stored = (await storedReportOf(SLUG)) as { assets: Array<Record<string, unknown>> };

      const out = (await withAssetUrls(LOCAL_TENANT, stored, target)) as {
        assets: Array<Record<string, unknown>>;
      };

      expect(Object.keys(out)).toStrictEqual(Object.keys(stored));
      expect(Object.keys(out.assets[0]!)).toStrictEqual([
        ...Object.keys(stored.assets[0]!),
        "outputUrl",
        "videoUrl",
        "htmlFallbackUrl",
        "proofUrl",
        "htmlBundleUrl",
      ]);
    });

    test("a report that is not an object, and an assets that is not an array, pass through", async () => {
      for (const report of [null, "text", 7, [1, 2]]) {
        expect(await withAssetUrls(LOCAL_TENANT, report, target)).toStrictEqual(report);
      }
      for (const assets of [undefined, null, {}, "rows"]) {
        const report = { halted: false, assets };
        expect(await withAssetUrls(LOCAL_TENANT, report, target)).toStrictEqual(report);
      }
    });

    test("a non-object row passes through untouched, beside one that answers", async () => {
      const out = (await withAssetUrls(
        LOCAL_TENANT,
        { assets: [null, "row", 3, [1], { productId: "p6", outputPath: OUTPUT }] },
        target,
      )) as { assets: unknown[] };
      expect(out.assets[0]).toBeNull();
      expect(out.assets[1]).toBe("row");
      expect(out.assets[2]).toBe(3);
      // An array row keeps its keys by INDEX, so it is not spread into either.
      expect(out.assets[3]).toStrictEqual([1]);
      expect(out.assets[4]).toMatchObject({ productId: "p6", outputUrl: expect.any(String) });
    });

    test("a path that is empty, absent or not a string carries no field", async () => {
      const out = (await withAssetUrls(
        LOCAL_TENANT,
        {
          assets: [
            { productId: "p1", outputPath: "", videoPath: 7, proofPath: null },
            { productId: "p6", outputPath: OUTPUT },
          ],
        },
        target,
      )) as Answered;
      expect(Object.keys(out.assets[0]!)).toStrictEqual([
        "productId",
        "outputPath",
        "videoPath",
        "proofPath",
      ]);
      expect(out.assets[1]!["outputUrl"]).toEqual(expect.any(String));
    });
  });

  describe("inputAssetUrl / inputAssetRedirect", () => {
    const KEY = inputKey(LOCAL_TENANT.orgId, CAMPAIGN_ID, ASSET_ID);

    /** A port fake answering one key, so this file needs no database. */
    const assetStoreAnswering = (key: string | undefined): AssetStorePort =>
      ({ assetObjectKey: vi.fn().mockResolvedValue(key) }) as unknown as AssetStorePort;

    test("under s3 it signs the key with no version and no disposition", async () => {
      process.env.OBJECT_STORE = "s3";
      await store.put(KEY, bytesFor("input"), { contentType: "image/png" });
      const parsed = new URL(await inputAssetUrl(LOCAL_TENANT, KEY));
      expect(parsed.pathname).toBe(`/${BUCKET}/${KEY}`);
      expect(parsed.searchParams.get("X-Amz-Expires")).toBe("1200");
      // An input's bytes change on upload, not on a report revision, and the
      // drawing is for a GET: no `v` to go stale and nothing to download.
      expect(parsed.searchParams.get("v")).toBeNull();
      expect(parsed.searchParams.get("response-content-disposition")).toBeNull();
    });

    // Item 3: a store that cannot sign is NOT an absence. Mapping the rejection to
    // `undefined` made `?name=` answer "Asset ... not found." for a row that is
    // right there — the UI would report a file nobody deleted, and an operator
    // reading that 404 would go looking for a deletion rather than for a bucket
    // refusing to sign.
    test("a store that refuses to sign REJECTS — never a missing asset", async () => {
      process.env.OBJECT_STORE = "s3";
      setAssetStore(assetStoreAnswering(KEY));
      vi.spyOn(store, "presignGet").mockRejectedValue(
        new Error("The object store could not be reached for presignGet."),
      );
      await expect(inputAssetUrl(LOCAL_TENANT, KEY)).rejects.toThrow("could not be reached");
      // And through the redirect: a row that EXISTS never becomes `missing`.
      await expect(inputAssetRedirect(LOCAL_TENANT, SLUG, "logo.png")).rejects.toThrow(
        "could not be reached",
      );
    });

    test("on fs the redirect never reaches the presigner — ?name= streams there", async () => {
      delete process.env.OBJECT_STORE;
      // fs's `assetObjectKey` answers `undefined` for everything, so the redirect
      // is `missing` and the route streams the bytes instead. The store is never
      // asked, which is the point: `objectStoreClient()` throws outright on fs.
      const presign = vi.spyOn(store, "presignGet");
      setAssetStore(assetStoreAnswering(undefined));
      expect(await inputAssetRedirect(LOCAL_TENANT, SLUG, "logo.png")).toStrictEqual({
        kind: "missing",
      });
      expect(presign).not.toHaveBeenCalled();
    });

    test("a row answers the redirect to its own key, and no row answers absent", async () => {
      process.env.OBJECT_STORE = "s3";
      await store.put(KEY, bytesFor("input"), { contentType: "image/png" });

      setAssetStore(assetStoreAnswering(KEY));
      expect(await inputAssetRedirect(LOCAL_TENANT, SLUG, "logo.png")).toStrictEqual({
        kind: "redirect",
        location: await inputAssetUrl(LOCAL_TENANT, KEY),
      });

      // `missing` is ONE answer and it means `assetObjectKey` said `undefined`.
      setAssetStore(assetStoreAnswering(undefined));
      expect(await inputAssetRedirect(LOCAL_TENANT, SLUG, "missing.png")).toStrictEqual({
        kind: "missing",
      });
    });

    test("the store is the process's one client, and fs never asks it for anything", async () => {
      process.env.OBJECT_STORE = "s3";
      // Built once per process (`lib/object-store/index.ts`), never per request: a
      // second client would be a second signer with its own credentials.
      expect(objectStoreClient()).toBe(store);

      delete process.env.OBJECT_STORE;
      const presign = vi.spyOn(store, "presignGet");
      await withAssetUrls(
        LOCAL_TENANT,
        { assets: [fullRow()] },
        {
          slug: SLUG,
          campaignId: undefined,
        },
      );
      expect(presign).not.toHaveBeenCalled();
    });
  });
});
