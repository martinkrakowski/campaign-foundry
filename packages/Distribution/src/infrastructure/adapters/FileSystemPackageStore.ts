import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { PackageManifest, PackageStorePort } from "../../application/ports/out/PackageStorePort.js";

/**
 * FileSystemPackageStore — PackageStorePort adapter. Copies already-rendered
 * creatives under <output>/<campaignId>/platforms/<platformId>/ and writes the
 * manifest. Path safety matches FileSystemExporter (resolve + refuse escape).
 */
export class FileSystemPackageStore implements PackageStorePort {
  constructor(
    private readonly outputRoot: string,
    private readonly campaignId: string,
  ) {}

  async readAsset(relativePath: string): Promise<Uint8Array> {
    const target = this.resolveSafe(this.root(), relativePath, "read");
    return new Uint8Array(await readFile(target));
  }

  async writePackaged(platformId: string, relativePath: string, bytes: Uint8Array): Promise<string> {
    const target = this.resolveSafe(this.platformDir(platformId), relativePath, "write");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return this.toPosixRelative(target);
  }

  async writeManifest(platformId: string, manifest: PackageManifest): Promise<string> {
    const target = this.resolveSafe(this.platformDir(platformId), "manifest.json", "write");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(manifest, null, 2));
    return this.toPosixRelative(target);
  }

  private root(): string {
    return resolve(this.outputRoot);
  }

  /** <output>/<campaignId>/platforms/<platformId>/ — both id segments must stay inside. */
  private platformDir(platformId: string): string {
    const campaignRoot = this.resolveSafe(this.root(), this.campaignId, "write");
    const platformsRoot = resolve(campaignRoot, "platforms");
    return this.resolveSafe(platformsRoot, platformId, "write");
  }

  private resolveSafe(root: string, relativePath: string, action: "read" | "write"): string {
    const base = resolve(root);
    const target = resolve(base, relativePath);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`Refusing to ${action} outside the output root: ${relativePath}`);
    }
    return target;
  }

  private toPosixRelative(target: string): string {
    return relative(this.root(), target).split(sep).join("/");
  }
}
