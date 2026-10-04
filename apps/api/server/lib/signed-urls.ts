import { errorMessage } from "@campaignfoundry/shared";
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
 * Nitro config because it must be the route's OWN URL, byte for byte: the web
 * does not build this string, it reads it from this module through `result.get`
 * (PT-4g2), so a URL signed here that named a different prefix than the one the
 * route answers would 404 for every asset on the one backend that must not
 * change. Under `s3` this prefix is dead — the route answers 404 there (PT-4i) —
 * and no URL below is built from it.
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
 * The seven URL fields, one per source path, in the order they are appended.
 *
 * **The disposition on the last four is what makes a `download` button a
 * download** (D209d, D212), and it is only those four. Every other field is
 * something the browser DISPLAYS — `<img src>`, `<video src>` — so a disposition
 * on those would be a download dialog on a poster, which is the opposite of what
 * they are for. `<a download>` is ignored for a cross-origin target, and a
 * presigned URL is on the store's origin by definition, so `proofUrl`,
 * `htmlBundleUrl`, `outputDownloadUrl` and `videoDownloadUrl` are the four whose
 * "download" intent cannot survive without the header. `htmlBundleUrl` is
 * signed `attachment` for a second reason: fs serves it as
 * `application/octet-stream` (there is no `.html` in the fs route's type table),
 * and stored tenant HTML must not render on the store's origin.
 *
 * **The two download fields are APPENDED, never a rewrite of the display ones**
 * (D212). A browser that has the PNG open in an `<img>` and a link that saves the
 * same bytes as a file are two different intents against one object, so they get
 * two names and two signatures: `outputUrl` displays, `outputDownloadUrl`
 * attaches, and only the latter carries a filename. Re-signing `outputUrl` with a
 * disposition instead would have made every `<img src>` a download.
 *
 * `proofUrl`'s filename is the path's LAST SEGMENT, and so is each download
 * field's. It needs no quoting or escaping inside the quoted string because the
 * key that carried it already passed `assertObjectKey`, whose alphabet is
 * `A-Za-z0-9._/-`. A name that could break out of the quotes therefore never
 * reaches this line at all.
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
  {
    field: "outputDownloadUrl",
    source: "outputPath",
    disposition: (path) => `attachment; filename="${lastSegment(path)}"`,
  },
  {
    field: "videoDownloadUrl",
    source: "videoPath",
    disposition: (path) => `attachment; filename="${lastSegment(path)}"`,
  },
];

/**
 * One field's signing outcome: the URL to append, and — when signing was
 * ATTEMPTED and the store REFUSED — the failure to report once.
 *
 * The two are separate fields rather than one `undefined` because they are
 * different events: a field this server will not sign is expected and silent
 * (a row outside its own campaign), while a store that could not sign is an
 * outage nobody would otherwise hear about. Folding them together is what made a
 * bucket outage invisible.
 */
interface FieldUrl {
  readonly url?: string;
  /** Set ONLY when `presignGet` was called and rejected. Never for a refused key. */
  readonly signingFailure?: unknown;
}

/** One row's added fields, plus the first signing failure any of its fields hit. */
interface RowUrls {
  readonly fields: Record<string, string>;
  readonly signingFailure?: unknown;
}

/**
 * One row's `*Url` fields, each present only when its source path is a non-empty
 * string and the key that path makes is one this server will sign.
 *
 * **A refused path costs that field and nothing else**, and it is SILENT.
 * `renderObjectKey` throws on a path whose first segment is not this campaign's
 * slug, and on one `assertObjectKey` refuses — a `..` segment, an empty one — so
 * the refusal is caught PER FIELD: one bad path in a report must not cost a
 * sibling's URL, and must not fail the response, because the caller asked for a
 * report and a report without one image is still a report. **Nothing is logged**,
 * for two reasons. It is expected, so a log line per refused row is noise a real
 * report with one stale path would fill. And the path is the one string here that
 * came out of stored JSON rather than out of anything that vetted it, and it
 * carries the slug a refusal must not echo into a log.
 *
 * A store that REFUSED to sign is the opposite case and is carried up in
 * `signingFailure` — see `withAssetUrls`, which warns once per request.
 */
