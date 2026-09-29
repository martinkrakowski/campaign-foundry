import { rowRisk, type Risk } from "./rows.js";

export interface DiscoverRiskIo {
  readonly readdir: (dir: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<string>;
}

/**
 * A lane's risk tier, discovered by grepping EVERY plan under `planningDir`
 * for the lane's row — D184's own choice, made because `merge-prs.sh`'s spec
 * (`pr|worktree|branch|lane|wave`) carries no plan field: the tier is FOUND,
 * never named on the command line.
 *
 * A FAIL-CLOSED UNION, not "the first plan that names it wins": every `.md`
 * file is read, and `high` in ANY one of them makes the lane `high` — sorted
 * order only decides which `normal` match is reported when none of them say
 * `high`. A real plan directory carries 20+ plans; an old plan's `normal`
 * row must never shadow a NEW plan's `**high**` one just because it sorts
 * first.
 *
 * `undefined` — never `normal` — means the tier could not be established at
 * all: the directory could not be read, or no plan names this lane in an
 * unambiguous row. A lane that is merely unknown here must never be read the
 * same as one this gate has actually cleared as low-stakes; the caller
 * refuses on `undefined`, exactly as it would on a plan it could not read.
 */
export async function discoverRisk(
  laneId: string,
  planningDir: string,
  io: DiscoverRiskIo,
): Promise<Risk | undefined> {
  let entries: readonly string[];
  try {
    entries = await io.readdir(planningDir);
  } catch {
    return undefined;
  }

  const files = entries.filter((name) => name.endsWith(".md")).sort();
  let found: Risk | undefined;
  for (const name of files) {
    let text: string;
    try {
      text = await io.readFile(`${planningDir}/${name}`);
    } catch {
      continue;
    }
    let tier: Risk;
    try {
      tier = rowRisk(text, laneId);
    } catch {
      // Zero or more-than-one match: this plan does not name the lane
      // unambiguously. Not an error — try the next plan.
      continue;
    }
    if (tier === "high") return "high";
    found = "normal";
  }
  return found;
}
