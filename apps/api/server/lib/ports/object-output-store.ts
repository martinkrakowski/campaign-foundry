import { Readable } from "node:stream";
import {
  latestCommittedGeneration,
  PACKAGE_GENERATION_PATTERN,
  packageGenerationPrefix,
} from "@campaignfoundry/Distribution";
import {
  SAFE_ID_PATTERN,
  type ListedObject,
  type ObjectStorePort,
} from "@campaignfoundry/CampaignOrchestration";
import { packagePrefix } from "../object-store/object-keys.js";
import type { SqlClient } from "../db/sql-client.js";
import type { OutputLookup, OutputStorePort, PackageFileEntry } from "./output-store.port.js";

const MISSING: OutputLookup = { found: false, reason: "missing" };

/**
 * The one file whose presence IS the commit (PT-4h1's protocol, read here).
 * Spelled once so a reader and a writer cannot disagree about which file makes a
 * generation live — `latestCommittedGeneration` names the same one by the same
 * rule, and this is only where a reader has to build the key to `get` it.
 */
const MANIFEST_FILENAME = "manifest.json";

/**
 * The segment packaged files sit under, inside their generation. Same constant
 * `ObjectPackageStore` writes under; a reader that spelled it differently would
 * list a generation with nothing in it.
 */
const FILES_SEGMENT = "files/";

/**
 * The refusal an `open()` raises for an object that is gone. **ENOENT is the whole
 * point of it**: `[platformZip].get.ts`'s measure pass answers an ENOENT/ENOTDIR
 * with 409 "Package is being rewritten, retry", which is the truthful answer for
 * a generation swept by a newer commit between this store's `list` and the read.
 * An error with no `code` would be rethrown and become a 500 — a client's retry
 * turned into a server fault for a race that is the protocol working.
 */
function gone(): Error {
  return Object.assign(new Error("Package file is gone"), { code: "ENOENT" });
}

/**
 * ObjectOutputStore — `OutputStorePort` over `ObjectStorePort` (PT-4h2, D203,
 * D204, D209f). `FsOutputStore`'s counterpart under `OBJECT_STORE=s3`: the same
 * routes, the same arguments, the same return values — a different place to read
 * the bytes from.
 *
 * **The two `packages/` routes need no logic change, and that is what makes this
 * lane safe to land on its own.** They hold a campaign SLUG and pass it straight
 * through (`result.get.ts` resolves a uuid to a slug on a backend that has rows,
 * because the route's contract is a slug); the slug→uuid translation belongs
 * HERE, org-scoped, exactly as `ObjectAssetStore.resolveCampaignId` does it. A
 * store that keyed packages by the slug would put a user-chosen, renameable
 * string in the store's namespace, which is DoD 3 and the whole reason
 * `packagePrefix` takes ids.
 *
 * **The layout is NOT re-derived here.** `packagePrefix` (this app's key builder),
 * `packageGenerationPrefix` and `latestCommittedGeneration` (PT-4h1's, imported
 * from `@campaignfoundry/Distribution`) are the only things that know what a
 * generation is, where its files sit and when it is live. A second parser here
 * would be free to disagree about the trailing separator, and the disagreement
 * would be invisible until a `deletePrefix` emptied the wrong namespace — which
 * is the failure `ObjectPackageStore` documents for exactly that reason.
 *
 * **What "committed" buys the reader is the whole of the race story.** A
 * generation is live exactly when its `manifest.json` exists, and a committed
 * generation is immutable: PT-4h1's writer only ever sweeps generations that sort
 * strictly BEFORE the one it just committed. So a reader cannot see a package
 * half-written, and the only way an object it chose disappears is a newer commit
 * sweeping that generation between this store's `list` and the read. Both of
 * those — the re-list in {@link ObjectOutputStore.manifestOf} and the ENOENT from
 * `open()` — are that one race, answered as the retry the protocol means rather
 * than as an error.
 *
 * Org-scoped, never team-filtered, for `ObjectAssetStore`'s reason: the team
 * rules belong to `PgBriefStore` and the routes call it before they get here.
 */
