import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { briefsDir, isErrno } from "./brief-files.js";
import { resolveConfined } from "./confined-path.js";

/** Confined path `briefs/<briefId>/pools.json` — a directory, invisible to the briefs lister. */
export function poolPath(briefId: string): string {
  return resolveConfined(briefsDir(), briefId, "pools.json");
}

/** True when `briefs/<briefId>` exists and is a symlink — writes through it are refused. */
export async function isPoolDirSymlink(briefId: string): Promise<boolean> {
  try {
    return (await lstat(dirname(poolPath(briefId)))).isSymbolicLink();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
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

/**
 * Atomic write: unique temp sibling then rename, so a crash never leaves
 * half-written JSON and two overlapping writers never share a temp file.
 */
export async function writePool(pool: CopyPool): Promise<void> {
  const dest = poolPath(pool.briefId);
  const tmp = `${dest}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(pool, null, 2)}\n`, "utf8");
    await rename(tmp, dest);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Serialise read→merge→write sections per brief within this process, so a
 * concurrent POST/PATCH always merges into the latest file instead of
 * clobbering the other request's entries. Errors in `fn` do not poison the chain.
 */
export function withPoolLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(briefId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(briefId, settled);
  void settled.then(() => {
    if (chains.get(briefId) === settled) chains.delete(briefId);
  });
  return run;
}
