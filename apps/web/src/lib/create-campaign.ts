"use client";

import { MODE_OPTIONS, type CampaignMode } from "@/components/campaign/editor-state";

/**
 * D65 — create is a seam, not a POST. The dialog hands the four Identity answers to
 * `createCampaign` and receives `{ id, route }`, or `null` when the seed write is
 * refused; it derives no id and shows no slug.
 * The wave-1 body publishes the seed the blank-route editor consumes (D66) and writes
 * nothing else — under D64(b) this one body becomes a POST that mints a draft row and
 * returns its route, and nothing else in the lane changes.
 */

export interface CreateCampaignInput {
  readonly name: string;
  readonly targetRegion: string;
  readonly targetAudience: string;
  readonly mode: CampaignMode;
}

export interface CreateCampaignResult {
  readonly id: string;
  readonly route: string;
}

/**
 * The one-shot seed key, in the shape of the `cf:step-handoff` baton (H5): persisted
 * so a full page load on `/brief/new` still finds it, and spent by a single read —
 * `takeSeed` is what spends it, exactly as `takeStashedStep` does.
 */
export const CREATE_SEED_KEY = "cf:create-seed";

/**
 * Why a subscriber set: a same-window `localStorage` write raises no `storage` event
 * in the writing document (and happy-dom raises none at all), so the provider cannot
 * learn of the write that way. `createCampaign` writes the key and then notifies;
 * nobody here may rely on the `storage` event.
 */
const seedListeners = new Set<() => void>();

export function subscribeToSeed(listener: () => void): () => void {
  seedListeners.add(listener);
  return () => {
    seedListeners.delete(listener);
  };
}

/** Persist the seed. `true` only when the write landed; a blocked store is not a create. */
function publishSeed(input: CreateCampaignInput): boolean {
  try {
    localStorage.setItem(CREATE_SEED_KEY, JSON.stringify(input));
  } catch {
    return false;
  }
  for (const listener of seedListeners) listener();
  return true;
}

/** Minimal shape guard for a seed restored from storage (don't trust hand-edited JSON). */
function isStoredSeed(value: unknown): value is CreateCampaignInput {
  if (typeof value !== "object" || value === null) return false;
  const seed = value as Partial<CreateCampaignInput>;
  return (
    typeof seed.name === "string" &&
    typeof seed.targetRegion === "string" &&
    typeof seed.targetAudience === "string" &&
    typeof seed.mode === "string" &&
    (MODE_OPTIONS as readonly string[]).includes(seed.mode)
  );
}

/** Read and clear the seed. Reading it is what spends it. */
export function takeSeed(): CreateCampaignInput | null {
  try {
    const raw = localStorage.getItem(CREATE_SEED_KEY);
    localStorage.removeItem(CREATE_SEED_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredSeed(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult | null> {
  if (!publishSeed(input)) return null;
  return { id: "", route: "/brief/new" };
}
