import type { GeneratedAsset } from "../entities/GeneratedAsset.js";
import type { PipelineExecutionLog } from "./PipelineExecutionLog.vo.js";

/** PipelineResult — the output of a full pipeline run. */
export interface PipelineResult {
  readonly assets: readonly GeneratedAsset[];
  readonly log: PipelineExecutionLog;
  /** True when the legal gate halted the run before any creative was generated. */
  readonly halted: boolean;
}
