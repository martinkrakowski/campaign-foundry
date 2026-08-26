import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { errorMessage } from "@campaignfoundry/shared";
import type {
  BackgroundCachePort,
  BackgroundResult,
  BackgroundSource,
} from "@campaignfoundry/CampaignOrchestration";

/** PNG magic: 89 50 4E 47 0D 0A 1A 0A. */
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function isPngBuffer(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= PNG_SIGNATURE.byteLength) return false;
  for (let i = 0; i < PNG_SIGNATURE.byteLength; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

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
  onWarn?: (message: string) => void,
): Promise<BackgroundResult> {
  if (!cache || seed === undefined) {
    return { image: await generate(), source };
  }
  const key = backgroundCacheKey(parts.provider, parts.model, parts.prompt, parts.ratio, seed);
  const hit = await cache.get(key);
  if (hit) return { image: hit, source, cached: true };
  const image = await generate();
  try {
    await cache.set(key, image);
  } catch (error) {
    const message = `Background cache write failed for ${key}: ${errorMessage(error)}`;
    if (onWarn) onWarn(message);
    else console.warn(`[BackgroundCache] ${message}`);
  }
  return { image, source };
}

/**
 * FileSystemBackgroundCache — PNG files at `<root>/<key>.png`.
 *
 * Keys are sha256 hex from {@link backgroundCacheKey}; anything else is rejected
 * so a bad key cannot escape `root`.
 */
export class FileSystemBackgroundCache implements BackgroundCachePort {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    let path: string;
    try {
      path = this.fileFor(key);
    } catch {
      return undefined;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      return undefined;
    }
    if (!isPngBuffer(bytes)) {
      try {
        await unlink(path);
      } catch {
        /* best-effort delete of a corrupt entry */
      }
      return undefined;
    }
    return bytes;
  }

  set(key: string, bytes: Uint8Array): Promise<void> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const write = this.writeAtomic(key, bytes).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, write);
    return write;
  }

  private async writeAtomic(key: string, bytes: Uint8Array): Promise<void> {
    const dest = this.fileFor(key);
    const tmp = `${dest}.tmp`;
    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(tmp, bytes);
      await rename(tmp, dest);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  private fileFor(key: string): string {
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error("Background cache key must be a sha256 hex digest.");
    }
    return join(this.root, `${key.toLowerCase()}.png`);
  }
}