export class ObjectOutputStore implements OutputStorePort {
  constructor(
    private readonly db: SqlClient,
    private readonly store: ObjectStorePort,
    private readonly orgId: string,
  ) {}

  /**
   * Always `missing` under `s3` (D204), and deliberately so rather than as an
   * unfinished adapter: the rendered output is addressed by id and served through
   * a presigned URL by the asset routes, so there is no output-root-relative path
   * for a browser to ask this store for. Answering `missing` for everything is
   * what makes a malformed `/output/` path a 404 instead of a 400 — a URL that
   * cannot name an object cannot be a valid one either. PT-4i re-anchors the
   * route; until then this is the same answer the web has seen since PT-4e.
   */
  async openOutput(_relativePath: string): Promise<OutputLookup> {
    return MISSING;
  }

  /**
   * See `OutputStorePort.listPackageManifests`: each platform's live
   * `manifest.json`, in platform-id order, unreadable and non-object manifests
   * skipped, `[]` when there are none.
   *
   * **ONE listing of the campaign's whole `packages/` prefix** answers it. The
   * platform, the generation and the file names are all segments of the keys in
   * that listing, so grouping it in process is one round trip to a bucket that is
   * not on this host — where a listing per platform would be one per platform,
   * which is the same cost as the listing this method exists to avoid. The
   * per-platform `get` below is the one thing a listing cannot answer: a listing
   * reports a manifest's SIZE, and the route has to hand back its contents.
   *
   * Grouping skips a segment that is not a well-formed platform id (`SAFE_ID`,
   * the same gate the route applies to the param) and a segment that is not a
   * well-formed generation (`PACKAGE_GENERATION_PATTERN`), which is what keeps a
   * stray key under the prefix from looking like a platform. Order is
   * `localeCompare`, because `InMemoryObjectStore` lists in INSERTION order
   * where a real bucket lists in key order, and fs sorts at `fs-output-store.ts`
   * — sorting here is what makes the three agree.
   */
  async listPackageManifests(campaignId: string): Promise<readonly object[]> {
    // Fs's own gate, kept for the same reason and at the same place
    // (`fs-output-store.ts`'s `SAFE_ID_PATTERN`): a ref that cannot be a directory
    // name cannot be a slug either, and answering `[]` without a query is the
    // answer it would have got anyway.
    if (!SAFE_ID_PATTERN.test(campaignId)) return [];
    const uuid = await this.resolveCampaignId(campaignId);
    if (uuid === undefined) return [];
    const prefix = packagePrefix(this.orgId, uuid);
    const groups = groupByPlatform(await this.store.list(prefix), prefix);

    // Concurrent per platform: `groups` is already in platform-id order, and
    // `Promise.all` keeps it.
    const manifests = await Promise.all(
      [...groups].map(([platformId, listed]) => this.manifestOf(prefix, platformId, listed)),
    );
    return manifests.filter((manifest): manifest is object => manifest !== undefined);
  }

