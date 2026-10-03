import { randomUUID } from "node:crypto";
import {
  assertObjectKey,
  type ListedObject,
  type ObjectKey,
  type ObjectStorePort,
} from "@campaignfoundry/CampaignOrchestration";
import type {
  PackageManifest,
  PackageStorePort,
} from "../../application/ports/out/PackageStorePort.js";
import { EXPORT_INTERRUPTED_MESSAGE } from "./FileSystemPackageStore.js";
import { contentTypeFor, renderObjectKey } from "./ObjectExporter.js";

/**
 * The ids the platform profiles are keyed by, in the shape a key segment may
 * take. Checked rather than trusted for the reason `segment()` in
 * `object-keys.ts` is: the whole tenancy claim of this adapter is that a package
 * lands under ITS OWN platform's namespace, and a platform id carrying a `/` or a
 * `..` would make that a claim rather than a fact — it would name a directory
 * above the campaign, or a sibling campaign's, and the error would surface as a
 * listing that shows the wrong package.
 */
const PLATFORM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * What one package write's generation segment looks like: a zero-padded 13-digit
 * millisecond stamp, a separator, and a 32-char lowercase hex nonce.
 *
 * **The pad is what makes lexical order time order.** A real S3 listing is sorted
 * by key, and `InMemoryObjectStore` deliberately is not (it answers in INSERTION
 * order), so the two disagree — which means a reader must sort the generation
 * itself rather than trust what it was handed. That is only the same answer on
 * both when the segment is fixed-width: at 13 digits, every stamp is the same
 * length, so `2026-…` sorts after `1999-…` the same way the numbers compare, and
 * "newest wins" needs no clock of its own to be right.
 *
 * The nonce is what makes two writes in the same millisecond two generations
 * rather than one: without it two exports of one campaign could mint the same
 * segment, and the second would overwrite the first's files in place instead of
 * landing beside it.
 */
export const PACKAGE_GENERATION_PATTERN = /^\d{13}-[0-9a-f]{32}$/;

/** The one file whose presence IS the commit. Never a real packaged creative. */
const MANIFEST_FILENAME = "manifest.json";

/** A manifest is JSON, and is stored as such — never sniffed on the way back. */
const MANIFEST_CONTENT_TYPE = "application/json";

/**
 * The segment every key of a PACKAGE carries, which is also the first segment of
 * the path `writePackaged` returns. It is the fs backend's `packages/` directory
 * spelled as a path prefix, and it is deliberately NOT a key: on fs a package
 * lives under the output root and is named by a directory, while here it lives
 * under a campaign's `packages/` key prefix (DoD 3 — a package key must not
 * carry the slug either, and the two shapes only look alike from the outside).
 */
const PACKAGES_SEGMENT = "packages/";

/** Packaged files sit under this segment, so a manifest can never be one of them. */
const FILES_SEGMENT = "files/";

/**
 * Every manifest field that names a packaged file, in the order the fs adapter
 * checks them. `posterPath` and `fallbackPath` are motion- and html-only and
 * drop out of the serialized manifest when absent, so this is the whole of what
 * a commit claims to have written.
 */
function claimedPaths(manifest: PackageManifest): readonly string[] {
  return manifest.items.flatMap((item) =>
    [item.packagedPath, item.posterPath, item.fallbackPath].filter(
      (path): path is string => path !== undefined,
    ),
  );
}

/**
 * The prefix of one generation of one platform's package:
 * `<packagePrefix><platformId>/<generation>/`, trailing separator included.
 *
 * **Exported as pure helpers, and this file is their only implementation.** The
 * read side needs to name a generation to answer "which one is live", and the
 * write side needs to name one to write into it; a second builder would be free
 * to disagree about the trailing separator, and the disagreement is invisible
 * until a `deletePrefix` empties the wrong namespace.
 *
 * The platform id is checked, the generation is not. Readers must tolerate a
 * segment they do not recognise (see {@link PACKAGE_GENERATION_PATTERN}), so a
 * builder that refused a malformed generation would make them unable to look at
 * all; `assertObjectKey` still refuses the composed key, which is what keeps a
 * `..` out of a prefix regardless of what it was minted from.
 */
export function packageGenerationPrefix(
  packagePrefix: string,
  platformId: string,
  generation: string,
): ObjectKey {
  const key = `${packagePrefix}${platformSegment(platformId)}${generation}/`;
  assertObjectKey(key);
  return key;
}

/** `<platformId>/`, checked. The trailing separator is what keeps `meta` from
 *  matching `meta-ads` — the reason the platform prefix is built and not sliced. */
