import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { hashBytes, isErrno } from "../brief-files.js";
import { outputRoot } from "../config.js";
import type { ReportStorePort } from "./report-store.port.js";

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
 * Reports as files under `<outputRoot>/reports/<campaignId>.json`. The root is
 * resolved per call unless one is given, the same shape `FsJobStore` uses.
 */
export class FsReportStore implements ReportStorePort {
  private readonly customRoot?: string;

  constructor(root?: string) {
    if (root) this.customRoot = resolve(root);
  }

  private get root(): string {
    return this.customRoot ?? outputRoot();
  }

  async readReport(campaignId: string): Promise<unknown> {
    const path = campaignReportPath(this.root, campaignId);
    if (!path) return undefined;
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return undefined;
    }
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

  async writeReport(campaignId: string, payload: string): Promise<string> {
    const path = campaignReportPath(this.root, campaignId);
    if (!path) {
      throw new Error(`Report campaign id ${JSON.stringify(campaignId)} is not a safe id.`);
    }
    await mkdir(resolve(this.root, "reports"), { recursive: true });
    await writeAtomic(path, payload);
    return path;
  }
}
