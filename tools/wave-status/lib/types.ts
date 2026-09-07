export type Stage =
  | "dispatch"
  | "implement"
  | "gate"
  | "review"
  | "remediate"
  | "sweep"
  | "merge"
  | "record";

export type EventKind = "started" | "settled" | "failed";

export interface WaveEvent {
  readonly ts: string;
  readonly wave: string;
  readonly lane: string;
  readonly stage: Stage;
  readonly event: EventKind;
  readonly pr?: number;
  readonly round?: number;
  readonly detail?: {
    readonly fixed?: number;
    readonly refuted?: number;
    readonly mutations?: number;
    readonly mutationsBit?: number;
    readonly [k: string]: unknown;
  };
}

export interface LaneObservation {
  readonly log?: {
    readonly bytes: number;
    readonly mtimeMs: number;
    readonly tail: string;
  };
  readonly gateLog?: string;
  readonly alive: boolean;
  readonly pr?: {
    readonly number: number;
    readonly state: "open" | "merged" | "closed";
    readonly checks: "none" | "pending" | "pass" | "fail";
  };
  readonly diff?: {
    readonly files: number;
    readonly insertions: number;
    readonly deletions: number;
  };
}

export interface DerivedLane {
  readonly exit?: number;
  readonly gate?: {
    readonly exit?: number;
    readonly coverage?: {
      statements: number;
      branches: number;
      functions: number;
      lines: number;
    };
  };
  readonly alive: boolean;
  readonly log?: LaneObservation["log"];
  readonly pr?: LaneObservation["pr"];
  readonly diff?: LaneObservation["diff"];
}

export interface LaneStatus {
  readonly wave: string;
  readonly lane: string;
  readonly reported?: {
    readonly stage: Stage;
    readonly event: EventKind;
    readonly ts: string;
    readonly pr?: number;
    readonly round?: number;
    readonly detail?: WaveEvent["detail"];
  };
  readonly derived: DerivedLane;
  readonly disagreements: readonly string[];
}

export interface WaveStatus {
  readonly generatedAt: string;
  readonly waves: readonly {
    readonly id: string;
    readonly lanes: readonly LaneStatus[];
  }[];
}
