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

export const IMPORT_STEPS: readonly ImportStep[] = [];
