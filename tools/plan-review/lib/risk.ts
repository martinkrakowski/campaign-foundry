import { rowRisk, type Risk } from "./rows.js";

export interface DiscoverRiskIo {
  readonly readdir: (dir: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<string>;
}

/**
 * A lane's risk tier, discovered by grepping every plan under `planningDir`
 * for the lane's row — D184's own choice, made because `merge-prs.sh`'s spec
 * (`pr|worktree|branch|lane|wave`) carries no plan field: the tier is FOUND,
 * never named on the command line. Files are tried in sorted (filename)
 * order; the first whose row is unambiguous (`rowRisk` does not throw) wins.
 * A lane absent from every plan — or present only in plans where its row is
 * missing or duplicated — counts as `normal`, exactly as an unreviewed plan
 * row does for `rowHash`.
 */
export async function discoverRisk(
  laneId: string,
  planningDir: string,
  io: DiscoverRiskIo,
): Promise<Risk> {
  let entries: readonly string[];
  try {
    entries = await io.readdir(planningDir);
  } catch {
    return "normal";
  }

  const files = entries.filter((name) => name.endsWith(".md")).sort();
  for (const name of files) {
    let text: string;
    try {
      text = await io.readFile(`${planningDir}/${name}`);
    } catch {
      continue;
    }
    try {
      return rowRisk(text, laneId);
    } catch {
      // Zero or more-than-one match: this plan does not name the lane
      // unambiguously. Not an error — try the next plan.
      continue;
    }
  }
  return "normal";
}