async function urlFields(
  scope: StorageScope,
  row: Record<string, unknown>,
  target: UrlTarget,
  revision: string | undefined,
): Promise<RowUrls> {
  const fields: Record<string, string> = {};
  let signingFailure: unknown;
  for (const field of FIELDS) {
    const path = row[field.source];
    // A missing, non-string or empty path has no bytes to name, and every field
    // here is optional in the report — a motion row has no `htmlBundlePath`, and
    // a static row has no `videoPath`.
    if (typeof path !== "string" || path === "") continue;
    const answer = await assetUrl(scope, path, target, revision, field.disposition?.(path));
    if (answer.url !== undefined) fields[field.field] = answer.url;
    // Keep ONE failure however many fields hit it: five rows of a stalled bucket
    // are one outage, and five identical lines would bury it.
    signingFailure ??= answer.signingFailure;
  }
  return { fields, signingFailure };
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
): Promise<FieldUrl> {
  if (objectStore() !== "s3") return { url: outputRouteUrl(path, revision) };
  // No campaign uuid means no key that could not be shared with another
  // campaign, so there is nothing to sign. Under `s3` this is the case of a ref
  // that resolved to no row — a report stored before the campaign row existed.
  if (target.campaignId === undefined) return {};

  let key: ObjectKey;
  try {
    key =
      // THE SAME function the exporter wrote with (`ObjectExporter.keyFor`), so
      // a URL cannot name a key the store does not hold. Never a second
      // implementation, a slice or a `replace`: the segment check inside it is
      // what refuses another campaign's path, and a blind strip after the first
      // `/` would turn `p1/1x1.png` into this campaign's key.
      renderObjectKey(renderPrefix(scopeTenant(scope).orgId, target.campaignId), target.slug, path);
  } catch {
    // A key THIS SERVER will not sign — an expected, per-row outcome with nothing
    // to report: the path does not belong to this campaign, or names something
    // outside `renders/`. Silent by design; `urlFields` says why.
    return {};
  }

  try {
    const url = await objectStoreClient().presignGet(key, {
      now: signingInstant(Date.now()),
      expiresInSeconds: SIGNED_URL_EXPIRES_SECONDS,
      // D209a: the revision is a SIGNED parameter, so the browser re-fetches
      // when the bytes behind the object changed rather than on every poll tick,
      // and no client can edit it into something else.
      ...(revision === undefined ? {} : { version: revision }),
      ...(disposition === undefined ? {} : { responseContentDisposition: disposition }),
    });
    return { url };
  } catch (error) {
    // A store that could not sign — an outage, and NOT the same event as a
    // refused key. The field is omitted and the report still answers, but the
    // failure is carried up so `withAssetUrls` warns once: a bucket that cannot
    // sign is an outage, and an outage that returns 200 with images quietly
    // missing is an outage nobody finds out about.
    return { signingFailure: error };
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
 * The `*Url` keys this module mints, from the ONE field table above — so a field
 * added there is stripped here without a second list to remember to extend.
 */
const URL_FIELDS = new Set(FIELDS.map((field) => field.field));

/**
 * The row with every STORED `*Url` key removed (PT-4i, D214(f)).
 *
 * **A stored `*Url` key is not a URL this server signed, and this is the only
 * place that can say so.** The report is parsed JSON out of the database, so a row
 * may carry whatever `outputUrl` it likes: a report persisted by a build that
 * signed its own URLs, a hand-edited row, a legacy report written before this
 * module existed. A spread would leave that string in the response beside the
 * keys minted here — so a `*Url` field in an answer could be an attacker's
 * `javascript:` URL that this request never touched, and the field table's whole
 * claim (every URL in a report was signed here, under this campaign's key, in this
 * window) would be false for exactly the rows a client could be trusted least
 * about. Stripping is the rule that makes it true: **a `*Url` key that is in the
 * response was minted by THIS request, or it is not there at all** — which is why
 * this runs on both backends rather than only where the threat seemed worse, and
 * why it runs BEFORE the minted fields are appended rather than filtering after.
 *
 * **A COPY, built by skipping, never a `delete` on the row**: the row is the
 * caller's own object (`readReport` handed it over and the caller may hold it),
 * and rebuilding also keeps the position-preserving contract — a stripped key
 * takes its neighbours' places with it, and the minted ones still go on the END.
 */
function withoutStoredUrls(row: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!URL_FIELDS.has(key)) stripped[key] = value;
  }
  return stripped;
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
 * **The one exception is a stored `*Url` key, which is stripped rather than kept**
 * — see {@link withoutStoredUrls}, and D214(f): a URL in an answer is one this
 * request signed.
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
 *
 * **Neither the revision nor a signing outage may fail the report.** Before this
 * lane the route read no revision at all, so a store that could not answer one
 * cost the caller nothing; a rejection that reached the caller would turn a
 * perfectly readable report into a 500 — trading a cosmetic omission (no `v`, no
 * `?v=`) for losing the report entirely. Both degrade and both say so.
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
  const revision = await readRevision(scope, target.slug);
  let signingFailure: unknown;
  const rows = await Promise.all(
    assets.map(async (row) => {
      if (!isRecord(row)) return row;
      const answer = await urlFields(scope, row, target, revision);
      signingFailure ??= answer.signingFailure;
      // Strip BEFORE the append: the strip is what makes a `*Url` key in the
      // answer mean "minted here", and appending first would let a minted field
      // mask a stored one instead of replacing it.
      return { ...withoutStoredUrls(row), ...answer.fields };
    }),
  );
  // ONCE for the whole request, not once per field and not once per row: a report
  // of thirty creatives against a stalled bucket is one outage, and the line that
  // says so has to be findable in a log rather than lost among thirty copies.
  if (signingFailure !== undefined) {
    // The campaign's SLUG and nothing else — never the key this just failed to
    // sign, never the prefix, never the org id and never the campaign uuid, since
    // any of those would put an object's location or a tenancy boundary into a
    // log line. `target.slug` is the brief's own name in the store's terms, and on
    // fs (D179) it IS the id the caller sent.
    console.warn(
      `[result] could not sign asset URLs for ${target.slug}: ${errorMessage(signingFailure)}`,
    );
  }
  // `assets` is re-set on a spread of the report, so it keeps ITS position among
  // the top-level keys — a rebuild that appended it would move a key the client
  // may well be reading by index order.
  return { ...report, assets: rows };
}

