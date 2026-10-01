import { dirname } from "node:path";
import type { BriefNewArgs, Host } from "./args.js";
import { render } from "./template.js";

/**
 * What one draft wrote: the path it took, and enough of the request to print
 * which lane and which host it was written for — the two things a person
 * reading a log line needs to know before they open it.
 */
export interface BriefNewOutcome {
  readonly out: string;
  readonly lane: string;
  readonly host: Host;
  readonly envLineCount: number;
}

/**
 * The request as the draft reads it: the parsed command line, plus `--env-file`'s
 * lines once the entry has read and checked them. Absent means no `--env-file`.
 */
export interface BriefNewRequest extends BriefNewArgs {
  readonly envLines?: readonly string[];
}

/**
 * Everything this tool touches: one directory and one file.
 *
 * `mkdir` is injected for the same reason `writeFile` is, so a test can see the
 * directory this run created without one existing — the whole of item 1 is a
 * write into a directory that may not be there yet.
 */
export interface BriefNewDeps {
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
}

/**
 * Create the brief's parent directory, then render the brief and write it.
 *
 * **The directory is created, not assumed.** The documented target is
 * `.agents/briefs/<LANE>.md` and `.agents/briefs/` is gitignored, so on a fresh
 * checkout it does not exist: `writeFile` with `wx` then fails with ENOENT on a
 * path the caller spelled correctly and that the tool advertised. `dirname` of a
 * bare filename is `.`, and `mkdir` with `recursive` accepts a directory that is
 * already there, so there is no case to special-case and no branch to test
 * around.
 *
 * The existence of the FILE is not decided here. It is part of the command line —
 * an `--out` that is already there is a command line this run cannot act on — and
 * the entry decides it in its pre-flight, before this function is called. What is
 * left as the guard here is the entry's `wx` write: the pre-flight check and that
 * write are two separate moments, and anything that creates the file between them
 * is refused by the kernel rather than truncated by this tool. The cost is an
 * EEXIST that this entry's catch reports as exit 1, like any other failed write,
 * with the path in the message.
 *
 * The newline is added HERE and not in `render`, so `render` still returns
 * Template F's text byte for byte — which is what the drift test compares against
 * the doc — while the file a lane reads ends with one, as every other text file
 * in a repository does.
 */
export async function draftBriefNew(
  request: BriefNewRequest,
  deps: BriefNewDeps,
): Promise<BriefNewOutcome> {
  await deps.mkdir(dirname(request.out));
  await deps.writeFile(request.out, `${render(request, request.envLines)}\n`);
  return {
    out: request.out,
    lane: request.lane,
    host: request.host,
    envLineCount: request.envLines?.length ?? 0,
  };
}
