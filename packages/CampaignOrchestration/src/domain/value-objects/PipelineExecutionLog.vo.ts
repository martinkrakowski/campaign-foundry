import type { LogEntry, LogLevel } from "./LogEntry.vo.js";

/**
 * PipelineExecutionLog — operational telemetry for one pipeline run. Decoupled
 * from the domain entities so they carry no runtime state. Acts as an append-only
 * accumulator the use case writes to as it progresses.
 */
export class PipelineExecutionLog {
  private readonly _entries: LogEntry[] = [];
  readonly startedAt: Date;
  completedAt?: Date;
  totalOperations = 0;

  constructor(
    readonly campaignId: string,
    private readonly now: () => Date,
  ) {
    this.startedAt = now();
  }

  record(stage: string, message: string, level: LogLevel = "info"): void {
    this._entries.push({ timestamp: this.now(), stage, message, level });
  }

  complete(): void {
    this.completedAt = this.now();
  }

  get entries(): readonly LogEntry[] {
    return this._entries;
  }

  toJSON() {
    return {
      campaignId: this.campaignId,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      totalOperations: this.totalOperations,
      entries: this._entries,
    };
  }
}
