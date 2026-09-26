import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { hashBytes, isErrno } from "../brief-files.js";
import { ReportConflictError, type ReportStorePort } from "./report-store.port.js";

/**
 * Resolve the per-campaign report path under `<root>/reports/<campaignId>.json`,
 * or null when the id can't be a safe single path segment. The id originates from a
 * brief (validated against the same pattern) but also flows in from the untrusted
 * `?campaignId=` query — so reuse SAFE_ID_PATTERN, the canonical brief/product/treatment
 * slug. It allows only lowercase letters, digits and hyphens, which inherently rules out
 * separators, `.`/`..` traversal, and anything else that isn't one safe path segment.
 */
export function campaignReportPath(root: string, campaignId: string): string | null {
  if (!SAFE_ID_PATTERN.test(campaignId)) return null;
  return resolve(root, "reports", `${campaignId}.json`);
}

/**
 * Atomic write: unique temp sibling then rename, so a crash never leaves
 * half-written JSON and a concurrent reader never parses a torn report. The temp
 * name is per-process and random — the pattern both stores use (L9) — because a
 * fixed one would be shared by two overlapping writers: the first rename consumes
 * it and the second writer's rename fails with ENOENT though both writes were fine.
 */
async function writeAtomic(dest: string, content: string): Promise<void> {
  const tmp = `${dest}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content);
    await rename(tmp, dest);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * Reports as files under `<root>/reports/<campaignId>.json`, where the root is the
 * one the composition root built this store with (D167).
 */
export class FsReportStore implements ReportStorePort {
  /** Resolved once at construction; the composition root decides it (D167). */
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async readReport(campaignId: string): Promise<unknown> {
    const path = campaignReportPath(this.root, campaignId);
    if (!path) return undefined;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    // A report that exists but does not parse is not "no report": answering undefined
    // would let a re-roll merge over an empty base and overwrite it, since the revision
    // guard hashes the same corrupt bytes and agrees. Could-not-read is surfaced.
    return JSON.parse(text);
  }

  async getRevision(campaignId: string): Promise<string | undefined> {
    const path = campaignReportPath(this.root, campaignId);
    if (!path) return undefined;
    try {
      return hashBytes(await readFile(path));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async writeReport(
    campaignId: string,
    payload: string,
    expectedRevision?: string | null,
    _fence?: { runId: string },
  ): Promise<string> {
    const path = campaignReportPath(this.root, campaignId);
    if (!path) {
      throw new Error(`Report campaign id ${JSON.stringify(campaignId)} is not a safe id.`);
    }
    if (expectedRevision !== undefined) {
      // Compared, then written — not fused into one step (D79: no such primitive
      // on a filesystem), so this narrows the cross-process race rather than
      // closing it; `PgReportStore`'s compare-and-swap closes it.
      const current = await this.getRevision(campaignId);
      if (current !== (expectedRevision ?? undefined)) {
        throw new ReportConflictError(campaignId, current);
      }
    }
    await mkdir(resolve(this.root, "reports"), { recursive: true });
    await writeAtomic(path, payload);
    return path;
  }
}
