import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  BackgroundCachePort,
  BackgroundResult,
  BackgroundSource,
} from "@campaignfoundry/CampaignOrchestration";

/** sha256 hex of provider, model, prompt, ratio, seed — joined with NUL. */
export function backgroundCacheKey(
  provider: string,
  model: string,
  prompt: string,
  ratio: string,
  seed: number,
): string {
  return createHash("sha256")
    .update([provider, model, prompt, ratio, String(seed)].join("\0"))
    .digest("hex");
}

/**
 * Read a seed-keyed cache entry, or generate and store on miss. No seed / no
 * cache port → always generate. Source is unchanged on a hit (D4).
 */
export async function resolveCachedBackground(
  cache: BackgroundCachePort | undefined,
  seed: number | undefined,
  parts: { provider: string; model: string; prompt: string; ratio: string },
  generate: () => Promise<Uint8Array>,
  source: BackgroundSource,
): Promise<BackgroundResult> {
  if (!cache || seed === undefined) {
    return { image: await generate(), source };
  }
  const key = backgroundCacheKey(parts.provider, parts.model, parts.prompt, parts.ratio, seed);
  const hit = await cache.get(key);
  if (hit) return { image: hit, source, cached: true };
  const image = await generate();
  await cache.set(key, image);
  return { image, source };
}

/**
 * FileSystemBackgroundCache — PNG files at `<root>/<key>.png`.
 *
 * Keys are sha256 hex from {@link backgroundCacheKey}; anything else is rejected
 * so a bad key cannot escape `root`.
 */
export class FileSystemBackgroundCache implements BackgroundCachePort {
  constructor(private readonly root: string) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.fileFor(key)));
    } catch {
      return undefined;
    }
  }

  async set(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.fileFor(key), bytes);
  }

  private fileFor(key: string): string {
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error("Background cache key must be a sha256 hex digest.");
    }
    return join(this.root, `${key.toLowerCase()}.png`);
  }
}
