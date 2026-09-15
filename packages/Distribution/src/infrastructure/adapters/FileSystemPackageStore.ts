import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { PackageManifest, PackageStorePort } from "../../application/ports/out/PackageStorePort.js";
import { resolveSafe } from "../safe-path.js";

/**
 * Shown to the caller (and, through it, the export screen) for every way a
 * concurrent package request for the same campaign can disturb this one's
 * staging dir (X23). Deliberately says nothing about staging directories,
 * sweeps, or paths — those are this adapter's internals, not something the
 * person waiting on an export needs to parse.
 */
const EXPORT_INTERRUPTED_MESSAGE =
  "Another export of this campaign started while this one was running, so this export was stopped to keep the package intact. Try again.";

/**
 * FileSystemPackageStore — PackageStorePort adapter. Copies already-rendered
 * creatives under <output>/packages/<campaignId>/<platformId>/ and writes the
 * manifest. Each platform is staged in a sibling temp dir, then swapped in with
 * rm + rename so a failure never leaves a mixed folder.
 */
export class FileSystemPackageStore implements PackageStorePort {
  private readonly rootPath: string;
  private readonly campaignRoot: string;
  private readonly staging = new Map<string, string>();

  constructor(outputRoot: string, campaignId: string) {
    this.rootPath = resolve(outputRoot);
    const packagesRoot = resolve(this.rootPath, "packages");
    const campaignRoot = resolveSafe(packagesRoot, campaignId, "write");
    if (campaignRoot === packagesRoot) {
      throw new Error(`Refusing to write outside the output root: ${campaignId}`);
    }
    this.campaignRoot = campaignRoot;
  }

  async readAsset(relativePath: string): Promise<Uint8Array> {
    const target = resolveSafe(this.rootPath, relativePath, "read");
    return readFile(target);
  }

  async writePackaged(platformId: string, relativePath: string, bytes: Uint8Array): Promise<string> {
    const staging = await this.ensureStaging(platformId);
    const target = resolveSafe(staging, relativePath, "write");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return this.toPosixRelative(resolve(this.platformDir(platformId), relativePath));
  }

  async writeManifest(platformId: string, manifest: PackageManifest): Promise<string> {
    const staging = await this.ensureStaging(platformId);
    await this.assertManifestFilesStaged(platformId, staging, manifest);
    const stagedManifest = resolveSafe(staging, "manifest.json", "write");
    await writeFile(stagedManifest, JSON.stringify(manifest, null, 2));
    const finalDir = this.platformDir(platformId);
    await rm(finalDir, { recursive: true, force: true });
    await rename(staging, finalDir);
    this.staging.delete(platformId);
    return this.toPosixRelative(resolve(finalDir, "manifest.json"));
  }

  /** <output>/packages/<campaignId>/<platformId>/ — id must stay a child segment. */
  private platformDir(platformId: string): string {
    const dir = resolveSafe(this.campaignRoot, platformId, "write");
    if (dir === this.campaignRoot) {
      throw new Error(`Refusing to write outside the output root: ${platformId}`);
    }
    return dir;
  }

  private async ensureStaging(platformId: string): Promise<string> {
    const existing = this.staging.get(platformId);
    if (existing) {
      await this.assertStagingIntact(existing);
      return existing;
    }
    const finalDir = this.platformDir(platformId);
    await mkdir(dirname(finalDir), { recursive: true });
    await this.removeStaleStaging(finalDir);
    const staging = await mkdtemp(`${finalDir}.staging-`);
    this.staging.set(platformId, staging);
    return staging;
  }

  /**
   * A staging dir this instance already owns can be deleted out from under it:
   * another store for the same campaign+platform can start a new request while
   * this one is still mid-package, and its `ensureStaging` sweeps every
   * `<platform>.staging-*` sibling (`removeStaleStaging`) without knowing this
   * one is still live (X23). Left unchecked, `writePackaged`'s
   * `mkdir(dirname(target), { recursive: true })` would silently recreate the
   * missing tree and keep writing. Fail loudly here instead, so the request
   * surfaces as an error the caller can retry.
   *
   * This is a plain disk check, not an in-memory registry, so it is not
   * process-local: it catches the same race across separate processes
   * sharing the output root too. It only narrows the corruption, though — a
   * sweep can still land between this check and the write it guards,
   * including a fresh staging dir springing up in its place before this
   * store's next write. `assertManifestFilesStaged` below closes that gap at
   * commit time; this check exists to fail fast on the common case (the
   * whole directory is simply gone) without waiting for the final
   * verification.
   */
  private async assertStagingIntact(staging: string): Promise<void> {
    try {
      await stat(staging);
    } catch {
      throw new Error(EXPORT_INTERRUPTED_MESSAGE);
    }
  }

  /**
   * `assertStagingIntact` only proves the staging directory exists at the
   * moment it is read — it says nothing about what is still inside it. A
   * sweep (another store's `removeStaleStaging`) can land after that check
   * and before this call: it deletes the whole staging dir, and if a new
   * request for the same campaign+platform starts right after, a fresh
   * staging dir with the same name pattern can exist by the time this runs,
   * empty of everything this store staged. Without this check, `writeManifest`
   * would commit that directory anyway — a manifest listing files that are
   * not there, replacing a previously good package with a broken one (X23
   * round 2; the exact corruption `assertStagingIntact` alone leaves open).
   *
   * Verifies every file the manifest is about to claim — `packagedPath`, and
   * `posterPath` / `fallbackPath` when present — is actually staged, by
   * mapping each output-root-relative path back under `staging` (stripping
   * this platform's own prefix; a path that does not start with it can never
   * belong to this staging dir and is refused the same way). Throws before
   * `writeManifest` reaches `rm(finalDir)` + `rename`, so a previously
   * committed package is never touched by a commit that would not have been
   * legitimate. A sweep landing after this check still deletes the whole
   * staging dir, which makes the `rename` below fail outright — an error,
   * never a partial commit.
   */
  private async assertManifestFilesStaged(
    platformId: string,
    staging: string,
    manifest: PackageManifest,
  ): Promise<void> {
    const prefix = `${this.toPosixRelative(this.platformDir(platformId))}/`;
    const claimed = manifest.items.flatMap((item) =>
      [item.packagedPath, item.posterPath, item.fallbackPath].filter(
        (path): path is string => path !== undefined,
      ),
    );
    for (const packagedPath of claimed) {
      if (!(await this.isStagedUnder(staging, prefix, packagedPath))) {
        throw new Error(EXPORT_INTERRUPTED_MESSAGE);
      }
    }
  }

  private async isStagedUnder(staging: string, prefix: string, packagedPath: string): Promise<boolean> {
    if (!packagedPath.startsWith(prefix)) return false;
    try {
      await stat(resolveSafe(staging, packagedPath.slice(prefix.length), "read"));
      return true;
    } catch {
      return false;
    }
  }

  private async removeStaleStaging(finalDir: string): Promise<void> {
    const parent = dirname(finalDir);
    const prefix = `${basename(finalDir)}.staging-`;
    const names = await readdir(parent);
    await Promise.all(
      names
        .filter((name) => name.startsWith(prefix))
        .map((name) => rm(resolve(parent, name), { recursive: true, force: true })),
    );
  }

  private toPosixRelative(target: string): string {
    return relative(this.rootPath, target).split(sep).join("/");
  }
}
