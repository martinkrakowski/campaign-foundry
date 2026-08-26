const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const UINT32_MAX = 0xffffffff;

/**
 * FNV-1a 32-bit over `parts` joined with a NUL byte, hashing UTF-16 code units
 * (`charCodeAt`), not UTF-8 bytes — so it is stable across JS runtimes but is not
 * byte-compatible with an FNV-1a computed elsewhere over UTF-8. Returns an
 * unsigned 32-bit integer. Parts are joined with NUL so `("a","1")` and `("a1")`
 * differ; callers must not embed NUL in a part.
 */
export function seedFrom(...parts: string[]): number {
  let h = FNV_OFFSET_BASIS;
  const joined = parts.join("\0");
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * Mulberry32 PRNG. Same seed → same sequence on every run and platform, bit-for-bit
 * with the reference implementation (state is kept as an int32 on every draw).
 * Domain code must use this instead of Math.random.
 */
export class SeededRandom {
  private state: number;

  /** `seed` must be an integer in [0, 2^32) — what `seedFrom` returns. */
  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > UINT32_MAX) {
      throw new Error(`seed must be an integer in [0, 2^32) (got ${seed})`);
    }
    this.state = seed | 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next integer in [0, n). Throws if n is not a positive integer. */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`n must be a positive integer (got ${n})`);
    }
    return Math.floor(this.next() * n);
  }

  /** Uniform pick. Throws if items is empty. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Cannot pick from an empty list");
    }
    return items[this.nextInt(items.length)];
  }
}
