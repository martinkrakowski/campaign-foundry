import { deriveLane } from "./derive.js";
import type {
  DerivedLane,
  LaneObservation,
  LaneStatus,
  WaveEvent,
  WaveStatus,
} from "./types.js";

export function mergeStatus(
  events: readonly WaveEvent[],
  observed: Readonly<Record<string, LaneObservation>>,
  now: string,
): WaveStatus {
  const groups: { id: string; lanes: string[] }[] = [];
  const groupByWave = new Map<string, { id: string; lanes: string[] }>();
  const latestByKey = new Map<string, WaveEvent>();

  const remember = (wave: string, lane: string): void => {
    let group = groupByWave.get(wave);
    if (group === undefined) {
      group = { id: wave, lanes: [] };
      groupByWave.set(wave, group);
      groups.push(group);
    }
    if (!group.lanes.includes(lane)) group.lanes.push(lane);
  };

  for (const event of events) {
    remember(event.wave, event.lane);
    latestByKey.set(`${event.wave}/${event.lane}`, event);
  }

  for (const key of Object.keys(observed)) {
    const parsed = parseObservedKey(key);
    if (parsed === undefined) continue;
    remember(parsed.wave, parsed.lane);
  }

  return {
    generatedAt: now,
    waves: groups.map((group) => ({
      id: group.id,
      lanes: group.lanes.map((lane) =>
        buildLane(group.id, lane, latestByKey.get(`${group.id}/${lane}`), observed[`${group.id}/${lane}`]),
      ),
    })),
  };
}

function parseObservedKey(key: string): { wave: string; lane: string } | undefined {
  const parts = key.split("/");
  if (parts.length !== 2) return undefined;
  const wave = parts[0];
  const lane = parts[1];
  if (!wave || !lane) return undefined;
  return { wave, lane };
}

function buildLane(
  wave: string,
  lane: string,
  latest: WaveEvent | undefined,
  obs: LaneObservation | undefined,
): LaneStatus {
  const derived: DerivedLane = obs === undefined ? { alive: false } : deriveLane(obs);
  const reported = latest === undefined ? undefined : reportedFrom(latest);
  return {
    wave,
    lane,
    ...(reported !== undefined ? { reported } : {}),
    derived,
    disagreements: findDisagreements(reported, derived, obs !== undefined),
  };
}

function reportedFrom(event: WaveEvent): NonNullable<LaneStatus["reported"]> {
  return {
    stage: event.stage,
    event: event.event,
    ts: event.ts,
    ...(event.pr !== undefined ? { pr: event.pr } : {}),
    ...(event.round !== undefined ? { round: event.round } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
  };
}

function findDisagreements(
  reported: LaneStatus["reported"],
  derived: DerivedLane,
  observed: boolean,
): readonly string[] {
  if (reported === undefined) return [];

  const disagreements: string[] = [];

  // "No PR found" is a gh observation. An events-only row has no observation, so
  // a missing derived.pr there is "nobody looked", not "there is no PR".
  if (
    observed &&
    reported.stage === "implement" &&
    reported.event === "settled" &&
    reported.pr === undefined &&
    !derived.pr
  ) {
    disagreements.push("lane says implement settled; no PR found");
  }

  if (reported.stage === "merge" && reported.event === "settled" && derived.pr?.state === "open") {
    disagreements.push(`lane says merge settled; PR #${derived.pr.number} is still open`);
  }

  if (reported.stage === "merge" && reported.event === "settled" && derived.pr?.state === "closed") {
    disagreements.push(`lane says merge settled; PR #${derived.pr.number} was closed without merging`);
  }

  if (reported.event === "settled" && derived.exit !== undefined && derived.exit !== 0) {
    disagreements.push(`lane says ${reported.stage} settled; lane log reports EXIT ${derived.exit}`);
  }

  if (
    reported.stage === "gate" &&
    reported.event === "settled" &&
    derived.gate?.exit !== undefined &&
    derived.gate.exit !== 0
  ) {
    disagreements.push(`lane says gate settled; gate log reports GATE EXIT ${derived.gate.exit}`);
  }

  // Hang is a pgrep claim. An events-only row has no observation, so alive:false
  // there is "nobody looked", not "the process is dead".
  if (
    observed &&
    reported.event === "started" &&
    !derived.alive &&
    derived.exit === undefined
  ) {
    disagreements.push(
      `lane says ${reported.stage} started; the process is not alive and the log has no EXIT marker`,
    );
  }

  if (reported.stage === "gate" && reported.event === "settled" && derived.gate?.coverage) {
    const cov = derived.gate.coverage;
    const below: string[] = [];
    if (cov.statements < 100) below.push(`statements: ${cov.statements}%`);
    if (cov.branches < 100) below.push(`branches: ${cov.branches}%`);
    if (cov.functions < 100) below.push(`functions: ${cov.functions}%`);
    if (cov.lines < 100) below.push(`lines: ${cov.lines}%`);
    if (below.length > 0) {
      disagreements.push(`lane says gate settled; coverage below 100% (${below.join(", ")})`);
    }
  }

  return disagreements;
}