function platformSegment(platformId: string): string {
  if (!PLATFORM_ID_PATTERN.test(platformId)) {
    throw new Error(`Refusing an object key: the platform id is not a well-formed id.`);
  }
  return `${platformId}/`;
}

/**
 * The generation a reader should use for `platformPrefix`, or `undefined` when
 * that platform has none committed yet.
 *
 * **A generation is committed exactly when its `manifest.json` exists**, which
 * is the whole of the commit protocol: a PUT is atomic, so the files of a
 * generation appear one at a time and a reader that could see them would read a
 * half-written package. A manifest written last is therefore the only thing that
 * may be consulted, and a generation without one is invisible — it will be swept
 * by the next successful commit for that platform.
 *
 * **It sorts the generations itself and never trusts the order it was handed.**
 * A real bucket lists in key order and `InMemoryObjectStore` lists in insertion
 * order, so "the last one" means two different things to the two stores. Sorting
 * here is what makes the answer the same offline and online — and the narrow
 * window between them is exactly when a reader would otherwise read the older of
 * two near-simultaneous exports.
 *
 * `listed` is the listing of the PLATFORM prefix (`<packagePrefix><platformId>/`),
 * not of the package prefix: a generation's own prefix would have to be guessed
 * before anything is known of it, which is the question being asked here.
 *
 * **A key under the platform prefix that is not a well-formed generation is
 * ignored**, and a listed key whose shape this does not recognise cannot become a
 * deletion either. That is deliberate in both directions: an unrecognised key is
 * something another writer put there, and this adapter has no business reading
 * it as a package or emptying it at commit time.
 */
export function latestCommittedGeneration(
  listed: readonly ListedObject[],
  platformPrefix: string,
): string | undefined {
  const committed = new Set<string>();
  for (const entry of listed) {
    const generation = generationSegmentOf(entry.key, platformPrefix);
    if (generation === undefined) continue;
    if (entry.key === `${platformPrefix}${generation}/${MANIFEST_FILENAME}`) {
      committed.add(generation);
    }
  }
  return [...committed].sort().at(-1);
}

/**
 * The generation `key` belongs to under `platformPrefix`, or `undefined` when it
 * is not under it, names no generation, or names one that does not parse.
 *
 * The `parts.length` floor is what stops a bare platform marker from parsing as
 * a generation with nothing under it: `<platformId>/` splits to a single empty
 * segment, and a generation with no manifest and no files is not a generation
 * anyone can read or sweep.
 */
function generationSegmentOf(key: string, platformPrefix: string): string | undefined {
  if (!key.startsWith(platformPrefix)) return undefined;
  const parts = key.slice(platformPrefix.length).split("/");
  if (parts.length < 2) return undefined;
  return PACKAGE_GENERATION_PATTERN.test(parts[0]!) ? parts[0] : undefined;
}

export interface ObjectPackageStoreOptions {
  /** `org/<orgId>/campaign/<campaignId>/renders/`, from `renderPrefix`. */
  readonly renderPrefix: string;
  /** `org/<orgId>/campaign/<campaignId>/packages/`, from `packagePrefix`. */
  readonly packagePrefix: string;
  /** The brief id every path this store accepts starts with. Never stored. */
  readonly campaignSegment: string;
  /** The clock a generation's stamp reads. Injected so ordering is testable. */
  readonly now?: () => number;
  /** 32 lowercase hex characters. Defaults to a `randomUUID()` without hyphens. */
  readonly nonce?: () => string;
}

/**
 * ObjectPackageStore — `PackageStorePort` over `ObjectStorePort` (PT-4h1, D203,
 * D209f). The fs adapter's counterpart under `OBJECT_STORE=s3`: same relative
 * paths, same return values, same X23 interruption — a different place to put the
 * bytes.
 *
 * **Each package write goes to a FRESH GENERATION, and the generation becomes
 * live when, and only when, its `manifest.json` exists.** The obvious object
 * shape — a fixed live prefix under the platform, filled from a staging prefix by
 * `copy` and then swept — is not atomic as a group: a reader listing that prefix
 * during the copy sees a mixture of the old and new package, and a mixture of two
 * complete packages is a package nobody can ship. A generation is invisible until
 * its manifest names it, so a reader's choice is between two whole packages and
 * never between halves of either.
 *
 * `writePackaged` mints the generation and returns the fs-shaped LOGICAL path
 * (`packages/<campaignSegment>/<platformId>/<relativePath>`), never a key. That
 * is what goes into the manifest, so the manifest a customer receives names the
 * same paths on both backends and a read of it needs no knowledge of generations
 * at all — the translation happens once, in `latestCommittedGeneration`.
 *
 * It holds one Map for the same reason the fs adapter holds its `staging` Map: a
 * campaign's package is written by many `writePackaged` calls and committed by one
 * `writeManifest`, and every file must land in the generation that manifest will
 * name. The entry is dropped at the commit, so a second package for the same
 * platform on the same instance mints a second generation and supersedes the first
 * by sweeping it, exactly as a second fs staging dir supersedes the first.
 */
