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

/** Everything this tool touches: at most one read of a file and one write. */
export interface BriefNewDeps {
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * A refusal: the file this run would be written to already exists. Every reason
 * is listed at once, as in `fix-brief` and `sweep`.
 */
export class BriefNewRefusal extends Error {
  readonly reasons: readonly string[];

  constructor(message: string, reasons: readonly string[]) {
    super(message);
    this.name = "BriefNewRefusal";
    this.reasons = reasons;
  }
}

/**
 * Render the brief and write it.
 *
 * The `--out` check comes first and is the only refusal there is: a brief is the
 * record of what a lane was told, and overwriting one destroys the record of the
 * run that wrote it. It is refused BEFORE the render rather than after, because a
 * brief whose value is already known to be wrong should not be built at all.
 *
 * The existence check and the entry's `wx` write are two separate moments, and
 * anything that creates the file between them is refused by the kernel rather
 * than truncated by this tool. The cost is an EEXIST that this entry's catch
 * reports as exit 1, like any other failed write, with the path in the message.
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
  if (await deps.exists(request.out)) {
    throw new BriefNewRefusal(`refusing to write ${request.out} — it already exists`, [
      `${request.out} exists, so this run would overwrite the brief already on disk; give each lane its own --out`,
    ]);
  }
  await deps.writeFile(request.out, `${render(request, request.envLines)}\n`);
  return {
    out: request.out,
    lane: request.lane,
    host: request.host,
    envLineCount: request.envLines?.length ?? 0,
  };
}
