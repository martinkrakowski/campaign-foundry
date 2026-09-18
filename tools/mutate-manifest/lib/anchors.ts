import { countOccurrences } from "../../mutate/lib/mutate.js";
import { ManifestError, parseManifest } from "./manifest.js";
import type { ManifestMutation } from "./types.js";

export const EXIT_LIVE = 0;
export const EXIT_DEAD = 1;

/**
 * A mutation's `before` text is an ADDRESS, and addresses rot.
 *
 * `runMutation` refuses before-text that does not appear exactly once (Rule 2),
 * and `verify-manifests.sh` replays only the manifests a diff touches. Put
 * those together and a lane that reformats one source file silently kills
 * anchors in manifests nobody will look at — not merely unchecked, but
 * *unrunnable*, because the refusal is permanent and a manifest replays whole.
 * The claim stops being enforced and nothing anywhere says so.
 *
 * The replay is expensive: it applies a mutation and runs a real suite. This is
 * the cheap half — for EVERY manifest, does each live `before` still appear
 * exactly once in its `file`? It is a string count. No build, no tests, no
 * spawn. That is what makes it affordable to run over all of them every time,
 * which is the only way a stale anchor in an untouched manifest is ever seen.
 */
export type AnchorFault =
  | { readonly kind: "unreadable"; readonly manifest: string; readonly detail: string }
  | { readonly kind: "malformed"; readonly manifest: string; readonly detail: string }
  | {
      readonly kind: "missing-file";
      readonly manifest: string;
      readonly index: number;
      readonly mutation: ManifestMutation;
      readonly detail: string;
    }
  | {
      readonly kind: "not-exactly-once";
      readonly manifest: string;
      readonly index: number;
      readonly mutation: ManifestMutation;
      readonly occurrences: number;
    };

export interface AnchorReport {
  readonly manifests: number;
  readonly mutations: number;
  readonly retired: number;
  readonly faults: readonly AnchorFault[];
}

export interface AnchorDeps {
  /** Reads a manifest or a source file. Rejects if it is not there. */
  readonly readText: (path: string) => Promise<string>;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Checks every anchor in every manifest it is given.
 *
 * Source files are read once and cached: nine manifests anchor into
 * `BriefEditor.tsx`, and re-reading it nine times is the difference between a
 * check that runs on every push and one somebody switches off.
 *
 * A manifest that cannot be read or parsed is a FAULT, never a skip. An
 * unexplained retirement (`"retired": true`, or an empty reason) is refused by
 * `parseManifest`, so it arrives here as `malformed` and fails the check — if
 * this swallowed parse errors, the one guard keeping retirement honest would be
 * unreachable from the gate that is supposed to enforce it.
 */
export async function checkAnchors(
  manifestPaths: readonly string[],
  deps: AnchorDeps,
): Promise<AnchorReport> {
  const faults: AnchorFault[] = [];
  const sources = new Map<string, string | Error>();
  let mutations = 0;
  let retired = 0;

  for (const manifest of manifestPaths) {
    let text: string;
    try {
      text = await deps.readText(manifest);
    } catch (error) {
      faults.push({ kind: "unreadable", manifest, detail: message(error) });
      continue;
    }
    let parsed;
    try {
      parsed = parseManifest(text);
    } catch (error) {
      /* istanbul ignore next -- parseManifest throws only ManifestError. The guard is here so an
         unexpected failure surfaces as itself rather than as a bad manifest. */
      if (!(error instanceof ManifestError)) throw error;
      faults.push({ kind: "malformed", manifest, detail: error.message });
      continue;
    }

    for (const [index, mutation] of parsed.mutations.entries()) {
      mutations++;
      if (mutation.retired !== undefined) {
        // Retired: the subject is gone by admission, so there is nothing to
        // find and its absence is not news.
        retired++;
        continue;
      }
      let source = sources.get(mutation.file);
      if (source === undefined) {
        source = await deps
          .readText(mutation.file)
          .catch((error: unknown) => (error instanceof Error ? error : new Error(message(error))));
        sources.set(mutation.file, source);
      }
      if (source instanceof Error) {
        faults.push({
          kind: "missing-file",
          manifest,
          index,
          mutation,
          detail: source.message,
        });
        continue;
      }
      const occurrences = countOccurrences(source, mutation.before);
      if (occurrences !== 1) {
        faults.push({ kind: "not-exactly-once", manifest, index, mutation, occurrences });
      }
    }
  }

  return { manifests: manifestPaths.length, mutations, retired, faults };
}

const FAULT_HEADLINE: Record<AnchorFault["kind"], string> = {
  unreadable: "UNREADABLE MANIFEST",
  malformed: "MALFORMED MANIFEST",
  "missing-file": "FILE GONE",
  "not-exactly-once": "DEAD ANCHOR",
};

export function formatAnchorReport(report: AnchorReport): string {
  const lines: string[] = [];
  for (const fault of report.faults) {
    if (fault.kind === "unreadable" || fault.kind === "malformed") {
      lines.push(`${FAULT_HEADLINE[fault.kind]}  ${fault.manifest}`, `  ${fault.detail}`);
      continue;
    }
    // The index is 0-based, which is how this repo's planning docs and lane
    // reports already cite a mutation (`cc1#3`, `sg1#0`).
    lines.push(
      `${FAULT_HEADLINE[fault.kind]}  ${fault.manifest}#${fault.index}`,
      `  file: ${fault.mutation.file}`,
      fault.kind === "missing-file"
        ? `  ${fault.detail}`
        : `  before-text appears ${fault.occurrences} time(s); Rule 2 needs exactly 1, so this` +
            ` mutation can never replay again`,
      `  because: ${fault.mutation.because}`,
    );
  }
  const live = report.mutations - report.retired;
  const scanned =
    `${report.manifests} manifest(s), ${report.mutations} mutation(s): ` +
    `${live} live, ${report.retired} retired.`;
  lines.push(
    report.faults.length === 0
      ? `anchors: ${scanned} Every live anchor resolves exactly once.`
      : `anchors: ${scanned} ${report.faults.length} fault(s) — see above. A mutation whose ` +
          `anchor does not resolve is a claim nobody is checking: re-anchor it if the code moved, ` +
          `retire it with a reason if the code is gone.`,
  );
  return lines.join("\n");
}

export function anchorExitCode(report: AnchorReport): number {
  return report.faults.length === 0 ? EXIT_LIVE : EXIT_DEAD;
}
