import { importCampaignStep } from "./campaign-step.js";

export type StepContext = {
  orgId: string;
  switchedAt: Date; // the parsed Date, never the raw --switched-at string (PT-8a1 req 4)
  projectRoot: string;
  outputRoot: string;
  includeSamples: boolean;
  fsOnly: boolean;
};

export type CampaignOutcome = "created" | "completed" | "unchanged" | "refused";

/** Minimal shape PT-8a1's `plan` assembles per discovered campaign; PT-8a1 may extend it. */
export type PlannedCampaign = {
  slug: string;
  sourcePath: string;
};

export type ImportStep = (
  ctx: StepContext,
  campaign: PlannedCampaign,
) => Promise<{ outcome: CampaignOutcome }>;

/** One row a later step wrote, skipped or refused, as the campaign's result line records it (PT-8c). */
export interface RowEntry {
  readonly kind: "report" | "pool" | "decisions";
  /** `failed`: the store threw, so whether the row was written is not known. */
  readonly status: "written" | "skipped" | "refused" | "failed";
  /** The row's revision; for a written or skipped row it is the revision stored now. */
  readonly revision?: string;
  readonly reason?: string;
  /** Pools only: the stored bytes are the canonical form, not the file's own bytes (F6). */
  readonly recanonicalised?: boolean;
}

/**
 * What a step AFTER the campaign step answers. It has no `outcome`: a later
 * step adds to the campaign's line and can never replace what the campaign
 * step said (owner, 2026-10-11). A row that is `refused` or `failed` makes the
 * line partial by itself; `partial` is for anything else a step could not finish.
 */
export interface StepAddition {
  readonly rows: readonly RowEntry[];
  readonly partial?: boolean;
}

export type FollowUpStep = (ctx: StepContext, campaign: PlannedCampaign) => Promise<StepAddition>;

/** The campaign step first, then the steps that add to its line, in order. */
export type ImportSteps = readonly [ImportStep, ...FollowUpStep[]];

export const IMPORT_STEPS: ImportSteps = [importCampaignStep];
