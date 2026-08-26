import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
    if (existing) return existing;
    const finalDir = this.platformDir(platformId);
    await mkdir(dirname(finalDir), { recursive: true });
    await this.removeStaleStaging(finalDir);
    const staging = await mkdtemp(`${finalDir}.staging-`);
    this.staging.set(platformId, staging);
    return staging;
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
