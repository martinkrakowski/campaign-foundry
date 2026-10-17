import { importCampaignStep } from "./campaign-step.js";
import { importRowsStep } from "./rows-step.js";

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

/** One object a later step CREATED in this run, as the result file lists it (D229). */
export interface MintedObject {
  /** The object key exactly as it was written: a rollback deletes exactly this key. */
  readonly key: string;
  /** What the key holds, as the source names it (for a render: its path in the report). */
  readonly path: string;
}

/** One render a later step wrote, found or left, as the campaign's result line records it (PT-8d). */
export interface RenderEntry {
  /** The render's path, as the report names it. */
  readonly path: string;
  /**
   * `written`: this run created the object. `skipped`: the same bytes were already
   * stored. `present`: no source file, an object is at the key. `missing`: no source
   * file and no object. `refused`: not written, and `reason` says why. `failed`: the
   * store or the reader threw, so whether an object was written is not known.
   */
  readonly status: "written" | "skipped" | "present" | "missing" | "refused" | "failed";
  /** The object key; absent when none could be built. */
  readonly key?: string;
  readonly reason?: string;
}

/**
 * What `applyCampaigns` hands a follow-up step about the line it adds to (PT-8d4).
 * `rows`: the rows the steps BEFORE it put on this campaign's line, so a step can
 * act on what an earlier step did (renders follow the report row, Grok PT-8d 4).
 * `recordMinted`: the step calls it for each object it CREATED and awaits it
 * BEFORE its next write (Grok PT-8d 6); it resolves when the record is durable.
 * If it throws, the record could not be kept: the step must write nothing more.
 */
export interface StepLine {
  readonly rows: readonly RowEntry[];
  readonly recordMinted: (object: MintedObject) => Promise<void>;
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
  /**
   * The renders this step wrote, found or left (PT-8d). A render that is `missing`,
   * `refused` or `failed` makes the line partial by itself (Grok PT-8d 5).
   */
  readonly renders?: readonly RenderEntry[];
  /**
   * What this step CREATED in this run (D229); absent when it created nothing.
   * Never an object that was already there, and never one whose write failed.
   * A step that writes objects must not throw once it has written one: it
   * catches its own failure and answers what it minted, with `partial: true`.
   * An object the step already gave to `StepLine.recordMinted` need not be
   * answered here again: each key is listed and counted once.
   */
  readonly minted?: { readonly objects: readonly MintedObject[] };
}

export type FollowUpStep = (
  ctx: StepContext,
  campaign: PlannedCampaign,
  line: StepLine,
) => Promise<StepAddition>;

/** The campaign step first, then the steps that add to its line, in order. */
export type ImportSteps = readonly [ImportStep, ...FollowUpStep[]];

export const IMPORT_STEPS: ImportSteps = [importCampaignStep, importRowsStep];
