import { pathToFileURL } from "node:url";
import { resolveSource, type SourceFlags } from "../server/lib/import/source.js";
import { scanBriefs } from "../server/lib/import/scan.js";

/**
 * The PT-8 data-migration CLI (D217, D225).
 *
 *   yarn import plan [--project-root <dir>] [--output-root <dir>] [--org <id>]
 *                    --switched-at <iso> [--include-samples]
 *
 * **`plan` is read-only and is the only subcommand that does anything yet.** It resolves
 * the source, probes the target read-only, and prints what the tree holds: every campaign
 * found with its refs classified, every refusal with the reason it was refused, and the
 * sample count Q2 asks for. It writes NOTHING — no row, no object, no file under
 * `briefs/`, `assets/` or `<output>/`. Its own stdout is the only write in the lane.
 *
 * `apply` and `verify` exist as refusals so the CLI shape is settled before the code
 * behind it is (D225 puts the digest, `--expect` and the quiet target on `apply`), and
 * PT-8a2 extends this same file rather than adding a second entry point.
 */
export const USAGE =
  "usage: yarn import plan --switched-at <iso> [--project-root <dir>] [--output-root <dir>]" +
  " [--org <id>] [--include-samples]";

/** A refused subcommand's exact stderr, so a caller can key on it (req 4's habit). */
const NOT_YET_IMPLEMENTED = "not yet implemented";

export interface ImportIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** argv's flags, as {@link resolveSource} takes them. An unknown flag refuses the run. */
function parseFlags(argv: readonly string[]): SourceFlags | string {
  let flags: {
    projectRoot?: string;
    outputRoot?: string;
    org?: string;
    switchedAt?: string;
    includeSamples: boolean;
  } = { includeSamples: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--include-samples") {
      flags = { ...flags, includeSamples: true };
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) return `${flag} needs a value.`;
    i++;
    if (flag === "--project-root") flags = { ...flags, projectRoot: value };
    else if (flag === "--output-root") flags = { ...flags, outputRoot: value };
    else if (flag === "--org") flags = { ...flags, org: value };
    else if (flag === "--switched-at") flags = { ...flags, switchedAt: value };
    else return `${flag} is not a flag this command takes.`;
  }
  return flags;
}

/**
 * `plan`: source resolution, the read-only target probe, discovery, and the printed plan.
 *
 * **A refusal here is a RUN-level one and exits 1; per-campaign refusals do not** (the
 * row's item 9): a brief the parser refuses is a fact about the tree, and the reviewer
 * still needs the plan for everything else. Only a source this run cannot read is a
 * failure to have run at all.
 */
async function plan(argv: readonly string[], io: ImportIO): Promise<number> {
  const flags = parseFlags(argv);
  if (typeof flags === "string") {
    io.stderr(flags);
    return 1;
  }
  const outcome = await resolveSource(flags);
  if (!outcome.ok) {
    io.stderr(outcome.reason);
    return 1;
  }
  const { ctx, backend, switchedAtIso } = outcome.source;
  const result = await scanBriefs(ctx);
  io.stdout(`import plan — switched-at: ${switchedAtIso}`);
  io.stdout(`org: ${ctx.orgId}`);
  io.stdout(`backend: ${backend}`);
  io.stdout(
    JSON.stringify({
      switchedAt: switchedAtIso,
      orgId: ctx.orgId,
      backend,
      campaigns: result.campaigns,
      refusals: result.refusals,
      samples: result.samples,
    }),
  );
  return 0;
}

/**
 * `yarn import <subcommand> …` — `0` on success, `1` for every run-level refusal.
 *
 * **Never calls `process.exit`**: the entry guard sets `process.exitCode` from this
 * number instead, so a caller (and the tests) own the exit and `main` stays a plain
 * `number`-returning function.
 */
export async function main(
  argv: readonly string[],
  deps: ImportIO = { stdout: console.log, stderr: console.error },
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand !== "plan") {
    if (subcommand === "apply" || subcommand === "verify") {
      deps.stderr(`${subcommand}: ${NOT_YET_IMPLEMENTED}`);
      return 1;
    }
    deps.stderr(USAGE);
    return 1;
  }
  return plan(rest, deps);
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
