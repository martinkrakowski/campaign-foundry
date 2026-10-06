import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { resolveConfined } from "../confined-path.js";
import { ASSET_NAME_PATTERN, assetContentType } from "../asset-files.js";
import type { ObjectKey } from "@campaignfoundry/CampaignOrchestration";
import type {
  AssetCopyResult,
  AssetEntry,
  AssetOwner,
  AssetStorePort,
  CopyAssetsOptions,
} from "./asset-store.port.js";

/**
 * Whether an error is the fs error `code` names. `copyAssets` needs two: `EEXIST`,
 * the one a `{ flag: "wx" }` write throws when an upload raced in between our read
 * and our write; and `ENOENT`, the only read failure that means "nothing is here".
 * Any other read failure (`EISDIR`, `EACCES`) must propagate: read as "absent",
 * an `EISDIR` destination makes every `wx` write answer `EEXIST` and the
 * re-decide loop would never end.
 */
function hasErrorCode(error: unknown, code: string): boolean {
  // `Object(…)` boxes a primitive and maps null/undefined to `{}`, so any thrown
  // value is safe to read `.code` from without a branch per shape.
  return (Object(error) as { code?: unknown }).code === code;
}

/**
 * Filesystem implementation of AssetStorePort.
 * Stores assets under `<projectRoot>/assets/inputs/<briefId>/<name>`.
 */
export class FsAssetStore implements AssetStorePort {
  /** Resolved once at construction; the composition root decides it (D167). */
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
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

  /**
   * See `AssetStorePort.readAssetById`. Always `undefined`, and that is the
   * whole answer rather than a missing method: a filesystem asset is NAMED by
   * its path and nothing else, so there is no id to look one up by and a lookup
   * that guessed would resolve `assets/inputs/<uuid>/logo.png` — a path the
   * confined resolve below already refuses for escaping `inputs/`.
   *
   * `undefined` is also the answer that keeps `ObjectInputAssets`' id branch
   * correct on fs: it maps to ENOENT, so a uuid in a brief read through the
   * object-store adapter is a MISSING asset rather than "unsafe" — which is
   * exactly what `FileSystemInputAssets` says about the same ref, and is why
   * that adapter is untouched by PT-4k1.
   */
  async readAssetById(_id: string): Promise<Buffer | undefined> {
    return undefined;
  }

  /** See `AssetStorePort.assetOwner` — always `undefined`, as above. */
  async assetOwner(_id: string): Promise<AssetOwner | undefined> {
    return undefined;
  }

