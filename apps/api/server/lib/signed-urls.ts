import { renderObjectKey } from "@campaignfoundry/Distribution";
import type { ObjectKey } from "@campaignfoundry/CampaignOrchestration";
import { objectStore } from "./config.js";
import { objectStoreClient } from "./object-store/index.js";
import { renderPrefix } from "./object-store/object-keys.js";
import { getAssetStore } from "./ports/index.js";
import { reportRevision } from "./report.js";
import { scopeTenant, type StorageScope } from "./run-environment.js";

/**
 * Every URL this server hands a browser (PT-4f, D204, D209).
 *
 * **This module is the ONLY place one is built.** The adapters deliberately
 * cannot: a key is a store's business and an origin is a caller's, so an adapter
 * that minted a URL would have to know which host the browser can reach — the
 * very thing `S3_PUBLIC_ENDPOINT` exists to keep out of an adapter. It is also
 * why the two backends are decided HERE, by {@link objectStore}, and never by a
 * capability a store happens to lack.
 */

/** D204: signing is aligned to a window so one window's URLs are one cache entry. */
export const SIGNING_WINDOW_MS = 15 * 60 * 1000;

/**
 * D204: a 20-minute expiry on a 15-minute window.
 *
 * **The five minutes of overlap are the design, not slack.** A URL minted in the
 * last second of a window stays valid for five minutes past the window's end, so
 * a browser that fetched at the last instant is still inside its own expiry while
 * the next poll mints the next window's URL. Aligning the signature without
 * overlapping the expiry would produce exactly the bug this lane exists to fix: a
 * page that loaded a moment before a boundary would find every image, video and
 * proof 403, and the window would have to be wide enough to hide it instead.
 */
export const SIGNED_URL_EXPIRES_SECONDS = 20 * 60;

/**
 * The instant a signature for `now` must be made at: `now` floored to its
 * window's start.
 *
 * Pure, and free of `Date`, so the window is a thing a test can state rather than
 * something it has to arrange a clock around — the port takes `now` as an option
 * for exactly this reason. Floored, not rounded: rounding would put half a window
 * on either side of a boundary, and two calls a second apart would straddle it.
 */
export function signingInstant(now: number): number {
  return Math.floor(now / SIGNING_WINDOW_MS) * SIGNING_WINDOW_MS;
}

/**
 * Where the fs backend's renders live — the route that gates them
 * (`routes/output/[...path].get.ts`) behind the traversal and team checks.
 *
 * It is this literal and not `render-target.ts`'s or a constant read from the
 * Nitro config because the web builds the same string today from its own `API`
 * prefix (`grid/page.tsx`, `export/page.tsx`), and a URL the server signs must be
 * byte-for-byte the one the client would have built — otherwise PT-4g's switch is
 * a change in behaviour on fs, which is the one backend that must not change.
 */
const OUTPUT_ROUTE_PREFIX = "/api/pipeline/output/";

/** Where one campaign's renders and proofs live, and which slug their paths carry. */
export interface UrlTarget {
  /** The campaign's stored slug — the first segment of every render path. */
  readonly slug: string;
  /**
   * The campaign's uuid, or `undefined` where there is none: on fs the id IS the
   * slug (D179), and under `s3` a ref that resolved to no row has no uuid to key
   * under. **It is the caller's own org-scoped resolve that produced it**, never
   * a lookup repeated here — a second resolve is a second answer to "which
   * campaign is this", and two answers to one question is how a key ends up under
   * a namespace the caller never proved it may read.
   */
  readonly campaignId: string | undefined;
}

/** One `*Url` field: the row path it comes from, and how the store must serve it. */
interface AssetUrlField {
  /** The key appended to a report row. */
  readonly field: string;
  /** The RAW row key whose string is the source. */
  readonly source: string;
  /**
   * The signed disposition for this field, as a function of the row's path:
   * absent renders the bytes in place, and a string forces a download under the
   * filename it returns.
   */
  readonly disposition?: (path: string) => string;
}

