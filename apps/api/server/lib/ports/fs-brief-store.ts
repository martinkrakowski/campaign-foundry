import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { projectRoot, errorMessage } from "@campaignfoundry/shared";
import { resolveConfined } from "../confined-path.js";
import { parseBriefText, type ParseBriefOptions } from "../load-brief.js";
import type { BriefStorePort, StoredBrief } from "./brief-store.port.js";
import {
  BRIEF_SOURCE_EXTS,
  hashBytes,
  isBriefSourceName,
  isErrno,
  patchBriefYaml,
  serializeBrief,
  SYMLINK_WRITE_ERROR,
} from "../brief-files.js";

/**
 * Filesystem implementation of BriefStorePort.
 * Stores briefs under `<projectRoot>/briefs/*.yaml` (or .yml / .json).
 */
export class FsBriefStore implements BriefStorePort {
  private readonly customDir?: string;
  private readonly lockChains = new Map<string, Promise<unknown>>();

  constructor(dir?: string) {
    if (dir) this.customDir = resolve(dir);
  }

  private get dir(): string {
    return this.customDir ?? resolve(projectRoot(), "briefs");
  }

  getBriefsDir(): string {
    return this.dir;
  }

  async listBriefs(): Promise<readonly StoredBrief[]> {
    let files: string[];
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      files = entries
        .filter((e) => e.isFile() && isBriefSourceName(e.name))
        .map((e) => e.name)
        .sort();
    } catch (error) {
      // A missing briefs/ directory is "no campaigns yet". Any other errno
      // (EACCES, EIO, ENOTDIR) is a store read failure the route maps to 500.
      console.warn(`[briefs] could not read ${this.dir}: ${errorMessage(error)}`);
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }

