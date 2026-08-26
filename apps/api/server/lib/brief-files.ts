import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import * as yaml from "js-yaml";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { projectRoot } from "@campaignfoundry/shared";
import { resolveConfined } from "./confined-path.js";

/** YAML sources PUT will rewrite in place. */
export const BRIEF_YAML_EXTS = [".yaml", ".yml"] as const;
/** Formats the loader understands — duplicate/load look these up in this order. */
export const BRIEF_SOURCE_EXTS = [".yaml", ".yml", ".json"] as const;

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

/** Serialize a brief with the sample-campaign key order. */
export function dumpBrief(brief: CampaignBrief): string {
  const source = brief as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of BRIEF_KEY_ORDER) {
    const value = source[key];
    if (value !== undefined) ordered[key] = value;
  }
  return yaml.dump(ordered, { lineWidth: -1, noRefs: true });
}

export function briefsDir(): string {
  return resolve(projectRoot(), "briefs");
}

/** Confined path for the canonical write target `briefs/<id>.yaml`. */
export function briefYamlPath(id: string): string {
  return resolveConfined(briefsDir(), `${id}.yaml`);
}

export function briefFileName(path: string): string {
  return basename(path);
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
  const dir = briefsDir();
  for (const ext of exts) {
    const candidate = resolveConfined(dir, `${id}${ext}`);
    try {
      const st = await lstat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // missing at this extension — try the next
    }
  }
  return undefined;
}

export async function writeBriefFile(path: string, brief: CampaignBrief): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, dumpBrief(brief), "utf8");
}
