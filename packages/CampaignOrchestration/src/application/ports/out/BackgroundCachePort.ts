/**
 * BackgroundCachePort — seed-keyed PNG cache for GenAI backgrounds.
 *
 * Keyed by sha256(provider, model, prompt, ratio, seed). Adapters live in
 * CreativeGeneration; this contract lives here (D7).
 */
export interface BackgroundCachePort {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, bytes: Uint8Array): Promise<void>;
}
