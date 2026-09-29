import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { isErrno, SYMLINK_WRITE_ERROR } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import type { LastOpenedPointer, LastOpenedStorePort } from "./last-opened-store.port.js";

interface PointerFile {
  readonly campaignId: string;
  readonly updatedAt: string;
}

/**
 * The last-opened pointer on files (PT-5e, D173, D180): one JSON file per
 * user, `<dir>/<userId>.json`.
 *
 * `<dir>` is OUTSIDE `briefs/` (the registry resolves it to
 * `<projectRoot>/state/last-opened`, `lib/ports/index.ts`), and that is not
 * tidiness. A campaign's own reserved directory is `briefs/<slug>/`, so a
 * pointer stored beside them would put a per-user file at a path a campaign slug
 * could name — and the one id a campaign has on this backend IS its slug
 * (D179). Keeping the pointer outside `briefs/` means no campaign, whatever it
 * is named, can collide with a user's pointer, and `releaseCampaign`'s teardown
 * (`fs-brief-store.ts`) can never remove one by accident.
 *
 * Confining is belt and braces on top of that, exactly as `FsDraftStore` is:
 * `resolveConfined` rejects a path that ends up outside the directory before
 * any I/O runs, and `pointerPath` refuses any userId failing `SAFE_ID_PATTERN`
 * first — the same shape `safeId()` guarantees every Better Auth id, `user`
 * included (`auth/id.ts`). `resolveConfined` alone is not enough: it only
 * rejects paths that leave the root, so a userId of `".."`-shaped text could
 * still land on a sibling of the pointer directory.
 *
 * A symlinked pointer directory or file is refused rather than followed — the
 * same stance `FsDraftStore` and `FsBriefStore` take on their own reserved
 * paths: a write throws `SYMLINK_WRITE_ERROR` (the route maps it to 400, like
 * every other brief write) and a read answers "no pointer" (`undefined`), the
 * fail-closed shape `FsBriefStore.readCampaignMeta` gives a symlinked campaign
 * directory.
 *
 * A pointer to a campaign that no longer exists is NOT cleaned up here (this
 * adapter holds no list of campaigns, and the FK cascade that does it on
 * Postgres is not a thing files have). The ROUTE resolves the pointer through
 * `BriefStorePort.campaignMeta` and answers "no pointer" for anything it cannot
 * see, so a stale file is harmless — and identical to a hidden campaign's.
 */
export class FsLastOpenedStore implements LastOpenedStorePort {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /**
   * True when the pointer directory — or the level directly above it, which the
   * `mkdir(…, { recursive: true })` below can also create — exists but is not a
   * genuine directory. Checked one level at a time from the outside in, exactly
   * as `FsDraftStore.draftsDirUnsafe` does and for the same reason: `lstat`
   * never follows the FINAL component of the path it is given, but it does
   * resolve every component before it. A check on the pointer directory alone
   * therefore reads a symlink at its parent at face value — it gets the
   * target's own answer — and a target that has no pointer directory in it yet
   * answers ENOENT, which a final-level-only check must otherwise read as
   * "nothing reserved yet". The `mkdir` and `writeFile` that follow resolve
   * through the same link and put the pointer outside the project root (fix
   * round, qodo PRRT_kwDOSzP1zc6nELaB).
   *
   * The project root above these is the trusted anchor the registry resolved
   * the path from, and is not re-checked: it is given, not created, exactly as
   * `briefs/` is for `FsBriefStore`.
   *
   * Absent (ENOENT) at either level is "nothing created here yet", not unsafe —
   * `write` creates it.
   */
  private async dirUnsafe(): Promise<boolean> {
    for (const path of [dirname(this.dir), this.dir]) {
      let st;
      try {
        st = await lstat(path);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
      if (!st.isDirectory()) return true;
    }
    return false;
  }

  /** Throws for a userId that is not path-safe, before any path is built from
   *  it — see the class doc. `SAFE_ID_PATTERN` also rejects a NUL byte, a
   *  separator and a leading dot, so no shape reaches `node:path`. */
  private pointerPath(userId: string): string {
    if (!SAFE_ID_PATTERN.test(userId)) {
      throw new Error(`Invalid user id: ${JSON.stringify(userId)}`);
    }
    return resolveConfined(this.dir, `${userId}.json`);
  }

  async read(userId: string): Promise<LastOpenedPointer | undefined> {
    if (await this.dirUnsafe()) return undefined;
    const filePath = this.pointerPath(userId);
    let st;
    try {
      st = await lstat(filePath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    // Never read through a symlinked pointer file — same fail-closed stance as
    // the directory check above, and a read, so this answers "no pointer"
    // rather than throwing.
    if (!st.isFile()) return undefined;
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as PointerFile;
    return { campaignId: parsed.campaignId, updatedAt: parsed.updatedAt };
  }

  async write(campaignId: string, userId: string): Promise<LastOpenedPointer> {
    if (await this.dirUnsafe()) {
      throw new Error(SYMLINK_WRITE_ERROR);
    }
    const filePath = this.pointerPath(userId);
    try {
      const st = await lstat(filePath);
      if (st.isSymbolicLink()) throw new Error(SYMLINK_WRITE_ERROR);
    } catch (error) {
      if (errorMessage(error) === SYMLINK_WRITE_ERROR) throw error;
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await mkdir(this.dir, { recursive: true });
    const updatedAt = new Date().toISOString();
    const body: PointerFile = { campaignId, updatedAt };
    // A sibling temp file, then an atomic rename over the target — the same
    // pattern `FsBriefStore.rewriteBrief` and `FsDraftStore.writeDraft` use,
    // for the same reason: `writeFile` truncates the existing pointer before
    // the replacement is complete, so a read racing this write (the bare pages
    // read it while a page transition writes one) could see partial JSON, and
    // a crash mid-write would leave the pointer permanently corrupt. The temp
    // name is per-process and random, so two overlapping writers cannot race
    // each other's rename.
    const tmpPath = `${filePath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(body), "utf8");
      await rename(tmpPath, filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
    return { campaignId, updatedAt };
  }
}
