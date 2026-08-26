const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/** FNV-1a 32-bit over `parts` joined with a NUL byte. Returns an unsigned 32-bit integer. */
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
 * Mulberry32 PRNG. Same seed → same sequence on every run and platform.
 * Domain code must use this instead of Math.random.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next integer in [0, n). Throws if n is not a positive integer. */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`n must be a positive integer (got ${String(n)})`);
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
