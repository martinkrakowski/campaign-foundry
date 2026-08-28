import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { resolveConfined } from "../confined-path.js";
import { ASSET_NAME_PATTERN } from "../asset-files.js";
import type { AssetEntry, AssetStorePort } from "./asset-store.port.js";

/**
 * Filesystem implementation of AssetStorePort.
 * Stores assets under `<projectRoot>/assets/inputs/<briefId>/<name>`.
 */
export class FsAssetStore implements AssetStorePort {
  private readonly customBaseDir?: string;

  constructor(baseDir?: string) {
    if (baseDir) this.customBaseDir = resolve(baseDir);
  }

  private get baseDir(): string {
    return this.customBaseDir ?? resolve(projectRoot(), "assets", "inputs");
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

  async readAsset(briefId: string, name: string): Promise<Buffer | undefined> {
    try {
      const absPath = this.assetAbsPath(briefId, name);
      return await readFile(absPath);
    } catch {
      return undefined;
    }
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
      const filePath = resolveConfined(dir, entry.name);
      const fileStat = await stat(filePath);
      const ext = extname(entry.name).toLowerCase();
      const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
      const thumbnailUrl = `/api/pipeline/campaigns/assets?briefId=${encodeURIComponent(briefId)}&name=${encodeURIComponent(entry.name)}`;
      assets.push({
        name: entry.name,
        type,
        size: fileStat.size,
        thumbnailUrl,
      });
    }
    return assets.sort((a, b) => a.name.localeCompare(b.name));
  }

  async copyAssets(fromBriefId: string, toBriefId: string): Promise<Record<string, string>> {
    if (fromBriefId === toBriefId) return {};
    let sourceDir: string;
    let targetDir: string;
    try {
      sourceDir = this.briefDir(fromBriefId);
      targetDir = this.briefDir(toBriefId);
    } catch {
      return {};
    }

    const collectFiles = async (currentDir: string, relPrefix = ""): Promise<string[]> => {
      let entries;
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        return [];
      }
      const files: string[] = [];
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          files.push(...(await collectFiles(resolve(currentDir, entry.name), rel)));
        } else {
          files.push(rel);
        }
      }
      return files;
    };

    const sourceFiles = await collectFiles(sourceDir);
    if (sourceFiles.length === 0) return {};

    await mkdir(targetDir, { recursive: true });
    const pathMap: Record<string, string> = {};

    for (const relPath of sourceFiles) {
      const srcPath = resolveConfined(sourceDir, relPath);
      const srcBytes = await readFile(srcPath);

      let destRelPath = relPath;
      const destCandidate = resolveConfined(targetDir, destRelPath);
      try {
        const existingBytes = await readFile(destCandidate);
        if (Buffer.compare(srcBytes, existingBytes) !== 0) {
          // Collision with different contents: disambiguate path
          const parsedExt = extname(relPath);
          const parsedDir = dirname(relPath);
          const parsedStem = basename(relPath, parsedExt);
          let counter = 1;
          let candidateName = `${parsedStem}-${fromBriefId}${parsedExt}`;
          let candidateRel = parsedDir === "." ? candidateName : `${parsedDir}/${candidateName}`;
          while (true) {
            try {
              const candBytes = await readFile(resolveConfined(targetDir, candidateRel));
              if (Buffer.compare(srcBytes, candBytes) === 0) {
                destRelPath = candidateRel;
                break;
              }
            } catch {
              destRelPath = candidateRel;
              break;
            }
            counter++;
            candidateName = `${parsedStem}-${fromBriefId}-${counter}${parsedExt}`;
            candidateRel = parsedDir === "." ? candidateName : `${parsedDir}/${candidateName}`;
          }
        }
      } catch {
        // Destination file does not exist yet; use destRelPath as-is
      }

      const destPath = resolveConfined(targetDir, destRelPath);
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, srcBytes);

      pathMap[relPath] = destRelPath;
      pathMap[`assets/inputs/${fromBriefId}/${relPath}`] = `assets/inputs/${toBriefId}/${destRelPath}`;
    }

    return pathMap;
  }
}
