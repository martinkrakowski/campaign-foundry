import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/*
 * The gate-only closing line is gone from the repository, and the four places
 * that carry the line a lane reads instead all carry the reworded one.
 *
 * The old line named ONE command — the gate — as the thing to run in the
 * foreground. That contradicts every other instruction a midnight lane is
 * given: the brief says run the targeted commands and let CI be the gate, and
 * on that host the gate cannot pass. A lane reading it literally spent ~1,600 s
 * on a suite that could not go green, having been told to.
 *
 * The rule the old line was earning did not need the word "gate". What it
 * forbids is reporting a task that was launched and never watched, and "every
 * verification command" forbids it just as well — with the rule a midnight
 * lane can actually keep.
 *
 * The scan walks the trees rather than shelling out to `git grep`: it has to be
 * a line of vitest that answers on its own, and a scan whose reach nobody can
 * see is not a scan that has been checked.
 */

/** The repository root, from this file three directories down. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The retired sentence, ASSEMBLED rather than written out.
 *
 * This file lives under `tools/`, which is one of the three trees it scans, so
 * a literal would match itself and the test would fail for ever against its own
 * source. The split is at the word "gate" because the second half of the old
 * line — "A task you launched is not a result." — is still true and still
 * carried by the new one, so it is the first half that has to be absent.
 */
const RETIRED = ["Run the gate", "in the foreground and read its exit code."].join(" ");

/** What every one of the four now says instead. */
const CURRENT =
  "Run every verification command in the foreground and read its exit code. " +
  "A task you launched is not a result.";

/**
 * The trees a lane reads the line out of.
 *
 * `docs/planning/` is NOT among them, and deliberately: the wave plan quotes
 * the old sentence in the row that recorded the change, and that row is the
 * record of what used to be said. A test that failed on the record of its own
 * repair would be a test that could only be satisfied by deleting the history.
 */
const TREES = ["docs/workflows", "tools", ".claude"] as const;

/** The files the line is stated in, one per reader of it. */
const SITES = [
  "docs/workflows/delegated-implementation-pipeline.md",
  "tools/fix-brief/lib/template.ts",
  ".claude/skills/orchestrate-wave/SKILL.md",
  ".claude/skills/orchestrate-wave/references/cast.md",
] as const;

/**
 * Every regular file under `tree`, as a path relative to the repository root.
 *
 * `withFileTypes` rather than the bare recursive listing: the latter's overload
 * is typed `string[] | NonSharedBuffer[]`, because `encoding: null` is a legal
 * way to ask for it, and a scan of a tree of Markdown and TypeScript has no use
 * for a Buffer. The dirent also carries its own parent's path, so no second
 * stat is needed to tell which entries are directories — and that path is the
 * one the walk was GIVEN, absolute, so it is taken back to repo-relative here:
 * a failure has to name a path somebody can open, and a worktree's own absolute
 * prefix on every one of 130 lines buries the four that matter.
 */
function filesUnder(tree: string): readonly string[] {
  return readdirSync(join(ROOT, tree), { recursive: true, withFileTypes: true }).flatMap((entry) =>
    entry.isFile() ? [relative(ROOT, join(entry.parentPath, entry.name))] : [],
  );
}

const SCANNED = TREES.flatMap(filesUnder);

describe("the closing line a lane brief ends with", () => {
  test("the retired sentence appears nowhere under the trees a lane reads", () => {
    // Named per file rather than one aggregate assertion: "the scan found
    // nothing" and "the scan found it in four places" are the same empty diff
    // from here, and only the second reading is worth anything.
    const carriers = SCANNED.filter((path) =>
      readFileSync(join(ROOT, path), "utf8").includes(RETIRED),
    );
    expect(carriers).toEqual([]);
  });

  test("the scan reaches the files that carry the line, so the check above is not vacuous", () => {
    // A walk that matched nothing would pass the test above for the wrong
    // reason. This one names the four sites, so a tree that moved, or a scan
    // that stopped descending, fails here instead of passing silently.
    expect(SCANNED).toEqual(expect.arrayContaining([...SITES]));
    for (const site of SITES) {
      expect(readFileSync(join(ROOT, site), "utf8"), site).toContain(CURRENT);
    }
  });
});
