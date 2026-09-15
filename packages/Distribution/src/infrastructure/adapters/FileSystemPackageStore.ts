import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { PackageManifest, PackageStorePort } from "../../application/ports/out/PackageStorePort.js";
import { resolveSafe } from "../safe-path.js";

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
      await this.assertStagingIntact(platformId, existing);
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
   * missing tree and keep writing, so a later `writeManifest` would commit a
   * manifest listing files that no longer exist — the class comment's "a
   * failure never leaves a mixed folder" promise broken by a partial commit
   * instead. Fail loudly here, before any of that, so the request surfaces as
   * an error the caller can retry rather than a corrupted package.
   *
   * This is a plain disk check, not an in-memory registry, so it is not
   * process-local: it catches the same race across separate processes
   * sharing the output root too. What it does not do is prevent the
   * deletion — the other store's sweep still runs — so the loser of the race
   * fails and must be retried; it only stops the loser from committing
   * garbage. A sweep landing between this check and the write it guards
   * (`writeFile` / `rm`+`rename`) is a narrower, pre-existing TOCTOU window
   * this does not close.
   */
  private async assertStagingIntact(platformId: string, staging: string): Promise<void> {
    try {
      await stat(staging);
    } catch {
      throw new Error(
        `Staging directory for platform "${platformId}" was removed before it could be committed ` +
          `— likely a concurrent package request for the same campaign. Refusing to continue.`,
      );
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
