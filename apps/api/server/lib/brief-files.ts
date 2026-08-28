import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import * as yaml from "js-yaml";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { projectRoot } from "@campaignfoundry/shared";
import { resolveConfined } from "./confined-path.js";
import { getBriefStore } from "./ports/index.js";

/** Formats the loader understands — listing and id lookup accept these (case-insensitive). */
export const BRIEF_SOURCE_EXTS = [".yaml", ".yml", ".json"] as const;

export const SYMLINK_WRITE_ERROR = "Refusing to write through a symlink.";

const BRIEF_KEY_ORDER = [
  "id",
  "targetRegion",
  "targetAudience",
  "campaignMessage",
  "localizedMessage",
  "products",
  "treatments",
  "mode",
  "variation",
  "output",
] as const;

/** Serialize a brief with the sample-campaign key order, then any remaining keys. */
export function dumpBrief(brief: CampaignBrief): string {
  const source = brief as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of BRIEF_KEY_ORDER) {
    const value = source[key];
    if (value !== undefined) ordered[key] = value;
  }
  for (const key of Object.keys(source)) {
    if (!(key in ordered) && source[key] !== undefined) ordered[key] = source[key];
  }
  return yaml.dump(ordered, { lineWidth: -1, noRefs: true });
}

export function serializeBrief(path: string, brief: CampaignBrief): string {
  return extname(path).toLowerCase() === ".json" ? JSON.stringify(brief, null, 2) : dumpBrief(brief);
}

export function briefsDir(): string {
  return resolve(projectRoot(), "briefs");
}

/** Confined path for the canonical create target `briefs/<id>.yaml`. */
export function briefYamlPath(id: string): string {
  return resolveConfined(briefsDir(), `${id}.yaml`);
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export function isExistsError(error: unknown): boolean {
  return isErrno(error, "EEXIST");
}

export function isBriefSourceName(name: string): boolean {
  const lower = name.toLowerCase();
  return BRIEF_SOURCE_EXTS.some((ext) => lower.endsWith(ext));
}

/** Compute SHA-256 hex digest of raw bytes. */
export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Compute SHA-256 hex digest of a file's raw bytes. */
export async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return hashBytes(bytes);
}

/** True if anything (file, dir, symlink) exists at `path`. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * First regular file at `briefs/<id>.<ext>` for `exts`, in order.
 * Missing / non-file entries are skipped; an empty result means 404.
 */
export async function findBriefFile(
  id: string,
  exts: readonly string[] = BRIEF_SOURCE_EXTS,
): Promise<string | undefined> {
  const file = await getBriefStore().findBriefFile(id, exts);
  return file ? resolve(briefsDir(), file) : undefined;
}

/**
 * Regular briefs/ source whose parsed `brief.id` equals `id`.
 * Filename may differ from the id (e.g. `sample-campaign.yaml` / `summer-hydration-2026`).
 * Unparseable files and non-files are skipped, matching GET /campaigns/briefs.
 */
export async function findBriefById(
  id: string,
): Promise<{ path: string; brief: CampaignBrief } | undefined> {
  const found = await getBriefStore().findBriefById(id);
  if (!found) return undefined;
  return { path: resolve(briefsDir(), found.file), brief: found.brief };
}

export async function findBriefFileById(id: string): Promise<string | undefined> {
  const file = await getBriefStore().findBriefFileById(id);
  return file ? resolve(briefsDir(), file) : undefined;
}

/** Exclusive create — fails with EEXIST if anything is already at `path`. */
export async function createBriefFile(path: string, brief: CampaignBrief): Promise<void> {
  await getBriefStore().createBrief(brief);
}

/** Overwrite an existing regular file in its own format; refuse a symlink. */
export async function rewriteBriefFile(path: string, brief: CampaignBrief): Promise<void> {
  await getBriefStore().rewriteBrief(brief);
}

/**
 * Replace an existing file at `path`, or create it if missing.
 * Used by POST `?replace=1`. Symlinks are refused; a racing create is EEXIST.
 */
export async function replaceBriefFile(path: string, brief: CampaignBrief): Promise<void> {
  await getBriefStore().replaceBrief(brief);
}

/**
 * Serialise revision-check→write sections per brief id within this process, so a
 * conditional write cannot be overtaken between its hash comparison and its write.
 * Errors in `fn` do not poison the chain.
 */
export function withBriefLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
  return getBriefStore().withBriefLock(briefId, fn);
}
