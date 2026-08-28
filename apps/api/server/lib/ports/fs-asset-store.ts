import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { resolveConfined } from "../confined-path.js";
import { ASSET_NAME_PATTERN } from "../asset-files.js";
import type { AssetEntry, AssetStorePort } from "./asset-store.port.js";

/**
 * Filesystem implementation of AssetStorePort.
 * Stores assets under `<projectRoot>/assets/inputs/<briefId>/<name>`.
 */
export class FsAssetStore implements AssetStorePort {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir
      ? resolve(baseDir)
      : resolve(projectRoot(), "assets", "inputs");
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  assetRelPath(briefId: string, name: string): string {
    return `assets/inputs/${briefId}/${name}`;
  }

  private briefDir(briefId: string): string {
    return resolveConfined(this.baseDir, briefId);
  }

  private assetAbsPath(briefId: string, name: string): string {
    const dir = this.briefDir(briefId);
    return resolveConfined(dir, name);
  }

  async writeAsset(briefId: string, name: string, bytes: Buffer): Promise<{ path: string }> {
    const absPath = this.assetAbsPath(briefId, name);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, bytes, { flag: "wx" });
    return { path: this.assetRelPath(briefId, name) };
  }

  async listAssets(briefId: string): Promise<readonly AssetEntry[]> {
    let dir: string;
    try {
      dir = this.briefDir(briefId);
    } catch {
      return [];
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const assets: AssetEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !ASSET_NAME_PATTERN.test(entry.name)) continue;
      try {
        const filePath = resolve(dir, entry.name);
        const fileStat = await stat(filePath);
        const bytes = await readFile(filePath);
        const ext = extname(entry.name).toLowerCase();
        const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
        const thumbnailUrl = `data:${type};base64,${bytes.toString("base64")}`;
        assets.push({
          name: entry.name,
          type,
          size: fileStat.size,
          thumbnailUrl,
        });
      } catch {
        // Skip unreadable files
      }
    }
    return assets.sort((a, b) => a.name.localeCompare(b.name));
  }

  async copyAssets(fromBriefId: string, toBriefId: string): Promise<void> {
    if (fromBriefId === toBriefId) return;
    let sourceDir: string;
    let targetDir: string;
    try {
      sourceDir = this.briefDir(fromBriefId);
      targetDir = this.briefDir(toBriefId);
    } catch {
      return;
    }

    let entries;
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch {
      // Source directory does not exist or cannot be read — no-op
      return;
    }

    const validFiles = entries.filter((e) => e.isFile() && ASSET_NAME_PATTERN.test(e.name));
    if (validFiles.length === 0) return;

    await mkdir(targetDir, { recursive: true });
    for (const file of validFiles) {
      const src = resolve(sourceDir, file.name);
      const dst = resolve(targetDir, file.name);
      await copyFile(src, dst);
    }
  }
}
