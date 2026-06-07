export type LogLevel = "info" | "warn" | "error";

/** LogEntry — a single line in the pipeline execution log. */
export interface LogEntry {
  readonly timestamp: Date;
  readonly stage: string;
  readonly message: string;
  readonly level: LogLevel;
}
