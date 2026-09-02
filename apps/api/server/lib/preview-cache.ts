/**
 * A tiny in-memory LRU. Recency is refreshed on `get`; past the bound the
 * coldest entry is evicted. Used for preview frames keyed by content
 * fingerprint — entries are re-derivable bytes, so eviction is always safe.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Re-insert so `key` becomes the newest entry: Map iteration is insertion-ordered.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      // size > maxEntries ≥ 0 means at least one entry — a first key always exists here.
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
