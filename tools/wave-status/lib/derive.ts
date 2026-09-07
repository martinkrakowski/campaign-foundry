import type { DerivedLane, LaneObservation } from "./types.js";

export function parseLastExit(tail: string): number | undefined {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^EXIT (\d+)$/.exec(lines[i]);
    if (match) return Number(match[1]);
  }
  return undefined;
}

export function parseGateLog(text: string): {
  readonly exit?: number;
  readonly coverage?: {
    readonly statements: number;
    readonly branches: number;
    readonly functions: number;
    readonly lines: number;
  };
} {
  const lines = text.split("\n");

  let exit: number | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const gateMatch = /^GATE EXIT (\d+)$/.exec(line);
    const exitMatch = /^EXIT (\d+)$/.exec(line);
    if (gateMatch) {
      exit = Number(gateMatch[1]);
    } else if (exitMatch) {
      exit = Number(exitMatch[1]);
    }
    break;
  }

  let statements: number | undefined;
  let branches: number | undefined;
  let functions: number | undefined;
  let lineCount: number | undefined;
  for (const line of lines) {
    const stmt = /Statements\s*:\s*([\d.]+)%/.exec(line);
    if (stmt) statements = Number(stmt[1]);
    const br = /Branches\s*:\s*([\d.]+)%/.exec(line);
    if (br) branches = Number(br[1]);
    const fn = /Functions\s*:\s*([\d.]+)%/.exec(line);
    if (fn) functions = Number(fn[1]);
    const ln = /Lines\s*:\s*([\d.]+)%/.exec(line);
    if (ln) lineCount = Number(ln[1]);
  }

  const coverage =
    statements !== undefined &&
    branches !== undefined &&
    functions !== undefined &&
    lineCount !== undefined
      ? { statements, branches, functions, lines: lineCount }
      : undefined;

  return {
    ...(exit !== undefined ? { exit } : {}),
    ...(coverage !== undefined ? { coverage } : {}),
  };
}

export function deriveLane(obs: LaneObservation): DerivedLane {
  const exit = obs.log === undefined ? undefined : parseLastExit(obs.log.tail);
  const parsedGate = obs.gateLog === undefined ? undefined : parseGateLog(obs.gateLog);
  const gate =
    parsedGate !== undefined &&
    (parsedGate.exit !== undefined || parsedGate.coverage !== undefined)
      ? parsedGate
      : undefined;

  return {
    ...(exit !== undefined ? { exit } : {}),
    ...(gate !== undefined ? { gate } : {}),
    alive: obs.alive,
    ...(obs.log !== undefined ? { log: obs.log } : {}),
    ...(obs.pr !== undefined ? { pr: obs.pr } : {}),
    ...(obs.diff !== undefined ? { diff: obs.diff } : {}),
  };
}