/** The filename a path's own last segment carries — `<slug>/proofs/<id>.pdf` → `<id>.pdf`. */
const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * The five URL fields, one per source path, in the order they are appended.
 *
 * **The disposition on the last two is what makes a `download` button a download**
 * (D209d), and it is only those two. Every other field is something the browser
 * DISPLAYS — `<img src>`, `<video src>` — so a disposition on those would be a
 * download dialog on a poster, which is the opposite of what they are for. `<a
 * download>` is ignored for a cross-origin target, and a presigned URL is on the
 * store's origin by definition, so `proofUrl` and `htmlBundleUrl` are the two
 * whose "download" intent cannot survive without the header. `htmlBundleUrl` is
 * signed `attachment` for a second reason: fs serves it as
 * `application/octet-stream` (there is no `.html` in the fs route's type table),
 * and stored tenant HTML must not render on the store's origin.
 *
 * `proofUrl`'s filename is the path's LAST SEGMENT, and it needs no quoting or
 * escaping inside the quoted string because the key that carried it already passed
 * `assertObjectKey`, whose alphabet is `A-Za-z0-9._/-`. A name that could break
 * out of the quotes therefore never reaches this line at all.
 */
const FIELDS: readonly AssetUrlField[] = [
  { field: "outputUrl", source: "outputPath" },
  { field: "videoUrl", source: "videoPath" },
  { field: "htmlFallbackUrl", source: "htmlFallbackPath" },
  {
    field: "proofUrl",
    source: "proofPath",
    disposition: (path) => `attachment; filename="${lastSegment(path)}"`,
  },
  {
    field: "htmlBundleUrl",
    source: "htmlBundlePath",
    disposition: () => 'attachment; filename="index.html"',
  },
];

/**
 * One row's `*Url` fields, each present only when its source path is a non-empty
 * string and the key that path makes is one this server will sign.
 *
 * **A refused path costs that field and nothing else.** `renderObjectKey` throws
 * on a path whose first segment is not this campaign's slug, and on one
 * `assertObjectKey` refuses — a `..` segment, an empty one — so the refusal is
 * caught PER FIELD: one bad path in a report must not cost a sibling's URL, and
 * must not fail the response, because the caller asked for a report and a report
 * without one image is still a report. **Nothing is logged**: the path is the one
 * string here that came out of stored JSON rather than out of anything that vetted
 * it, and it carries the slug a refusal must not echo into a log.
 */
async function urlFields(
  scope: StorageScope,
  row: Record<string, unknown>,
  target: UrlTarget,
  revision: string | undefined,
): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const field of FIELDS) {
    const path = row[field.source];
    // A missing, non-string or empty path has no bytes to name, and every field
    // here is optional in the report — a motion row has no `htmlBundlePath`, and
    // a static row has no `videoPath`.
    if (typeof path !== "string" || path === "") continue;
    const url = await assetUrl(scope, path, target, revision, field.disposition?.(path));
    if (url !== undefined) fields[field.field] = url;
  }
  return fields;
}

/**
 * The URL for one path: a presigned GET under `s3`, the route URL under fs.
 *
 * **The branch is `objectStore()`, never what a store could answer.** fs answers
 * `assetObjectKey` with `undefined` for everything and has no object store at all,
 * so a branch written as "if there is a key, sign it" would ask fs the question
 * and take `undefined` for an absence of keys rather than for an absence of the
 * object store — and `pg` with `OBJECT_STORE=fs`, which is staging's shape today,
 * would then mint bucket URLs for a deployment that has no bucket. The mode is the
 * deployment's own explicit switch (`config.ts`), and it is the same switch the
 * asset store's registry and the exporter's are built on.
 */
