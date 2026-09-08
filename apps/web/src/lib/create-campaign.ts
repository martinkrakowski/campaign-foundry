"use client";

import { CAMPAIGN_TYPES, type CampaignType } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { slugify } from "@/components/campaign/editor-state";
import { duplicateBrief } from "./briefs-api";
import { takeStashedStep } from "./use-step-navigation";

/**
 * D65 — create is a seam, not a POST. The dialog hands the two create answers — a
 * campaign name and a campaign type (D108, which superseded D97's mode; the type's
 * preset is applied once by the editor, D109) — plus, from W2, an optional source,
 * to `createCampaign` and receives `{ id, route }`, or `null` when the seed write is
 * refused; it derives no id and shows no slug.
 * The wave-1 body publishes the seed the blank-route editor consumes (D66) and
 * writes nothing else; the W2 body duplicates the chosen source (D71). Under D64(b)
 * both bodies become a POST that mints a draft row and returns its route, and
 * nothing else in the lane changes.
 */

export interface CreateCampaignInput {
  readonly name: string;
  /** The campaign type (D108) — resolved through `CAMPAIGN_TYPE_PRESETS` on arrival. */
  readonly type: CampaignType;
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

/**
 * Minimal shape guard for a seed restored from storage (don't trust hand-edited JSON).
 * F5 — an old-shape seed is REJECTED, not half-applied: accepting it would seed a
 * brief with a name and nothing else, silently. Two retired shapes exist: the
 * four-field one (region and audience spelled) and the #217 two-field one (`mode`,
 * which D108 retired with the type). The right answer for a seed written by a
 * deployed predecessor is to discard it and let the user start clean.
 */
function isStoredSeed(value: unknown): value is CreateCampaignInput {
  if (typeof value !== "object" || value === null) return false;
  // The retired fields are spelled on the cast, not on the type: they exist only so
  // the guard can refuse the shapes their builds wrote — no consumer may read them
  // off a seed again.
  const seed = value as Partial<CreateCampaignInput> & {
    targetRegion?: unknown;
    targetAudience?: unknown;
    mode?: unknown;
  };
  // Unknown extra keys are accepted: this is a shape check, not a freeze, so a later build can add a field without this one discarding its seeds.
  return (
    typeof seed.name === "string" &&
    typeof seed.type === "string" &&
    (CAMPAIGN_TYPES as readonly string[]).includes(seed.type) &&
    seed.targetRegion === undefined &&
    seed.targetAudience === undefined &&
    seed.mode === undefined
  );
}

/**
 * Read and clear the seed. Reading it is what spends it.
 *
 * `null` is two different facts, and they must not be treated the same: there was
 * no seed, or there was one we refused. A refusal also spends the companion step
 * baton so a leftover `"copy"` from a previous build cannot land the user past two
 * empty required fields (D98). An absent seed leaves that baton alone — it is H5's,
 * not ours.
 */
export function takeSeed(): CreateCampaignInput | null {
  try {
    const raw = localStorage.getItem(CREATE_SEED_KEY);
    localStorage.removeItem(CREATE_SEED_KEY);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      takeStashedStep();
      return null;
    }
    if (isStoredSeed(parsed)) return parsed;
    takeStashedStep();
    return null;
  } catch {
    return null;
  }
}

export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult | null> {
  // W2 (D71) — with a source the create is a duplicate-with-overrides: the copy's
  // id is derived HERE, by importing the Identity step's own rule (F18 — never
  // reproduced), and no seed is published. The seed is spent only by a mounted
  // editor on the blank route; a source create lands on /brief/<newId> and would
  // leave the key alive for the next /brief/new visit to load blank over and purge
  // — the bug W3 (#186) closed. The step baton belongs to the dialog's blank path
  // alone.
  //
  // D97 — the overrides body is empty: the dialog no longer answers region or
  // audience, so the copy inherits the source's answers wholesale. The route still
  // accepts the two — the parameter is now carried by no caller's data, which the
  // lane records as a vestigial-candidate finding rather than silently keeping or
  // cutting.
  //
  // Failure contract, stated plainly: a refused duplicate REJECTS — the
  // BriefsApiError (a 409 collision, a 500, a dropped connection) reaches the
  // caller's catch. `null` stays the blank path's storage-refusal contract alone;
  // this branch never returns it.
  if (input.source !== undefined) {
    const newId = slugify(input.name);
    await duplicateBrief(input.source, newId, {});
    return { id: newId, route: `/brief/${newId}` };
  }
  if (!publishSeed(input)) return null;
  return { id: "", route: "/brief/new" };
}
