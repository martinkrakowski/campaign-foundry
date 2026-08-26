import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { briefsDir, isErrno } from "./brief-files.js";
import { resolveConfined } from "./confined-path.js";

/** Confined path `briefs/<briefId>/pools.json` — a directory, invisible to the briefs lister. */
export function poolPath(briefId: string): string {
  return resolveConfined(briefsDir(), briefId, "pools.json");
}

export async function readPool(briefId: string): Promise<CopyPool | undefined> {
  try {
    const raw = await readFile(poolPath(briefId), "utf8");
    return JSON.parse(raw) as CopyPool;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** Atomic write: temp sibling then rename, so a crash never leaves half-written JSON. */
export async function writePool(pool: CopyPool): Promise<void> {
  const dest = poolPath(pool.briefId);
  const tmp = `${dest}.tmp`;
  try {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(pool, null, 2)}\n`, "utf8");
    await rename(tmp, dest);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}
