import type { LaneStatus, WaveStatus } from "./types.js";

/**
 * The terminal face of the wave-status tool: the same columns the page renders
 * (public/index.html), one block per wave, one line per lane. `renderStatus` is
 * pure — no I/O, no clock, no `process` — so the same status renders the same
 * string anywhere, and colour is an explicit opt-in, never ambient.
 */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

const DEFAULT_WIDTH = 100;
const ROW_INDENT = "  ";
const COLUMN_GAP = "  ";
const ABSENT = "—";

/** A complete SGR sequence; `^` anchors it, so `exec` only matches at index 0. */
const SGR_PREFIX = /^\x1b\[[0-9;]*m/;

/** A complete non-SGR escape run — e.g. `\x1b[2J` — which the renderer never paints. */
const FOREIGN_ESCAPE = /^\x1b(?:\[[\x20-\x3f]*[\x40-\x7e]|(?!\[)[\x20-\x2f]*[\x40-\x7e])/;

export interface RenderOptions {
  readonly width?: number;
  readonly color?: boolean;
}

const withCode = (code: string, text: string): string => `${code}${text}${RESET}`;

/** C0 control bytes (0x00–0x1F) and DEL (0x7F) are terminal control, never text. */
const CONTROL = /[\x00-\x1f\x7f]/g;

/** Identifiers come from filenames on disk; never let their bytes reprogram the terminal. */
function sanitize(identifier: string): string {
  return identifier.replace(CONTROL, "");
}

/** A table column: its plain text, and how that text is painted when colour is on. */
interface Column {
  readonly header: string;
  readonly cell: (lane: LaneStatus) => string;
  readonly paint: (lane: LaneStatus, text: string) => string;
}

function laneCell(lane: LaneStatus): string {
  return `${sanitize(lane.wave)}/${sanitize(lane.lane)}`;
}

function stageCell(lane: LaneStatus): string {
  const reported = lane.reported;
  if (reported === undefined) return ABSENT;
  const round = reported.round === undefined ? "" : ` (round ${reported.round})`;
  const isStalled = reported.event === "started" && !lane.derived.alive;
  const event = isStalled ? "stalled" : reported.event;
  return `${reported.stage} ${event}${round}`;
}

function livenessCell(lane: LaneStatus): string {
  return lane.derived.alive ? "alive" : "not alive";
}

function prCell(lane: LaneStatus): string {
  const pr = lane.derived.pr;
  return pr === undefined ? ABSENT : `#${pr.number} ${pr.state} ${pr.checks}`;
}

function gateCell(lane: LaneStatus): string {
  const gate = lane.derived.gate;
  if (gate === undefined) return ABSENT;
  const exit = gate.exit === undefined ? ABSENT : `exit ${gate.exit}`;
  const coverage =
    gate.coverage === undefined
      ? ""
      : ` · ${gate.coverage.statements}/${gate.coverage.branches}/${gate.coverage.functions}/${gate.coverage.lines}%`;
  return `${exit}${coverage}`;
}

/** The tones mirror the page: failed red, settled green, started cyan, absent dim. */
const COLUMNS: readonly Column[] = [
  { header: "lane", cell: laneCell, paint: (_lane, text) => text },
  {
    header: "stage",
    cell: stageCell,
    paint: (lane, text) => {
      const event = lane.reported?.event;
      if (event === undefined) return withCode(DIM, text);
      if (event === "failed") return withCode(RED, text);
      if (event === "settled") return withCode(GREEN, text);
      if (event === "started" && !lane.derived.alive) return withCode(YELLOW, text);
      return withCode(CYAN, text);
    },
  },
  {
    header: "liveness",
    cell: livenessCell,
    paint: (lane, text) => withCode(lane.derived.alive ? GREEN : DIM, text),
  },
  {
    header: "pr",
    cell: prCell,
    paint: (lane, text) => {
      const pr = lane.derived.pr;
      if (pr === undefined) return withCode(DIM, text);
      const state = pr.state === "merged" ? GREEN : pr.state === "open" ? CYAN : RED;
      const checks =
        pr.checks === "none"
          ? DIM
          : pr.checks === "pending"
            ? YELLOW
            : pr.checks === "pass"
              ? GREEN
              : RED;
      // prCell is `#N state checks`; the final token carries the checks tone.
      const splitAt = text.lastIndexOf(" ");
      return `${withCode(state, text.slice(0, splitAt))} ${withCode(checks, text.slice(splitAt + 1))}`;
    },
  },
  {
    header: "gate",
    cell: gateCell,
    paint: (lane, text) => {
      const gate = lane.derived.gate;
      if (gate === undefined) return withCode(DIM, text);
      const exitEnd = gate.exit === undefined ? ABSENT.length : `exit ${gate.exit}`.length;
      const head = withCode(
        gate.exit === undefined ? DIM : gate.exit === 0 ? GREEN : RED,
        text.slice(0, exitEnd),
      );
      return `${head}${text.slice(exitEnd)}`;
    },
  },
];

/**
 * Cut a line to `width` visible characters — never wrapped, and re-balanced with
 * a reset when a painted span was cut. Only the renderer's own SGR sequences
 * survive: any other escape run is dropped whole, never emitted half a sequence.
 */
export function truncate(line: string, width: number): string {
  if (!line.includes("\x1b")) return line.slice(0, width);
  let out = "";
  let visible = 0;
  for (let i = 0; i < line.length && visible < width; ) {
    const sgr = SGR_PREFIX.exec(line.slice(i));
    if (sgr !== null) {
      out += sgr[0];
      i += sgr[0].length;
      continue;
    }
    if (line[i] === "\x1b") {
      // An escape the renderer did not paint — or one it cannot complete — is
      // dropped in full so the terminal never lands in an unknown state.
      const foreign = FOREIGN_ESCAPE.exec(line.slice(i));
      if (foreign !== null) {
        i += foreign[0].length;
        continue;
      }
      i += 1;
      if (line[i] === "[") i += 1;
      while (i < line.length && /[\x20-\x3f]/.test(line[i])) i += 1;
      // The byte that stopped the run never completed a sequence; drop it too.
      if (i < line.length) i += 1;
      continue;
    }
    out += line[i];
    visible += 1;
    i += 1;
  }
  return out === line ? line : `${out}${RESET}`;
}

function row(
  cells: readonly string[],
  widths: readonly number[],
  paint: ((text: string, column: number) => string) | undefined,
): string {
  return cells
    .map((text, i) => {
      const body = paint === undefined ? text : paint(text, i);
      const pad = i === cells.length - 1 ? 0 : widths[i] - text.length;
      return body + " ".repeat(pad);
    })
    .join(COLUMN_GAP);
}

export function renderStatus(status: WaveStatus, opts?: RenderOptions): string {
  const width = opts?.width ?? DEFAULT_WIDTH;
  const color = opts?.color === true;

  // Plain text first: column widths come from what the eye sees, not from codes.
  const waves = status.waves.map((wave) => ({
    id: wave.id,
    rows: wave.lanes.map((lane) => ({
      lane,
      cells: COLUMNS.map((column) => column.cell(lane)),
    })),
  }));
  const widths = COLUMNS.map((column, i) =>
    Math.max(
      column.header.length,
      ...waves.flatMap((wave) => wave.rows.map((r) => r.cells[i].length)),
    ),
  );

  const blocks = waves.map((wave) => {
    const block: string[] = [`wave ${sanitize(wave.id)}`];
    if (wave.rows.length > 0) {
      block.push(
        ROW_INDENT +
          row(
            COLUMNS.map((column) => column.header),
            widths,
            color
              ? (text) => withCode(DIM, text)
              : undefined,
          ),
      );
      for (const r of wave.rows) {
        block.push(
          ROW_INDENT +
            row(r.cells, widths, color ? (text, i) => COLUMNS[i].paint(r.lane, text) : undefined),
        );
      }
    }
    return block;
  });
  return blocks
    .flatMap((block, i) => (i === 0 ? block : ["", ...block]))
    .map((line) => truncate(line, width))
    .join("\n");
}
