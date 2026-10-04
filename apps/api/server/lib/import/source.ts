import { access, constants, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { errorMessage, projectRoot as processProjectRoot } from "@campaignfoundry/shared";
import { databaseSettings, outputRoot as processOutputRoot, storeBackend } from "../config.js";
import { database } from "../db/database.js";
import { LOCAL_TENANT } from "../tenant.js";
import type { StepContext } from "./steps.js";

/**
 * PT-8a source resolution (D217, D216, D225): where the legacy tree is, which org it
 * was written under, and whether that org is there to be imported into.
 *
 * **Nothing here reads the tree beyond asking the filesystem whether a root is there.**
 * `plan` is read-only (D225), so the only thing this module asks of the database is the
 * one org-row probe — a `select`, never a write.
 */

/** The flags `plan` reads off argv, before any of them is trusted. */
export type SourceFlags = {
  readonly projectRoot?: string;
  readonly outputRoot?: string;
  readonly org?: string;
  readonly switchedAt?: string;
  readonly includeSamples: boolean;
};

/** The two roots `plan` resolved, or which one it could not use. */
type ResolvedRoots =
  | { readonly ok: true; readonly projectRoot: string; readonly outputRoot: string }
  | { readonly ok: false; readonly reason: string };

/** What a run resolves to, once every run-level refusal has been ruled out. */
export type ResolvedSource = {
  readonly ctx: StepContext;
  /**
   * The `--switched-at` string **verbatim**, never the parsed date (req 4): the header
   * exists so a reviewer can check the instant against the deploy log, and a
   * re-serialised `Date` would not be the string that was typed.
   */
  readonly switchedAtIso: string;
  /** Which backend the probe actually read (D225): `fs-only` never opened one. */
  readonly backend: "postgres" | "fs-only";
};

/** A refusal is a RUN-level one: the run stops, prints the reason, and exits 1. */
export type SourceOutcome =
  | { readonly ok: true; readonly source: ResolvedSource }
  | { readonly ok: false; readonly reason: string };

/** The answer to D225's probe: the target exists, or the run refuses before it plans. */
export type ProbeOutcome =
  | { readonly ok: true; readonly backend: "postgres" | "fs-only" }
  | { readonly ok: false; readonly reason: string };

/** Named apart from the un-parseable one so a test can tell which branch refused (req 4). */
export const SWITCHED_AT_REQUIRED = "--switched-at <iso> is required";

/**
 * Whether `yyyy-mm-dd` names a real calendar day. `new Date("2026-02-31T00:00:00Z")` quietly
 * normalises to 3 March, so the plan header (the verbatim flag) and the import context (the
 * parsed Date) would disagree (CodeRabbit on #681). `setUTCFullYear`, not `Date.UTC`, which
 * remaps years 0000–0099.
 */
function isCalendarDate(datePart: string): boolean {
  const day = new Date(0);
  day.setUTCFullYear(
    Number(datePart.slice(0, 4)),
    Number(datePart.slice(5, 7)) - 1,
    Number(datePart.slice(8, 10)),
  );
  return day.toISOString().slice(0, 10) === datePart;
}

/** An ISO 8601 date-time that carries its own offset: `Z` or `±hh:mm`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The org a root was written under — the inverse of `tenantRoot`
 * (`run-environment.ts:121`).
 *
 * **`tenantRoot` puts a non-local org's roots at `<root>/orgs/<orgId>` and leaves the
 * local operator's at the process root**, so the inverse is the tail of the resolved
 * path, read with no base root at all: that is what makes it work for a root supplied
 * by `--project-root` from outside this checkout. The id it hands back was already a
 * `SAFE_ID_PATTERN` segment for `tenantRoot` to have produced it, so nothing re-checks it.
 */
export function deriveOrgId(root: string): string {
  const parts = resolve(root).split(sep);
  return parts.at(-2) === "orgs" ? parts.at(-1)! : LOCAL_TENANT.orgId;
}

/** A root that is absent, unreadable, or not a directory (req 1). */
async function rootProblem(path: string, flag: string): Promise<string | undefined> {
  try {
    if (!(await stat(path)).isDirectory()) {
      return `${flag} ${JSON.stringify(path)} is not a directory.`;
    }
    await access(path, constants.R_OK);
    return undefined;
  } catch (error) {
    return `${flag} ${JSON.stringify(path)} is not usable: ${errorMessage(error)}`;
  }
}

/**
 * Both roots, defaulting exactly as the app resolves them (D217): `projectRoot()` /
 * `outputRoot()` — the same `config.ts` calls, so the CLI and the server agree on where
 * "the project" is without the importer restating either rule.
 */
async function resolveRoots(flags: SourceFlags): Promise<ResolvedRoots> {
  const project = flags.projectRoot ?? processProjectRoot();
  const output = flags.outputRoot ?? processOutputRoot();
  for (const [flag, path] of [
    ["--project-root", project],
    ["--output-root", output],
  ] as const) {
    const problem = await rootProblem(path, flag);
    if (problem !== undefined) return { ok: false, reason: problem };
  }
  return { ok: true, projectRoot: resolve(project), outputRoot: resolve(output) };
}

/**
 * D225's read-only target probe: **the org row exists, and that is all it checks.**
 *
 * It issues one `select`, so a run that reaches `apply` with a target that moved since
 * the plan still finds that out here rather than mid-write. `fs-only` reaches the
 * database NOT AT ALL — `database()` is never called on that branch, which is what the
 * zero-query assertion in the test proves — because there is no row behind a file store
 * to confirm, and an `--org` override has nothing to check against (req 3).
 */
export async function probeTarget(orgId: string, overridden: boolean): Promise<ProbeOutcome> {
  if (storeBackend() !== "postgres") {
    if (overridden) {
      return {
        ok: false,
        reason:
          `--org ${JSON.stringify(orgId)} needs STORE_BACKEND=postgres: the file stores ` +
          "have no org row to check it against.",
      };
    }
    return { ok: true, backend: "fs-only" };
  }
  // Read on THIS branch only, which is what makes "explicit, never inferred from
  // DATABASE_URL's presence" (`config.ts:36-40`) the whole of the fs-only condition.
  const { url } = databaseSettings();
  if (url === undefined) {
    return {
      ok: false,
      reason: `no database is configured to probe org ${JSON.stringify(orgId)}: DATABASE_URL is not set.`,
    };
  }
  const { rows } = await database().query<{ id: string }>("select id from org where id = $1", [
    orgId,
  ]);
  if (rows.length === 0) {
    return { ok: false, reason: `no org ${JSON.stringify(orgId)} exists in the target database.` };
  }
  return { ok: true, backend: "postgres" };
}

/**
 * Every run-level source refusal, in the order they are asked, and the context the rest
 * of the run takes.
 *
 * **`--switched-at` is asked FIRST, before the roots and before the database**, because
 * it is the one flag a run cannot proceed without and the one whose two refusals have to
 * stay distinguishable (req 4): absent and un-parseable are different mistakes with
 * different fixes, so they carry different messages rather than one message and a code.
 */
export async function resolveSource(flags: SourceFlags): Promise<SourceOutcome> {
  if (flags.switchedAt === undefined) {
    return { ok: false, reason: SWITCHED_AT_REQUIRED };
  }
  // An INSTANT, so a timezone is required (Qodo on #681): `new Date("2026-10-01T00:00:00")`
  // reads as local time, so the same flag would name different instants on different hosts
  // while the plan echoed one verbatim value.
  const when = new Date(flags.switchedAt);
  if (
    !ISO_INSTANT.test(flags.switchedAt) ||
    Number.isNaN(when.getTime()) ||
    !isCalendarDate(flags.switchedAt.slice(0, 10))
  ) {
    return {
      ok: false,
      reason: `--switched-at <iso> is not a valid date: ${JSON.stringify(flags.switchedAt)}`,
    };
  }
  const roots = await resolveRoots(flags);
  if (!roots.ok) return roots;
  const orgId = flags.org ?? deriveOrgId(roots.projectRoot);
  const probe = await probeTarget(orgId, flags.org !== undefined);
  if (!probe.ok) return probe;
  const switchedAtIso = flags.switchedAt;
  return {
    ok: true,
    source: {
      switchedAtIso,
      backend: probe.backend,
      ctx: {
        orgId,
        switchedAt: when,
        projectRoot: roots.projectRoot,
        outputRoot: roots.outputRoot,
        includeSamples: flags.includeSamples,
        fsOnly: probe.backend === "fs-only",
      },
    },
  };
}
