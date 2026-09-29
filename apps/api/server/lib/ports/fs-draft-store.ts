import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { isErrno, SYMLINK_WRITE_ERROR } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import type {
  DraftStorePort,
  LatestDraft,
  StoredDraft,
  WriteDraftOutcome,
} from "./draft-store.port.js";

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
 * write through this store is (`resolveConfined`) — a userId that would
 * escape the whole `briefs/` root entirely (enough "../" segments, a NUL
 * byte) can never read or write there: `resolveConfined` throws before any
 * I/O runs, and a NUL byte fails even earlier, inside `node:path` itself.
 *
 * That alone is not enough (fix round item 4, grok-4.7): `resolveConfined`
 * only rejects a path that ends up OUTSIDE `briefs/` — a userId of
 * `"../campaign"` still resolves to `briefs/<slug>/campaign.json`, which is
 * very much inside `briefs/`, just outside `drafts/` and squarely on top of
 * the campaign's own metadata file. `draftPath` below refuses any userId
 * that fails `SAFE_ID_PATTERN` (the same shape `safeId()` already guarantees
 * every Better Auth id, `user` included — `auth/id.ts`) before it ever
 * builds a path, closing that gap regardless of what `resolveConfined`
 * alone would have allowed through.
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

  /** Throws for a userId that would land outside `drafts/` even though it
   *  stays inside `briefs/` (fix round item 4) — see the class doc. Checked
   *  before `resolveConfined` runs at all, so a shape like `"../campaign"`
   *  never reaches path construction, let alone I/O. */
  private draftPath(campaignId: string, userId: string): string {
    if (!SAFE_ID_PATTERN.test(userId)) {
      throw new Error(`Invalid user id: ${JSON.stringify(userId)}`);
    }
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
    // Fix round (bots) — a sibling temp file, then an atomic rename over the
    // target, the same pattern `FsBriefStore.rewriteBrief` already uses (and
    // for the same reason): `writeFile(filePath, …)` truncates the existing
    // draft before the replacement is complete, so a `readDraft` racing this
    // write (the editor's own PUT is debounced to roughly once a second, not
    // serialized against its own GET) could see partial JSON and 500, and a
    // process crash mid-write would leave the draft permanently corrupt. The
    // temp name is per-process and random, same reasoning as the brief
    // writer's own: a fixed name would let two overlapping writers race each
    // other's rename.
    const tmpPath = `${filePath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(body), "utf8");
      await rename(tmpPath, filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
    return { state, baseRevision, updatedAt };
  }

  /**
   * `DraftStorePort.writeDraftIfCurrent` — the fs backend has no campaign
   * row to lock, so it trusts `currentRevision` entirely: the caller
   * (`PUT /campaigns/:id/draft`) reads it and calls this INSIDE
   * `BriefStorePort.withBriefLock(slug, …)`, the same in-process chain a
   * brief save's own `rewriteBrief` call runs under — so nothing else
   * touching this campaign on this process can run between that read and
   * this write. Compare-then-write, not a second store round trip.
   */
  async writeDraftIfCurrent(
    campaignId: string,
    userId: string,
    state: unknown,
    baseRevision: string | null,
    currentRevision: string | null,
  ): Promise<WriteDraftOutcome> {
    if (baseRevision !== currentRevision) {
      return { ok: false, currentRevision };
    }
    const draft = await this.writeDraft(campaignId, userId, state, baseRevision);
    return { ok: true, draft };
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

  /**
   * `DraftStorePort.listDraftsByRecency` — every campaign directory under
   * `this.dir` that has a `drafts/<userId>.json`, newest first. Unlike the
   * old single-answer `latestDraft`, this does not stop at the first (it
   * cannot know which one, if any, is still visible to the caller — that is
   * the ROUTE's call, via `campaignMeta`, once it has this whole list).
   */
  async listDraftsByRecency(userId: string): Promise<readonly LatestDraft[]> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const found: LatestDraft[] = [];
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
      found.push({ campaignId, updatedAt: st.mtime.toISOString() });
    }
    // Arithmetic, not a nested ternary comparing the strings directly: a
    // branch-free comparator both sidesteps the "equal timestamps" branch a
    // real test can rarely force (mtime resolution collides more often than
    // a synthetic one) and gets ties right for free (`Date.parse` on two
    // equal ISO strings subtracts to exactly `0`, the one case a `<`/`>`
    // pair of branches would need a THIRD path just to reach).
    found.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return found;
  }
}