async function assetUrl(
  scope: StorageScope,
  path: string,
  target: UrlTarget,
  revision: string | undefined,
  disposition: string | undefined,
): Promise<string | undefined> {
  if (objectStore() !== "s3") return outputRouteUrl(path, revision);
  // No campaign uuid means no key that could not be shared with another
  // campaign, so there is nothing to sign. Under `s3` this is the case of a ref
  // that resolved to no row — a report stored before the campaign row existed.
  if (target.campaignId === undefined) return undefined;
  try {
    return await objectStoreClient().presignGet(
      // THE SAME function the exporter wrote with (`ObjectExporter.keyFor`), so
      // a URL cannot name a key the store does not hold. Never a second
      // implementation, a slice or a `replace`: the segment check inside it is
      // what refuses another campaign's path, and a blind strip after the first
      // `/` would turn `p1/1x1.png` into this campaign's key.
      renderObjectKey(renderPrefix(scopeTenant(scope).orgId, target.campaignId), target.slug, path),
      {
        now: signingInstant(Date.now()),
        expiresInSeconds: SIGNED_URL_EXPIRES_SECONDS,
        // D209a: the revision is a SIGNED parameter, so the browser re-fetches
        // when the bytes behind the object changed rather than on every poll tick,
        // and no client can edit it into something else.
        ...(revision === undefined ? {} : { version: revision }),
        ...(disposition === undefined ? {} : { responseContentDisposition: disposition }),
      },
    );
  } catch {
    // A key this server will not sign, or a store that could not be asked for a
    // signature: this field is absent and the report still answers. The path is
    // never echoed — see `urlFields`.
    return undefined;
  }
}

/**
 * The fs URL for a stored render path: the output route plus the path, plus the
 * revision as one query (D209c).
 *
 * **Each SEGMENT through `encodeURIComponent`, never the whole path.** A space in
 * a campaign or product name would otherwise become a raw space in the URL, and a
 * `#` or `?` in one would truncate the path at the fragment or start a query —
 * which is a URL that points at a different file. Per segment is also what the
 * server-side parser expects, since it splits on `/` before it decodes. On today's
 * ids this is the identity (`encodeURIComponent` leaves `A-Za-z0-9-._~` and `/`
 * alone within a segment), so it is byte-for-byte the URL the web builds today.
 *
 * **Exactly one query, and only when there is a revision.** PT-4g drops the web's
 * client-side `?v=` counter on both backends, and a second `?v=` would arrive only
 * if something appended one to a URL that already carries it — so the revision is
 * here, once, rather than added by whoever reads the URL.
 */
function outputRouteUrl(path: string, revision: string | undefined): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = `${OUTPUT_ROUTE_PREFIX}${encoded}`;
  return revision === undefined ? url : `${url}?v=${encodeURIComponent(revision)}`;
}

/**
 * A report with a URL per asset appended to every row (D204).
 *
 * **It is additive and position-preserving, which is the whole contract.** Every
 * top-level key stays where it was, every existing row key stays where it was, and
 * the `*Url` keys go on the END of the row — so a consumer reading the report it
 * already knows keeps reading the report it already knows, and the web's
 * `PersistedAsset` type gains nothing it has to understand today. The `*Url`
 * fields are deliberately NOT on `PersistedAsset` (`report.ts`): that type
 * describes a persisted ROW, and a URL is minted per response by this module.
 *
 * **The fields are read off the RAW row, not off `PersistedAsset`.** The report
 * `writeReport` persists is a `GeneratedAsset` spread, so it carries `proofPath`
 * and whatever else the entity had, and `PersistedAsset` declares only a subset of
 * that — so a typed read would find no proof to name. Which is also why this does
 * not filter rows with `isPersistedAsset`: that guard answers "is this row
 * PACKAGEABLE", and a row it would drop for a cosmetic defect still has an output
 * path a browser can fetch.
 *
 * `report` is `unknown` on purpose. It came out of `readReport`, which parses
 * stored JSON, so a non-object (including a JSON `null`) and an `assets` that is
 * not an array are both ordinary answers rather than errors — and both are
 * returned unchanged.
 */