export class ObjectPackageStore implements PackageStorePort {
  /** platformId → the generation this instance is writing into it. */
  private readonly generations = new Map<string, string>();
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(
    private readonly store: ObjectStorePort,
    private readonly options: ObjectPackageStoreOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.nonce = options.nonce ?? (() => randomUUID().replace(/-/g, ""));
  }

  /**
   * Read one already-rendered creative, from the RENDERS prefix and never from a
   * package: packaging copies a render, and a package is this adapter's own
   * output, so reading one back would make a re-package of a re-package possible.
   *
   * A missing render throws the fs adapter's exact message. The caller turns that
   * into a 422, so the same absent creative answers the same body whichever
   * backend it was asked for on.
   */
  async readAsset(relativePath: string): Promise<Uint8Array> {
    const key = renderObjectKey(
      this.options.renderPrefix,
      this.options.campaignSegment,
      relativePath,
    );
    const object = await this.store.get(key);
    if (object === undefined) {
      throw new Error(`Asset not found: ${relativePath}`);
    }
    return object.bytes;
  }

  /**
   * Write one packaged file into this platform's generation, and return where it
   * will LIVE rather than where it is being written — the fs path, so the
   * manifest is byte-for-byte the manifest the fs backend produces.
   *
   * `renderObjectKey` is the one key builder, over a `<generation>/files/` prefix
   * rather than the renders one. `relativePath` is what
   * `PackageForPlatformUseCase` passes — `asset.outputPath` — which
   * `campaignScoped` made `<campaignSegment>/…`; without that strip a packaged key
   * would carry the slug, which is DoD 3 and a rename changing an address.
   */
  async writePackaged(
    platformId: string,
    relativePath: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const generation = await this.generationFor(platformId);
    const key = renderObjectKey(
      `${packageGenerationPrefix(this.options.packagePrefix, platformId, generation)}${FILES_SEGMENT}`,
      this.options.campaignSegment,
      relativePath,
    );
    await this.store.put(key, bytes, { contentType: contentTypeFor(relativePath) });
    return this.logicalPath(platformId, relativePath);
  }

  /**
   * Commit this platform's generation: prove it is whole, make it live, then
   * retire the ones it supersedes. In that order, and each step for its own
   * reason.
   *
   * (1) The claim check, BEFORE anything is committed, so a request that cannot
   * finish leaves the previously live generation exactly as it was — the same
   * ordering the fs adapter's `assertManifestFilesStaged` has, and for the same
   * reason. It lists this generation ONCE: the listing is a round trip to a
   * bucket that is not on this host, and every claimed file maps to exactly one
   * key, so one listing answers the whole manifest.
   *
   * (2) The manifest PUT, which IS the commit. Nothing before it is readable and
   * nothing after it is.
   *
   * (3) The sweep of every generation that sorts strictly BEFORE this one,
   * committed or not. Strictly before is the whole rule: a generation newer than
   * this one belongs to a request that is still in flight, and emptying it would
   * fail that request's own claim check — turning a slower writer into a crash
   * rather than letting it finish. An UNCOMMITTED older generation is swept too,
   * which is what a crash mid-write leaves behind: invisible to readers either
   * way, and reclaimed here rather than accumulating.
   *
   * (4) The fs-shaped logical path, because that is what the manifest and the
   * route's answer both carry.
   *
   * **A sweep that FAILS does not fail the request.** The commit has already
   * happened by then, so the package is whole and live; reporting a failure would
   * tell the export screen that an export which succeeded did not, and the next
   * commit for that platform sweeps the same generations anyway. This is the one
   * place a step is allowed not to be atomic with the one before it, and it is
   * the step whose work is pure garbage collection.
   */
  async writeManifest(platformId: string, manifest: PackageManifest): Promise<string> {
    const generation = await this.generationFor(platformId);
    await this.assertGenerationWhole(platformId, generation, manifest);
    await this.store.put(
      `${packageGenerationPrefix(this.options.packagePrefix, platformId, generation)}${MANIFEST_FILENAME}`,
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      { contentType: MANIFEST_CONTENT_TYPE },
    );
    this.generations.delete(platformId);
    // Step (3) alone, and swallowed here and nowhere else — steps (1) and (2)
    // still propagate, because those are the ones that decide whether a package exists.
    try {
      await this.sweepOlderGenerations(platformId, generation);
    } catch {
      // The next commit for this platform sweeps the same generations.
    }
    return this.logicalPath(platformId, MANIFEST_FILENAME);
  }

