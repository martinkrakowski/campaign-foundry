/**
 * The two opencode server reads `lane:watch` makes, as the shapes the row
 * verified live against opencode 1.18.33 (2026-09-30). They are declared as
 * the SUBSET this tool reads, not as the server's whole schema: every field
 * here is one the row names, and a field the server adds later is ignored
 * rather than becoming a type this tool has to keep in step.
 */

/**
 * One `GET /session/{sessionID}` body, as far as `usage` reads it.
 *
 * `time.created` / `time.updated` are ms epoch. `tokens.cache` is a nested
 * object, and `tokens` and `cost` are both OPTIONAL — the row verified the
 * last two are not required by the schema, which is why their absence is a
 * reported "unknown" (exit 3) and never a guessed 0.
 */
export interface SessionShape {
  readonly time?: {
    readonly created?: number;
    readonly updated?: number;
  };
  readonly tokens?: {
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cache?: {
      readonly read?: number;
      readonly write?: number;
    };
  };
  readonly cost?: number;
  readonly title?: string;
  readonly directory?: string;
}

/** One `GET /global/event` data frame: the envelope, then the payload inside it. */
export interface EventEnvelope {
  readonly payload?: {
    readonly type?: string;
    readonly properties?: {
      /**
       * The session this event belongs to. OPTIONAL: the row recorded that
       * `session.error` may arrive without one, and such an error is printed
       * but not attributed and does not end the watch.
       */
      readonly sessionID?: string;
      readonly part?: MessagePart;
      readonly status?: SessionStatus;
      readonly error?: SessionError;
    };
  };
}

/**
 * The `part` of a `message.part.updated`. The row names three types worth a
 * line — `tool`, `step-start`, `step-finish` — and every other one (`text`,
 * `reasoning`, and the ~50/s `message.part.delta`) is dropped before printing.
 *
 * `tokens` and `cost` on a `step-finish` are `unknown` here rather than a
 * declared shape: the row names the fields but not their structure, so they
 * are carried opaquely and rendered by `compact()`. A type that asserted a
 * structure the row does not state would be a contract this tool invented.
 */
export interface MessagePart {
  readonly type?: string;
  readonly tool?: string;
  readonly state?: {
    readonly status?: string;
  };
  readonly reason?: string;
  readonly tokens?: unknown;
  readonly cost?: unknown;
}

/** The `status` of a `session.status` event. Only `idle` and `retry` are read. */
export interface SessionStatus {
  readonly type?: string;
  readonly attempt?: number;
  readonly message?: string;
  readonly next?: string;
}

/** The `error` of a `session.error` event. */
export interface SessionError {
  readonly name?: string;
  readonly data?: {
    readonly message?: string;
  };
}

/** What a lane has cost, as `usage` reports it. `null` is "the server did not say". */
export interface Usage {
  readonly secs: number | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly reasoning: number | null;
  readonly cache_read: number | null;
  readonly cache_write: number | null;
  readonly cost: number | null;
  readonly title: string;
  readonly directory: string;
}

/**
 * A process the tool ran: the exit code, and what it said on stderr.
 *
 * The stderr is part of the result and not a side channel because
 * `wave-event.sh` puts its REASON for refusing an event there — an unknown
 * stage is answered on stderr with exit 2 — and that reason is the whole value
 * of delegating validation to the script instead of copying its list.
 */
export interface SpawnResult {
  readonly code: number;
  readonly stderr: string;
}