/**
 * The report's revision, or `undefined` when the store could not say.
 *
 * **`undefined` here means "no version to sign", and never "no report".** The
 * revision only rides the URL as D209a's `v` (and fs's `?v=`) so a browser
 * re-fetches when the bytes behind an object changed; a report whose revision
 * cannot be read is still every row, every path and every field — it simply
 * loses the cache-buster, which costs a redundant download at worst. Failing the
 * request instead would cost the caller the whole report, so this catches,
 * reports, and carries on.
 */
async function readRevision(scope: StorageScope, slug: string): Promise<string | undefined> {
  try {
    return await reportRevision(scope, slug);
  } catch (error) {
    // The same rule as the signing line above: the slug, never a key, a prefix,
    // an org id or a uuid.
    console.warn(`[result] could not read the report revision for ${slug}: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * The URL an input asset's bytes are served from. `s3` ONLY — the caller
 * establishes the mode (`assets.get.ts` branches on `objectStore() === "s3"`)
 * before it asks, which is the same rule the render path follows.
 *
 * **No `version` and no disposition**, deliberately: an input asset's bytes are
 * replaced only by an upload, and the listing's `thumbnailUrl` (D209b) points at
 * this route rather than at a presigned URL — so this one URL is what a browser
 * that was handed the route URL follows, and it is drawn for `GET`, which is not
 * an attachment. A `download` on an input has to come from the client as before.
 *
 * **A `presignGet` rejection PROPAGATES, and must.** Mapping it to `undefined`
 * made `?name=` answer `Asset "<name>" not found.` for an asset whose row is right
 * there — the UI would report a file nobody deleted, and an operator reading that
 * 404 would go looking for a deletion rather than for a bucket that is refusing to
 * sign. The route answers 500 for it, which is what every other store failure in
 * this codebase answers.
 */
export async function inputAssetUrl(scope: StorageScope, key: ObjectKey): Promise<string> {
  return objectStoreClient().presignGet(key, {
    now: signingInstant(Date.now()),
    expiresInSeconds: SIGNED_URL_EXPIRES_SECONDS,
  });
}

/** What `GET /campaigns/assets?name=` answers under `s3` (D209b). */
export type InputAssetRedirect =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "missing" };

/**
 * The 302 a `?name=` request is answered with under `s3`, or `missing` when there
 * is no row to point at — which the caller turns into today's
 * `Asset "<name>" not found.` body.
 *
 * **`missing` is ONE answer now, and only that one.** It means
 * `assetObjectKey` answered `undefined`: a reference that does not resolve, or a
 * name no row of that campaign carries — ABSENT, never "forbidden", never another
 * tenant's. A store that could not sign is not an absence and does not come back
 * as one; it propagates, so a row that EXISTS can never read as missing.
 *
 * The whole `?name=`-under-`s3` answer lives here rather than in the route so
 * that the two facts it needs are decided in one place: absence is decided from
 * rows, and the row's key is the one the upload wrote. The route keeps the
 * hidden-campaign check above this and answers it before any store is asked.
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
): Promise<InputAssetRedirect> {
  const key = await getAssetStore(scope).assetObjectKey(briefId, name);
  if (key === undefined) return { kind: "missing" };
  return { kind: "redirect", location: await inputAssetUrl(scope, key) };
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