    const briefs: StoredBrief[] = [];
    for (const file of files) {
      try {
        const filePath = resolve(this.dir, file);
        const bytes = await readFile(filePath);
        const revision = hashBytes(bytes);
        const brief = parseBriefText(filePath, bytes.toString("utf8"));
        briefs.push({ file, brief, revision });
      } catch (error) {
        console.warn(`[briefs] skipped ${file}: ${errorMessage(error)}`);
      }
    }
    return briefs;
  }

  async findBriefById(id: string): Promise<StoredBrief | undefined> {
    const list = await this.listBriefs();
    return list.find((entry) => entry.brief.id === id);
  }

  async findBriefFileById(id: string): Promise<string | undefined> {
    const found = await this.findBriefById(id);
    return found?.file;
  }

  async findBriefFile(
    id: string,
    exts: readonly string[] = BRIEF_SOURCE_EXTS,
  ): Promise<string | undefined> {
    for (const ext of exts) {
      const fileName = `${id}${ext}`;
      try {
        const candidate = resolveConfined(this.dir, fileName);
        const st = await lstat(candidate);
        if (st.isFile()) return fileName;
      } catch {
        // missing at this extension or invalid — try next
      }
    }
    return undefined;
  }

  async readBrief(fileOrKey: string, opts: ParseBriefOptions = {}): Promise<CampaignBrief> {
    const file = (await this.findBriefFileById(fileOrKey)) ?? fileOrKey;
    const filePath = resolveConfined(this.dir, file);
    const raw = await readFile(filePath, "utf8");
    return parseBriefText(filePath, raw, opts);
  }

  async createBrief(brief: CampaignBrief): Promise<StoredBrief> {
    const filePath = resolveConfined(this.dir, `${brief.id}.yaml`);
    try {
      const st = await lstat(filePath);
      if (st.isSymbolicLink()) {
        throw new Error(SYMLINK_WRITE_ERROR);
      }
    } catch (err) {
      if (errorMessage(err) === SYMLINK_WRITE_ERROR) throw err;
    }
    await mkdir(dirname(filePath), { recursive: true });
    const content = serializeBrief(filePath, brief);
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    const revision = hashBytes(Buffer.from(content, "utf8"));
    return { file: `${brief.id}.yaml`, brief, revision };
  }

  /**
   * Non-destructive writer for Save and `POST ?replace=1` (R4.1): read the
   * existing bytes, patch the changed paths in place as a YAML Document, and
   * atomically replace the file via a temp rename. Comments, blank lines, key
   * order and quoting the operator wrote survive; an unparseable file refuses
   * the write (fail closed) rather than falling back to a whole-object dump.
   */
  async rewriteBrief(
    brief: CampaignBrief,
    options?: { expectedRevision?: string },
  ): Promise<StoredBrief> {
    const file = await this.findBriefFileById(brief.id);
    if (!file) {
      // Check if there is an inode (e.g. symlink) at canonical path
      const candidate = resolveConfined(this.dir, `${brief.id}.yaml`);
      try {
        const st = await lstat(candidate);
        if (st.isSymbolicLink()) {
          throw new Error(SYMLINK_WRITE_ERROR);
        }
      } catch (err) {
        if (errorMessage(err) === SYMLINK_WRITE_ERROR) throw err;
      }
      const err = new Error(`Brief "${brief.id}" not found.`);
      (err as { code?: string }).code = "ENOENT";
      throw err;
    }
    const filePath = resolveConfined(this.dir, file);
    const raw = await readFile(filePath);
    if (options?.expectedRevision) {
      const currentRev = hashBytes(raw);
      if (currentRev !== options.expectedRevision) {
        const conflictErr = new Error("Brief was modified by another user.");
        (conflictErr as { code?: string; revision?: string }).code = "ECONFLICT";
        (conflictErr as { revision?: string }).revision = currentRev;
        throw conflictErr;
      }
    }
    let content: string;
    if (extname(filePath).toLowerCase() === ".json") {
      // R4.2 — named carve-out, deliberate: a `.json` brief keeps JSON. A YAML
      // Document patch here would write YAML into a `.json` file and hide the
      // brief on the next load. Never Document-patched, never fail-closed for
      // "not a YAML Document".
      content = serializeBrief(filePath, brief);
    } else {
      content = patchBriefYaml(filePath, raw.toString("utf8"), brief);
    }
    // Atomic replace: write a sibling temp file, then rename over the target, so
    // a failure mid-write leaves the operator's original bytes untouched.
    const tmpPath = `${filePath}.tmp`;
    try {
      await writeFile(tmpPath, content, "utf8");
      await rename(tmpPath, filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
    const revision = hashBytes(Buffer.from(content, "utf8"));
    return { file: basename(filePath), brief, revision };
  }

  async replaceBrief(
    brief: CampaignBrief,
    options?: { expectedRevision?: string },
  ): Promise<StoredBrief> {
    const file = await this.findBriefFileById(brief.id);
    const candidate = resolveConfined(this.dir, file ?? `${brief.id}.yaml`);
    try {
      const st = await lstat(candidate);
      if (st.isSymbolicLink()) {
        throw new Error(SYMLINK_WRITE_ERROR);
      }
    } catch (err) {
      if (errorMessage(err) === SYMLINK_WRITE_ERROR) throw err;
    }
    try {
      return await this.rewriteBrief(brief, options);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return await this.createBrief(brief);
      }
      throw error;
    }
  }

  async getRevision(fileOrId: string): Promise<string | undefined> {
    try {
      const file = (await this.findBriefFileById(fileOrId)) ?? fileOrId;
      const filePath = resolveConfined(this.dir, file);
      const bytes = await readFile(filePath);
      return hashBytes(bytes);
    } catch {
      return undefined;
    }
  }

  async exists(fileOrId: string): Promise<boolean> {
    try {
      const file = (await this.findBriefFileById(fileOrId)) ?? fileOrId;
      const filePath = resolveConfined(this.dir, file);
      await lstat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  withBriefLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lockChains.get(briefId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.lockChains.set(briefId, settled);
    void settled.then(() => {
      if (this.lockChains.get(briefId) === settled) this.lockChains.delete(briefId);
    });
    return run;
  }
}
