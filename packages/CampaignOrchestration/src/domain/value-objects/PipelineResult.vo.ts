import type { GeneratedAsset } from "../entities/GeneratedAsset.js";
import type { PipelineExecutionLog } from "./PipelineExecutionLog.vo.js";

/** PipelineResult — the output of a full pipeline run. */
export interface PipelineResult {
  readonly assets: readonly GeneratedAsset[];
  readonly log: PipelineExecutionLog;
  /** True when the legal gate halted the run before any creative was generated. */
  readonly halted: boolean;
  /** Variation-plan hash. Omitted on classic runs so persisted reports stay byte-identical. */
  readonly policyHash?: string;
  /** Variation-plan seed. Omitted on classic runs. */
  readonly seed?: number;
}
