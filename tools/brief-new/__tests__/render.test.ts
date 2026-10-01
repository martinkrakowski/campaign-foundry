import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ENV_PLACEHOLDER,
  TEMPLATE_F,
  VERIFICATION_MAC,
  VERIFICATION_MIDNIGHT,
  envLinesFrom,
  environmentBlock,
  render,
  substitute,
  verificationFor,
  type BriefHeader,
} from "../lib/template.js";

const DOC = fileURLToPath(
  new URL("../../../docs/workflows/delegated-implementation-pipeline.md", import.meta.url),
);

const header: BriefHeader = {
  lane: "HXF7",
  plan: "docs/planning/2026-09-29_wave-hardening-and-w05-follow-ups.md",
  worktree: "/mnt/pool/cloud-services/projects/.worktrees/cf-hxf7",
  branch: "feat/brief-generator",
  tip: "9f3c8d2a",
  host: "midnight",
};

/**
 * A rendered brief split around its one host-dependent part: everything up to the
 * `## Verification` heading, the block under it, and everything from `## Commit`
 * on. The three together are the whole brief, so comparing them part by part is
 * how a test says "the two hosts differ in exactly one place" rather than "they
 * differ". The blank line that closes the block belongs to the tail, so it is
 * trimmed off the block and the comparison is about its TEXT.
 */
const aroundVerification = (brief: string): { head: string; block: string; tail: string } => {
  const heading = "## Verification";
  const head = brief.slice(0, brief.indexOf(heading) + heading.length);
  const rest = brief.slice(head.length);
  const tail = rest.slice(rest.indexOf("## Commit"));
  return { head, block: rest.slice(0, rest.length - tail.length).replace(/\n+$/, ""), tail };
};