  /**
   * See `AssetStorePort.assetObjectKey`. Always `undefined`, for the same reason
   * `readAssetById` is: a filesystem asset is NAMED by its path under
   * `<baseDir>/<briefId>/<name>`, which is a path and not a key at all — there is
   * no bucket for a presigned URL to point into, and inventing a key-shaped name
   * here would be how a caller began signing URLs for files the object store
   * never wrote.
   *
   * `?name=` on fs streams its bytes (`assets.get.ts`), which is what makes this
   * `undefined` the whole answer rather than a gap: the redirect branch is taken
   * on `objectStore() === "s3"` alone and never on this method's answer, so fs
   * never asks.
   */
  async assetObjectKey(_briefId: string, _name: string): Promise<ObjectKey | undefined> {
    return undefined;
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
      const type = assetContentType(entry.name);
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

  async copyAssets(
    fromBriefId: string,
    toBriefId: string,
    options?: CopyAssetsOptions,
  ): Promise<AssetCopyResult> {
    // PT-9j0 (D237): `created` is owned by THIS frame and handed to the body, so a
    // throw part-way through still knows what the call had already made. The files
    // written before the failing one are removed (they were minted by this call with
    // `wx`) before the error is rethrown.
    // Accepted residual: a `wx` write whose open succeeded and whose write then
    // failed (ENOSPC, EIO) leaves a partial file that is not in `created`, so it
    // is not freed here; adding the path on an arbitrary write error could name a
    // file this call did not create.
    const created = new Set<string>();
    try {
      return await this.copyAssetsInto(fromBriefId, toBriefId, created, options?.only);
    } catch (error) {
      try {
        await this.freeUnreferencedAssets(toBriefId, [...created]);
      } catch {
        // Best-effort: the copy's own error is what the caller must hear, and a failed free
        // here leaves the files in place: nothing sweeps `assets/inputs/<slug>/` on the
        // file store, so only a route's own release takes them.
      }
      throw error;
    }
  }

  /** The body of {@link copyAssets}; every id it mints is added to `created` the moment it is minted. */
  private async copyAssetsInto(
    fromBriefId: string,
    toBriefId: string,
    created: Set<string>,
    only: readonly string[] | undefined,
  ): Promise<AssetCopyResult> {
    if (fromBriefId === toBriefId) return { paths: {}, created: new Set() };
    let sourceDir: string;
    let targetDir: string;
    try {
      sourceDir = this.briefDir(fromBriefId);
      targetDir = this.briefDir(toBriefId);
    } catch {
      return { paths: {}, created: new Set() };
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

    const allFiles = await collectFiles(sourceDir);
    const wanted = only === undefined ? undefined : new Set(only);
    const sourceFiles =
      wanted === undefined ? allFiles : allFiles.filter((relPath) => wanted.has(relPath));
    if (sourceFiles.length === 0) return { paths: {}, created: new Set() };

    await mkdir(targetDir, { recursive: true });
    const pathMap: Record<string, string> = {};

    for (const relPath of sourceFiles) {
      const srcPath = resolveConfined(sourceDir, relPath);
      const srcBytes = await readFile(srcPath);

      // An upload (no brief lock, `assets.post.ts:105`) can create the
      // destination between our read and our write; `wx` rejects that case,
      // and each EEXIST means the tree grew, so re-deciding always terminates.
      let destRelPath: string;
      let reused: boolean;
      while (true) {
        destRelPath = relPath;
        reused = false;
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
                  reused = true;
                  break;
                }
              } catch (error) {
                if (!hasErrorCode(error, "ENOENT")) throw error;
                destRelPath = candidateRel;
                break;
              }
              counter++;
              candidateName = `${parsedStem}-${fromBriefId}-${counter}${parsedExt}`;
              candidateRel = parsedDir === "." ? candidateName : `${parsedDir}/${candidateName}`;
            }
          } else {
            // The plain candidate already carries these exact bytes: a sha-deduped reuse.
            reused = true;
          }
        } catch (error) {
          // Destination file does not exist yet; use destRelPath as-is
          if (!hasErrorCode(error, "ENOENT")) throw error;
        }

        if (reused) break;

        const destPath = resolveConfined(targetDir, destRelPath);
        await mkdir(dirname(destPath), { recursive: true });
        try {
          // `wx` not `w`: an upload may have appeared at this path since the
          // read above (uploads take no brief lock, `assets.post.ts:105`).
          await writeFile(destPath, srcBytes, { flag: "wx" });
          break;
        } catch (error) {
          if (hasErrorCode(error, "EEXIST")) continue;
          throw error;
        }
      }

      if (!reused) created.add(destRelPath);
      pathMap[relPath] = destRelPath;
      pathMap[`assets/inputs/${fromBriefId}/${relPath}`] =
        `assets/inputs/${toBriefId}/${destRelPath}`;
    }

    return { paths: pathMap, created };
  }

  /** See `AssetStorePort.deleteAssets` (PT-5b2 fix-round item 2). */
  async deleteAssets(briefId: string): Promise<void> {
    let dir: string;
    try {
      dir = this.briefDir(briefId);
    } catch {
      return;
    }
    await rm(dir, { recursive: true, force: true });
  }

  async freeUnreferencedAssets(campaign: string, ids: readonly string[]): Promise<void> {
    let dir: string;
    try {
      dir = this.briefDir(campaign);
    } catch {
      return;
    }
    for (const relPath of ids) {
      try {
        await rm(resolveConfined(dir, relPath), { force: true });
      } catch {
        // Best-effort, same discipline as `deleteAssets`: the caller's answer
        // is already decided, and a file already gone is not a failure.
      }
    }
  }
}