  /**
   * The generation this instance writes into for `platformId`, minted on the
   * first call for it. Kept per platform and not per store, so one store serves
   * every platform in a multi-platform request without their files interleaving.
   */
  private async generationFor(platformId: string): Promise<string> {
    const existing = this.generations.get(platformId);
    if (existing !== undefined) return existing;
    // Checked before a generation is minted rather than on the first PUT, so a
    // platform id that cannot be a key segment fails before anything is written
    // and before a manifest could name a key that was never created.
    platformSegment(platformId);
    const generation = `${String(this.now()).padStart(13, "0")}-${this.nonce()}`;
    this.generations.set(platformId, generation);
    return generation;
  }

  /**
   * Every file this manifest is about to claim is actually in this generation
   * (X23).
   *
   * A claimed path is one this store returned from `writePackaged`, so it arrives
   * in the fs shape `packages/<campaignSegment>/<platformId>/<relativePath>`;
   * stripping exactly that prefix gives back the `relativePath` the key was built
   * from, and `renderObjectKey` over the generation's `files/` prefix rebuilds the
   * key to look for. Both refusals — a path that does not carry this platform's
   * own prefix, and one that will not map to a key — answer the interruption, as
   * they do on fs, so a caller cannot tell which backend it is on.
   *
   * What this catches is the other writer: a request whose generation was swept
   * by a newer commit for the same platform finds its own keys gone at commit
   * time, and stops rather than committing a manifest that names files that are
   * not there.
   */
  private async assertGenerationWhole(
    platformId: string,
    generation: string,
    manifest: PackageManifest,
  ): Promise<void> {
    const prefix = `${PACKAGES_SEGMENT}${this.options.campaignSegment}/${platformId}/`;
    const filesPrefix = `${packageGenerationPrefix(this.options.packagePrefix, platformId, generation)}${FILES_SEGMENT}`;
    const listed = await this.store.list(
      packageGenerationPrefix(this.options.packagePrefix, platformId, generation),
    );
    const stored = new Set(listed.map((entry) => entry.key));
    for (const claimed of claimedPaths(manifest)) {
      const key = this.keyForClaimed(claimed, prefix, filesPrefix);
      if (key === undefined || !stored.has(key)) throw new Error(EXPORT_INTERRUPTED_MESSAGE);
    }
  }

  /** The key a claimed path names in this generation, or `undefined` when the
   *  claim cannot be one — a path outside this platform's own prefix, or one
   *  `renderObjectKey` refuses. Never echoes the path either way. */
  private keyForClaimed(
    claimed: string,
    prefix: string,
    filesPrefix: string,
  ): ObjectKey | undefined {
    if (!claimed.startsWith(prefix)) return undefined;
    try {
      return renderObjectKey(
        filesPrefix,
        this.options.campaignSegment,
        claimed.slice(prefix.length),
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Empty every generation under this platform that sorts before `generation`.
   *
   * The platform prefix is listed rather than derived: a prefix that guessed the
   * boundary between "an older generation" and "some other writer's directory"
   * would have to decide what a generation is before it had seen one, and that
   * decision is the one that must not be a guess. Only generations this adapter's
   * own pattern recognises are named for deletion, so a key a future version (or
   * another writer) put under that prefix is left alone rather than swept.
   */
  private async sweepOlderGenerations(platformId: string, generation: string): Promise<void> {
    const platformPrefix = `${this.options.packagePrefix}${platformSegment(platformId)}`;
    const listed = await this.store.list(platformPrefix);
    const older = new Set<string>();
    for (const entry of listed) {
      const found = generationSegmentOf(entry.key, platformPrefix);
      if (found !== undefined && found < generation) older.add(found);
    }
    for (const stale of older) {
      await this.store.deletePrefix(
        packageGenerationPrefix(this.options.packagePrefix, platformId, stale),
      );
    }
  }

  /**
   * Where a packaged file WILL live, in the fs backend's shape — the path a
   * manifest names, not a key. `<campaignSegment>` is the slug on purpose here and
   * only here: this string is the customer's own file layout, and it is never
   * joined onto anything in the store.
   */
  private logicalPath(platformId: string, relativePath: string): string {
    return `${PACKAGES_SEGMENT}${this.options.campaignSegment}/${platformId}/${relativePath}`;
  }
}
