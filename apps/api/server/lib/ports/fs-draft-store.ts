import { lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import { isErrno, SYMLINK_WRITE_ERROR } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import type { DraftStorePort, LatestDraft, StoredDraft } from "./draft-store.port.js";

/** The directory a campaign's drafts live under, inside its own reserved
 * directory (`briefs/<slug>/drafts/`) — a sibling of `campaign.json`, part of
 * the same reservation `FsBriefStore.releaseCampaign` tears down. */
const DRAFTS_DIR = "drafts";

interface DraftFile {
  readonly state: unknown;
  readonly baseRevision: string | null;
  readonly updatedAt: string;
}

/**
 * Filesystem drafts (PT-5d, D173): one JSON file per user,
 * `briefs/<slug>/drafts/<userId>.json`, confined the same way every other
 * write through this store is (`resolveConfined`) — a userId with a
 * path-escaping shape (a "/", a "..", a NUL byte) can never read or write
 * outside `<slug>/drafts/`: `resolveConfined` throws before any I/O runs, and
 * a NUL byte fails even earlier, inside `node:path` itself.
 *
 * A symlinked `<slug>` or `<slug>/drafts` directory is refused rather than
 * followed — the same stance `FsBriefStore` takes on its own reserved
 * directory — and so is a symlinked `<userId>.json`: a write throws
 * `SYMLINK_WRITE_ERROR` (the route maps it to 400, mirroring every other
 * brief write), and a read answers "no draft" (`undefined`), the fail-closed
 * shape `FsBriefStore.readCampaignMeta` already gives a symlinked campaign
 * directory.
 */
export class FsDraftStore implements DraftStorePort {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /**
   * True when `<campaignId>` or `<campaignId>/drafts` exists but is not a
   * genuine directory (a symlink at either level) — checked from the
   * outside in, so a symlinked `<campaignId>` itself (which `lstat` on the
   * `drafts` path alone would silently follow, since `lstat` only inspects
   * the FINAL path component) is caught too. Absent (ENOENT) at either level
   * is "nothing reserved yet", not unsafe — `writeDraft` creates it.
   */
  private async draftsDirUnsafe(campaignId: string): Promise<boolean> {
    for (const segments of [[campaignId], [campaignId, DRAFTS_DIR]]) {
      let st;
      try {
        st = await lstat(resolveConfined(this.dir, ...segments));
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
      if (!st.isDirectory()) return true;
    }
    return false;
  }

  private draftPath(campaignId: string, userId: string): string {
    return resolveConfined(this.dir, campaignId, DRAFTS_DIR, `${userId}.json`);
  }

  async readDraft(campaignId: string, userId: string): Promise<StoredDraft | undefined> {
    if (await this.draftsDirUnsafe(campaignId)) return undefined;
    const filePath = this.draftPath(campaignId, userId);
    let st;
    try {
      st = await lstat(filePath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    // Never read through a symlinked draft file — same fail-closed stance as
    // the directory check above, not a write, so this answers "no draft"
    // rather than throwing.
    if (!st.isFile()) return undefined;
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as DraftFile;
    return {
      state: parsed.state,
      baseRevision: parsed.baseRevision,
      updatedAt: parsed.updatedAt,
    };
  }

  async writeDraft(
    campaignId: string,
    userId: string,
    state: unknown,
    baseRevision: string | null,
  ): Promise<StoredDraft> {
    if (await this.draftsDirUnsafe(campaignId)) {
      throw new Error(SYMLINK_WRITE_ERROR);
    }
    const filePath = this.draftPath(campaignId, userId);
    try {
      const st = await lstat(filePath);
      if (st.isSymbolicLink()) throw new Error(SYMLINK_WRITE_ERROR);
    } catch (error) {
      if (errorMessage(error) === SYMLINK_WRITE_ERROR) throw error;
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await mkdir(resolveConfined(this.dir, campaignId, DRAFTS_DIR), { recursive: true });
    const updatedAt = new Date().toISOString();
    const body: DraftFile = { state, baseRevision, updatedAt };
    await writeFile(filePath, JSON.stringify(body), "utf8");
    return { state, baseRevision, updatedAt };
  }

  async deleteDraft(campaignId: string, userId: string): Promise<void> {
    if (await this.draftsDirUnsafe(campaignId)) return;
    const filePath = this.draftPath(campaignId, userId);
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }

  async latestDraft(userId: string): Promise<LatestDraft | undefined> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    let best: LatestDraft | undefined;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const campaignId = entry.name;
      if (await this.draftsDirUnsafe(campaignId)) continue;
      let st;
      try {
        st = await lstat(this.draftPath(campaignId, userId));
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      if (!st.isFile()) continue;
      const updatedAt = st.mtime.toISOString();
      if (!best || updatedAt > best.updatedAt) best = { campaignId, updatedAt };
    }
    return best;
  }
}