export async function withAssetUrls(
  scope: StorageScope,
  report: unknown,
  target: UrlTarget,
): Promise<unknown> {
  if (!isRecord(report)) return report;
  const assets = report["assets"];
  // Not an array: there are no rows to add fields to, so the report is returned
  // exactly as read. Every other top-level key rides through untouched.
  if (!Array.isArray(assets)) return report;
  // AFTER the body was read, never before: a revision older than the bytes it is
  // signed beside would hand a browser a URL whose `v` says the object it holds
  // is the previous one, and the re-fetch that would fix it happens a poll later.
  // The two reads are not atomic and are not made atomic — the race between them
  // heals on the next poll, and closing it would mean a transaction over two
  // stores to save one tick of staleness.
  const revision = await reportRevision(scope, target.slug);
  const rows = await Promise.all(
    assets.map(async (row) =>
      isRecord(row) ? { ...row, ...(await urlFields(scope, row, target, revision)) } : row,
    ),
  );
  // `assets` is re-set on a spread of the report, so it keeps ITS position among
  // the top-level keys — a rebuild that appended it would move a key the client
  // may well be reading by index order.
  return { ...report, assets: rows };
}

/**
 * The URL an input asset's bytes are served from: a presigned GET under `s3`, and
 * `undefined` on fs, where `?name=` streams the bytes and no URL is ever minted.
 *
 * **No `version` and no disposition**, deliberately: an input asset's bytes are
 * replaced only by an upload, and the listing's `thumbnailUrl` (D209b) points at
 * this route rather than at a presigned URL — so this one URL is what a browser
 * that was handed the route URL follows, and it is drawn for `GET`, which is not
 * an attachment. A `download` on an input has to come from the client as before.
 */
export async function inputAssetUrl(
  scope: StorageScope,
  key: ObjectKey,
): Promise<string | undefined> {
  if (objectStore() !== "s3") return undefined;
  try {
    return await objectStoreClient().presignGet(key, {
      now: signingInstant(Date.now()),
      expiresInSeconds: SIGNED_URL_EXPIRES_SECONDS,
    });
  } catch {
    // A store that could not sign: the route answers its own 404 rather than
    // redirecting a browser to a URL that is not there. The key is never echoed.
    return undefined;
  }
}

/** What `GET /campaigns/assets?name=` answers under `s3` (D209b). */
export type InputAssetRedirect =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "missing" };

/**
 * The 302 a `?name=` request is answered with under `s3`, or `undefined` when
 * there is no object to point at — which the caller turns into today's
 * `Asset "<name>" not found.` body.
 *
 * The whole `?name=`-under-`s3` answer lives here rather than in the route so
 * that the two facts it needs are decided in one place: a reference with no row
 * is ABSENT (never "forbidden", never another tenant's), and the row's key is the
 * one the upload wrote. The route keeps the hidden-campaign check above this and
 * answers it before any store is asked.
 *
 * **No HEAD round-trip**, which is a deliberate change from `readAsset`'s 404: an
 * object gone from under a row that exists is the store's own 404 after the
 * redirect, and asking the store whether the bytes are there would double the
 * round trips of every thumbnail in a listing for an answer the browser is about
 * to get anyway.
 */
export async function inputAssetRedirect(
  scope: StorageScope,
  briefId: string,
  name: string,
): Promise<InputAssetRedirect | undefined> {
  const key = await getAssetStore(scope).assetObjectKey(briefId, name);
  if (key === undefined) return { kind: "missing" };
  const location = await inputAssetUrl(scope, key);
  return location === undefined ? { kind: "missing" } : { kind: "redirect", location };
}

/**
 * A JSON object, and only that. An array is excluded on purpose: a report row is
 * an object, and a row that is an array carries its keys by index — spreading one
 * would produce a row whose `*Url` fields sit among indices rather than after the
 * keys the client reads.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