describe("TEMPLATE_F and the doc", () => {
  test("the constant equals the doc's Template F block byte for byte", () => {
    // Anchored on the `### Template F` HEADING, not on "the only 4-backtick block
    // in the file": this doc has other fenced blocks, and a search that did not
    // know which section it meant would stop answering the right question the
    // moment one was added.
    //
    // The block is the lines STRICTLY BETWEEN the fence lines, joined with "\n",
    // so it carries NO trailing newline — the last content line's own newline
    // belongs to the closing fence, not to the block.
    const doc = readFileSync(DOC, "utf8");
    const lines = doc.split("\n");
    const section = lines.findIndex((line) => line.startsWith("### Template F"));
    expect(section).toBeGreaterThanOrEqual(0);
    const open = lines.indexOf("````markdown", section);
    const close = lines.indexOf("````", open + 1);
    expect(open).toBeGreaterThan(section);
    expect(close).toBeGreaterThan(open);
    expect(lines.slice(open + 1, close).join("\n")).toBe(TEMPLATE_F);
  });

  test("every section is present, once, in the template's own order", () => {
    // The headings are what a lane navigates by, so their ORDER is part of the
    // contract too: a plan row above its own verification reads as an unfinished
    // brief, not as a well-organised one.
    const headings = [...render(header).matchAll(/^#{1,2} .+$/gm)].map((match) => match[0]);
    expect(headings).toEqual([
      "# Lane HXF7 — brief",
      "## First: prove the gap",
      "## Notes",
      "## Working rules",
      "## Verification",
      "## Commit",
      "## Must not",
      "## Report",
    ]);
  });

  test("the header carries the worktree, the branch, the tip and the plan read-in-full", () => {
    const brief = render(header);
    expect(brief).toContain(
      "- **Worktree (absolute, on this server):** /mnt/pool/cloud-services/projects/.worktrees/cf-hxf7",
    );
    expect(brief).toContain(
      "- **Branch:** feat/brief-generator, checked out at origin/main 9f3c8d2a",
    );
    expect(brief).toContain(
      "Read the row IN FULL: `grep -n 'HXF7' docs/planning/2026-09-29_wave-hardening-and-w05-follow-ups.md`",
    );
    expect(brief).toContain("No PR exists; you do NOT push or open one.");
    expect(brief).toContain("- **The row is the spec:**");
  });

  test("the working rules, the must-nots and the report survive as prose", () => {
    const brief = render(header);
    for (const line of [
      "run `mkdir -p .agents/briefs/scratch` first",
      "On exit 75 with `gate-lock: busy`, sleep 60 and retry",
      "NEVER remove a lock: a lock is released by its own `run`, and a child you started is released in a `finally`.",
      "`sh scripts/gate-lock.sh run HXF7 -- yarn mutate …`",
      "writing `--because` FIRST",
      "read `coverage/coverage-summary.json`",
      "call it in-process with injected I/O",
      "- add a dependency.",
      "Report the commit SHA(s), each command's exit code and key output, the coverage rows, every mutation verdict, and the wall time per step.",
    ]) {
      expect(brief, line).toContain(line);
    }
  });

  test("TEMPLATE_F carries the concurrency checklist, at level 3, between the two headings it belongs between", () => {
    // The level is the load-bearing part, and it is 3 for two reasons that happen
    // to agree. The section-order test above collects `/^#{1,2} /` and compares
    // the result to an exact list, so a `##`-level checklist would have to be
    // added there — and a lane navigating by `##` would read a working rule as a
    // peer of `## Verification` rather than as what it is, part of `## Working
    // rules`. So the assertion below pins the level as well as the two sides.
    const CHECKLIST =
      "### Concurrency checklist (locks, signals, async setup/cleanup, shared test state)";
    const brief = render(header);
    expect(brief).toContain(CHECKLIST);
    expect(brief.indexOf(CHECKLIST)).toBeGreaterThan(brief.indexOf("## Working rules"));
    expect(brief.indexOf(CHECKLIST)).toBeLessThan(brief.indexOf("## Verification"));
    expect([...brief.matchAll(/^#{1,2} /gm)].map((match) => match[0])).not.toContain(CHECKLIST);

    // The five items are the five, in order, and each of the three that has a
    // defect behind it still cites it: a checklist that lost a citation would
    // read as a checklist, and the reason a line exists is the part a lane can
    // act on. `(c)` and `(e)` have no citation — a shell `wait` a trap interrupts
    // is a property of the shell, not a defect that shipped.
    //
    // Matched against a whitespace-flattened copy, because the citation is prose
    // and prose wraps: markdown here is outside `format:check`, so a rewrap is a
    // lawful future edit and it must not be able to fail this test on its own.
    const flat = brief.replace(/\s+/g, " ");
    expect([...brief.matchAll(/^- \*\*\(([a-e])\)\*\*/gm)].map((match) => match[1])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    for (const line of [
      "#642 (HXF3) adopted the database before the org-seed `await`.",
      "#641 (MH5) set the release flag before the heartbeat `wait`.",
      "#639 (MH4) had a refused acquire give back a slot no longer its own.",
    ]) {
      expect(flat, line).toContain(line);
    }
  });

  test("the two closing lines are the last two lines of the brief", () => {
    const lines = render(header).split("\n");
    expect(lines.slice(-2)).toEqual([
      "If a finding is wrong, say so with the mechanism rather than changing code to match it.",
      "Run every verification command in the foreground and read its exit code. A task you launched is not a result.",
    ]);
  });

  test("placeholders are filled in ONE pass, so a value that reads like one survives", () => {
    // `render` is a pure function of a header and is deliberately NOT the parser:
    // the parser now refuses a lane outside `[A-Za-z0-9_-]+`, so `L<PLAN>Z` cannot
    // reach it from argv — which is exactly why it is worth calling directly. The
    // guarantee under test is a property of the REPLACER, not of what argv may
    // carry: filled one name at a time, `<LANE>`'s replacement would be scanned
    // for `<PLAN>` and rewritten, and the brief would go out carrying a value
    // nobody typed. One pass never rescans what it substituted.
    const brief = render({ ...header, lane: "L<PLAN>Z" });
    expect(brief).toContain("# Lane L<PLAN>Z — brief");
    expect(brief).toContain("sh scripts/gate-lock.sh run L<PLAN>Z -- yarn mutate …");
    // And a branch whose name reads like the WHOLE match: a string replacer would
    // have expanded `$&` here, which is why the replacer is a function.
    const dollars = render({ ...header, branch: "feat/$&/$`" });
    expect(dollars).toContain("- **Branch:** feat/$&/$`,");
  });

  test("substitute leaves text with no placeholder in it alone", () => {
    const values = {
      LANE: "L",
      PLAN: "P",
      WORKTREE: "W",
      BRANCH: "B",
      TIP: "T",
      ENV: "E",
      VERIFICATION: "V",
    };
    expect(substitute("no names here", values)).toBe("no names here");
    expect(substitute("<gap> <notes> <targeted commands> <commit subject>", values)).toBe(
      "<gap> <notes> <targeted commands> <commit subject>",
    );
  });
});

describe("the verification block", () => {
  test("the two hosts differ in exactly the block under ## Verification", () => {
    const midnight = aroundVerification(render({ ...header, host: "midnight" }));
    const mac = aroundVerification(render({ ...header, host: "mac" }));
    expect(mac.head).toBe(midnight.head);
    expect(mac.tail).toBe(midnight.tail);
    expect(mac.block).not.toBe(midnight.block);
  });

  test("midnight is told not to run the gate, and to run its own commands instead", () => {
    const block = aroundVerification(render(header)).block;
    expect(block).toBe(`\n${VERIFICATION_MIDNIGHT}`);
    expect(block).toContain("**Do NOT run `yarn gate` or `yarn test:cov`**");
    expect(block).toContain("Run, in the FOREGROUND, reading each exit code:");
    expect(block).not.toContain("yarn gate --lane");
  });

  test("mac runs the same targeted commands and then the whole gate", () => {
    const block = aroundVerification(render({ ...header, host: "mac" })).block;
    // The block is the constant's own text with the lane already in it, because
    // `verificationFor` substitutes the id before the single pass runs.
    expect(block).toBe(`\n${VERIFICATION_MAC.replace("<LANE>", "HXF7")}`);
    expect(block).toContain("Then run `yarn gate --lane HXF7` in the FOREGROUND");
    expect(block).not.toContain("Do NOT run `yarn gate`");
  });

  test("no <LANE> survives literally into a written brief, on either host", () => {
    // The lane id is put in the gate-lock command by `verificationFor`, before the
    // single pass runs, because the pass never rescans what it substitutes: left
    // as `<LANE>` inside `<VERIFICATION>`'s own replacement, it would have
    // reached the file as the word.
    for (const host of ["midnight", "mac"] as const) {
      expect(render({ ...header, host })).not.toContain("<LANE>");
    }
    expect(verificationFor("mac", "HXF7")).not.toContain("<LANE>");
    expect(verificationFor("midnight", "HXF7")).toBe(VERIFICATION_MIDNIGHT);
  });

  test("both blocks leave the orchestrator's own placeholder in place", () => {
    // `<targeted commands>` is not one of the seven names this tool fills, so it
    // reaches the file as the word the orchestrator searches for.
    expect(verificationFor("midnight", "HXF7")).toContain("<targeted commands>");
    expect(verificationFor("mac", "HXF7")).toContain("<targeted commands>");
  });
});

describe("the environment block", () => {
  test("with no --env-file it is the single placeholder line", () => {
    const brief = render(header);
    expect(brief).toContain(`Environment, for every shell call:\n\n${ENV_PLACEHOLDER}\n`);
    expect(brief).not.toContain("<ENV>");
  });

  test("--env-file lines are inserted verbatim, each indented into the block", () => {
    const lines = [
      "export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH",
      "export YARN_NM_MODE=classic TMPDIR=/mnt/pool/cloud-services/tmp-cf",
    ];
    const brief = render(header, lines);
    expect(brief).toContain(
      "Environment, for every shell call:\n\n    export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH\n    export YARN_NM_MODE=classic TMPDIR=/mnt/pool/cloud-services/tmp-cf\n",
    );
    expect(brief).not.toContain("<ENV>");
  });

  test("an env line carrying a placeholder name survives it verbatim", () => {
    // The block is DATA, not text to fill: an export that happens to read
    // `<LANE>` is an export that reads `<LANE>`. Substituted here it would become
    // the lane id, and the shell would be told to export a word.
    const brief = render(header, ["export LANE='<LANE>'", "export V='<VERIFICATION>'"]);
    expect(brief).toContain("    export LANE='<LANE>'");
    expect(brief).toContain("    export V='<VERIFICATION>'");
  });

  test("a blank line inside the block stays a blank line, still indented", () => {
    expect(environmentBlock(["a", "", "b"])).toBe("    a\n    \n    b");
  });

  test("CR, NUL and any other control character is refused, naming the line", () => {
    // A CR on every line is what a file written on Windows looks like, and it
    // would land inside the brief's own line endings; a NUL truncates the line
    // for every reader downstream of the write.
    expect(() => envLinesFrom("export A=1\nexport B=2\r\nexport C=3\n")).toThrow(
      /--env-file line 2 carries a control character/,
    );
    expect(() => envLinesFrom("export A=1\nexport B=\u0000\n")).toThrow(
      /--env-file line 2 carries a control character/,
    );
    expect(() => envLinesFrom("export A=1\nexport B=2\u2028")).toThrow(
      /--env-file line 2 carries a control character/,
    );
    // A tab is how `path` and `value` are lined up, so it is the one control
    // character an environment line may carry.
    expect(envLinesFrom("export A=1\n\texport B=2")).toEqual(["export A=1", "\texport B=2"]);
  });

  test("exactly one trailing newline is the file's own terminator, not a line", () => {
    expect(envLinesFrom("export A=1\n")).toEqual(["export A=1"]);
    expect(envLinesFrom("export A=1")).toEqual(["export A=1"]);
    // Two of them are a blank line the caller wrote on purpose, and it survives.
    expect(envLinesFrom("export A=1\n\n")).toEqual(["export A=1", ""]);
  });

  test("an empty --env-file is refused rather than rendering as no block at all", () => {
    // An empty environment block is the one omission a lane cannot notice: it
    // looks like a section that had nothing to say.
    expect(() => envLinesFrom("")).toThrow(/must carry at least one export/);
    expect(() => envLinesFrom("\n")).toThrow(/must carry at least one export/);
    expect(() => envLinesFrom("  \n\t\n")).toThrow(/must carry at least one export/);
  });
});
