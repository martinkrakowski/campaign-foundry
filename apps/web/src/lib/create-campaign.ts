"use client";

import { MODE_OPTIONS, slugify, type CampaignMode } from "@/components/campaign/editor-state";
import { duplicateBrief } from "./briefs-api";

/**
 * D65 — create is a seam, not a POST. The dialog hands the four Identity answers
 * (plus, from W2, an optional source) to `createCampaign` and receives
 * `{ id, route }`, or `null` when the seed write is refused; it derives no id and
 * shows no slug.
 * The wave-1 body publishes the seed the blank-route editor consumes (D66) and
 * writes nothing else; the W2 body duplicates the chosen source with the dialog's
 * overrides (D71). Under D64(b) both bodies become a POST that mints a draft row
 * and returns its route, and nothing else in the lane changes.
 */

export interface CreateCampaignInput {
  readonly name: string;
  readonly targetRegion: string;
  readonly targetAudience: string;
  readonly mode: CampaignMode;
  /**
   * W2 (D71) — the chosen source brief's id. Absent means a blank create: the seed
   * is published and nothing else is written.
   */
  readonly source?: string;
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
  // W2 (D71) — with a source the create is a duplicate-with-overrides: the copy's
  // id is derived HERE, by importing the Identity step's own rule (F18 — never
  // reproduced), the dialog's region and audience override the source's, and no
  // seed is published. The seed is spent only by a mounted editor on the blank
  // route; a source create lands on /brief/<newId> and would leave the key alive
  // for the next /brief/new visit to load blank over and purge — the bug W3 (#186)
  // closed. The step baton belongs to the dialog's blank path alone.
  //
  // Failure contract, stated plainly: a refused duplicate REJECTS — the
  // BriefsApiError (a 409 collision, a 500, a dropped connection) reaches the
  // caller's catch. `null` stays the blank path's storage-refusal contract alone;
  // this branch never returns it.
  if (input.source !== undefined) {
    const newId = slugify(input.name);
    await duplicateBrief(input.source, newId, {
      targetRegion: input.targetRegion,
      targetAudience: input.targetAudience,
    });
    return { id: newId, route: `/brief/${newId}` };
  }
  if (!publishSeed(input)) return null;
  return { id: "", route: "/brief/new" };
}