  /**
   * See `OutputStorePort.listPackageFiles`: the files of one platform's live
   * generation, sorted by name, or `undefined` when there is no such package.
   *
   * **The names are the fs names, and that is the whole compatibility
   * requirement.** A packaged file's key drops the campaign segment
   * (`renderObjectKey` strips it — DoD 3), so `<slug>/<rest>` is what has to be
   * restored here, from the slug the ROUTE passed rather than from a lookup: fs
   * walks `packages/<slug>/<platformId>/…` and names what it finds relative to
   * that, and the real writer put the files at `packages/<slug>/<platformId>/
   * <slug>/<rest>` — the campaign-scoped relative path, verbatim. So both
   * backends zip `manifest.json` and `<slug>/<rest>`, and a customer who
   * downloaded a zip from one can read the same path out of the other.
   *
   * **One listing** answers it, exactly as the listing route's does: the platform
   * prefix carries every generation of that platform, and the chosen one's file
   * names are a subset of it. An entry is only named when its key is under the
   * chosen generation's `files/` prefix, so a generation that is not live
   * contributes nothing — which is what makes a crashed, manifest-less newer
   * generation beside a committed older one invisible to the zip.
   */
  async listPackageFiles(
    campaignId: string,
    platformId: string,
  ): Promise<readonly PackageFileEntry[] | undefined> {
    if (!SAFE_ID_PATTERN.test(campaignId) || !SAFE_ID_PATTERN.test(platformId)) return undefined;
    const uuid = await this.resolveCampaignId(campaignId);
    if (uuid === undefined) return undefined;
    const prefix = packagePrefix(this.orgId, uuid);
    const platformPrefix = this.platformPrefix(prefix, platformId);
    const listed = await this.store.list(platformPrefix);
    const generation = latestCommittedGeneration(listed, platformPrefix);
    if (generation === undefined) return undefined;

    const filesPrefix = `${packageGenerationPrefix(prefix, platformId, generation)}${FILES_SEGMENT}`;
    const entries: PackageFileEntry[] = [
      {
        name: MANIFEST_FILENAME,
        open: () => this.openFile(`${platformPrefix}${generation}/${MANIFEST_FILENAME}`),
      },
    ];
    for (const entry of listed) {
      if (!entry.key.startsWith(filesPrefix)) continue;
      const rest = entry.key.slice(filesPrefix.length);
      // An empty `rest` is a key that IS the prefix — nothing to read, and a name
      // of `<slug>/` would be a directory entry in a zip that holds no directory.
      if (rest === "") continue;
      entries.push({ name: `${campaignId}/${rest}`, open: () => this.openFile(entry.key) });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /**
   * The live manifest for one platform, or `undefined` when it has none worth
   * answering with: no committed generation, a `get` that stayed missing, or a
   * body that is not a JSON object. The last two are fs's `catch { continue }`
   * (`fs-output-store.ts`: a `readFile` of a directory or a half-written file),
   * and skipping is the whole answer — one unreadable platform's manifest must not
   * cost a campaign the others.
   *
   * **The re-list is the one retry, and it exists for exactly one race.** The
   * listing above said generation G was committed; by the time its manifest was
   * `get` it is gone, which means a newer commit for the same platform committed
   * and swept G between the two calls. Re-listing this platform's prefix once
   * finds the newer generation and serves THAT, which is the right answer: it is
   * the package the campaign has now. Once, not in a loop: a manifest still
   * missing after the re-list is skipped, like an unreadable fs manifest, so one
   * platform cannot cost the campaign the others.
   *
   * A store that REFUSES propagates, as it does in `ObjectAssetStore`: a bucket
   * that cannot be listed is a 500, and turning that into an empty listing would
   * tell a caller its campaign has no packages when the answer is unknown.
   */
  private async manifestOf(
    prefix: string,
    platformId: string,
    listed: readonly ListedObject[],
  ): Promise<object | undefined> {
    const platformPrefix = this.platformPrefix(prefix, platformId);
    const manifestKey = (generation: string): string =>
      `${platformPrefix}${generation}/${MANIFEST_FILENAME}`;
    let generation = latestCommittedGeneration(listed, platformPrefix);
    if (generation === undefined) return undefined;
    let object = await this.store.get(manifestKey(generation));
    if (object === undefined) {
      generation = latestCommittedGeneration(await this.store.list(platformPrefix), platformPrefix);
      if (generation === undefined) return undefined;
      object = await this.store.get(manifestKey(generation));
      if (object === undefined) return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(object.bytes));
    } catch {
      return undefined;
    }
    // A manifest is an OBJECT: `[]` and `null` both parse, and neither is a
    // package. Fs makes the same test on the same line
    // (`fs-output-store.ts`, `typeof parsed === "object" && !Array.isArray(...)`).
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : undefined;
  }

  /**
   * One package file as a stream. The `get` is inside the generator rather than
   * in `open()` so that the refusal arrives as an ITERATION error, which is where
   * the route's try/catch sits: `measureEntries` wraps `measure(entry.open())`,
   * and the 409 comes from catching there. Thrown eagerly it would escape before
   * the stream was ever consumed, and the route would answer 500 for the same
   * race.
   *
   * No zero-length chunk is yielded, for the reason `storeZipStream` gives: a
   * Readable that pushes one leaves the response open on Node 22. An empty object
   * is already a zero-byte chunk, and skipping it changes no CRC.
   */
  private openFile(key: string): Readable {
    const store = this.store;
    async function* chunks(): AsyncGenerator<Buffer> {
      const object = await store.get(key);
      if (object === undefined) throw gone();
      // A view over the store's own bytes, not a copy: a 100 MiB clip is held once.
      const { bytes } = object;
      if (bytes.length > 0) yield Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return Readable.from(chunks());
  }

  /**
   * `<packagePrefix><platformId>/`, the boundary between "this platform's
   * generations" and a neighbouring one. Built here and not imported, because
   * `ObjectPackageStore` keeps its own platform segment private — but the
   * generation-scoped keys all go through `packageGenerationPrefix`, which
   * asserts the composed key; this is the grouping boundary, not the layout.
   *
   * **`platformId` must already have passed `SAFE_ID_PATTERN`**, and both callers
   * have: the listing route's ids come from `groupByPlatform`, and the zip
   * route's own param was tested before it got here. The trailing separator is
   * what keeps `meta` from matching `meta-ads` — the reason the prefix is built
   * and not sliced out of a longer key.
   */
  private platformPrefix(prefix: string, platformId: string): string {
    return `${prefix}${platformId}/`;
  }

  /**
   * The campaign uuid behind a slug, or `undefined` when this org has no such
   * campaign. `org_id` is in the WHERE clause and is the whole of the tenant
   * scope — the `ObjectAssetStore.resolveCampaignId` precedent, verbatim: a slug
   * is not globally unique (the constraint is `(org_id, slug)`), so without it a
   * slug taken in another org resolves to that org's campaign and this store
   * hands back another tenant's packages. A foreign slug is ABSENT, never
   * forbidden, because the routes already answer 404 for a campaign this org
   * does not have and a second kind of answer would leak that it exists.
   *
   * NOT team-filtered, deliberately — see the class docstring.
   */
  private async resolveCampaignId(slug: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ id: string }>(
      `select id from campaign where org_id = $1 and slug = $2`,
      [this.orgId, slug],
    );
    return rows[0]?.id;
  }
}

/**
 * The campaign's `packages/` listing grouped into `platformId → its own keys`,
 * in platform-id order, skipping anything that is not a package key.
 *
 * `prefix` is sliced off each key first, so the first two segments split here are
 * the platform and the generation — the two the layout names — rather than
 * `org` and the org id, which every key carries and which would group every
 * campaign in the bucket into one phantom platform.
 *
 * Two skips, and both are `ObjectPackageStore`'s own tolerance read back rather
 * than a new rule: a segment that is not a well-formed platform id is not a
 * platform (this is what keeps `meta-manifest.json`, a stray PUT, or a neighbouring
 * writer's directory out of a listing), and a segment that is not a well-formed
 * generation is not a package at all — `latestCommittedGeneration` ignores those
 * too, so grouping without the test would only cost a pointless re-list for a
 * platform that can never commit.
 */
function groupByPlatform(
  listed: readonly ListedObject[],
  prefix: string,
): Map<string, ListedObject[]> {
  const groups = new Map<string, ListedObject[]>();
  for (const entry of listed) {
    // A key with no second segment names no generation, so it is not a package
    // key at all — `README` or a stray PUT directly under the prefix. It is the
    // same floor `latestCommittedGeneration` applies (`parts.length < 2`).
    const segments = entry.key.slice(prefix.length).split("/");
    if (segments.length < 2) continue;
    const [platformId, generation] = segments;
    if (!SAFE_ID_PATTERN.test(platformId)) continue;
    if (!PACKAGE_GENERATION_PATTERN.test(generation)) continue;
    const group = groups.get(platformId);
    if (group === undefined) groups.set(platformId, [entry]);
    else group.push(entry);
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}
