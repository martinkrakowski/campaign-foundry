import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { errorMessage, projectRoot } from "@campaignfoundry/shared";
import { database, resetDatabase } from "../server/lib/db/database.js";
import { applyGuards } from "../server/lib/import/apply.js";
import { probeTarget } from "../server/lib/import/source.js";
import { existingCounts } from "../server/lib/import/existing-campaigns.js";
import { main as runImportDefault } from "./import.js";

/**
 * The sample-campaign seeder (PT-8g): one command that hydrates
 * `briefs/sample-campaign.yaml` (`summer-hydration-2026`, with
 * `assets/inputs/hydra-logo.png` and `assets/inputs/trail-logo.png`) into an
 * EMPTY postgres + s3 target, by driving `yarn import`'s `plan` -> `apply` ->
 * `verify` in sequence.
 *
 * Preconditions run before any temp dir is written: the backend guards
 * (`applyGuards`), a probe of the org row (`probeTarget`), and the
 * `existingCounts` emptiness check. Then three isolated temp directories hold
 * a copied sample tree (`tempProjectRoot`), the import's output root
 * (`tempOutputRoot`) and the plan/result/verify files (`workDir`) — the plan,
 * result and verify paths are paths only, never pre-created, because `apply`
 * refuses an existing `--result` and `verify --out` opens with `wx`.
 *
 * **Never calls `process.exit`**: the entry guard sets `process.exitCode`
 * from this number, so a caller (and the tests) own the exit.
 */

export const USAGE =
  "usage: yarn seed:sample --org <id> --switched-at <iso> [--project-root <dir>]\n" +
  "Seeds briefs/sample-campaign.yaml into an empty Postgres + S3 target.\n" +
  "--org and --switched-at are required.";

/** The sample tree copied into the temp project root, at its real relative paths. */
const SAMPLE_FILES = [
  "briefs/sample-campaign.yaml",
  "assets/inputs/hydra-logo.png",
  "assets/inputs/trail-logo.png",
] as const;

export interface SeedSampleIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface SeedSampleDeps extends SeedSampleIO {
  /** The import CLI entry, injected so tests can stub `plan`/`apply`/`verify`. */
  readonly runImport?: (argv: readonly string[], io: SeedSampleIO) => Promise<number>;
}

type MutableFlags = {
  projectRoot?: string;
  org?: string;
  switchedAt?: string;
  help: boolean;
};

/** Parse the seeder's flags; a string is the refusal to print before USAGE. */
function parseFlags(argv: readonly string[]): MutableFlags | string {
  const flags: MutableFlags = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help") {
      flags.help = true;
    } else if (arg === "--org" || arg === "--switched-at" || arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return `--${arg.slice(2)} needs a value`;
      }
      flags[arg === "--org" ? "org" : arg === "--switched-at" ? "switchedAt" : "projectRoot"] =
        value;
      i++;
    } else {
      return `unknown flag ${JSON.stringify(arg)}`;
    }
  }
  return flags;
}

/** Copy one sample file from `sourceRoot` into `tempProjectRoot`, naming the failure. */
async function copySample(
  sourceRoot: string,
  tempProjectRoot: string,
  rel: string,
): Promise<string | undefined> {
  const source = join(sourceRoot, rel);
  const target = join(tempProjectRoot, rel);
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } catch (error) {
    return `could not copy the sample file ${JSON.stringify(rel)} from ${JSON.stringify(sourceRoot)}: ${errorMessage(error)}`;
  }
  return undefined;
}

export async function main(argv: readonly string[], deps?: SeedSampleDeps): Promise<number> {
  const io: SeedSampleIO = deps ?? {
    stdout: console.log,
    stderr: console.error,
  };
  const runImport = deps?.runImport ?? runImportDefault;
  const flags = parseFlags(argv);
  if (typeof flags === "string") {
    io.stderr(`${flags}\n${USAGE}`);
    return 2;
  }
  if (flags.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (flags.org === undefined) {
    io.stderr(`seed:sample needs --org <id>\n${USAGE}`);
    return 2;
  }
  if (flags.switchedAt === undefined) {
    io.stderr(`seed:sample needs --switched-at <iso>\n${USAGE}`);
    return 2;
  }
  const sourceRoot = flags.projectRoot ?? projectRoot();

  // Stage 1 — preconditions, before any temp dir write.
  const guard = applyGuards();
  if (guard !== undefined) {
    io.stderr(guard);
    return 1;
  }
  const probe = await probeTarget(flags.org, true);
  if (!probe.ok) {
    io.stderr(probe.reason);
    return 1;
  }
  let counts;
  try {
    counts = await existingCounts(database(), flags.org);
  } finally {
    await database().end();
    resetDatabase();
  }
  if (counts.campaigns > 0 || counts.briefVersions > 0 || counts.reports > 0 || counts.assets > 0) {
    io.stderr(
      `org ${JSON.stringify(flags.org)} is not empty: ` +
        `${counts.campaigns} campaigns, ${counts.briefVersions} brief versions, ` +
        `${counts.reports} reports, ${counts.assets} assets. seed:sample refuses a non-empty target.`,
    );
    return 1;
  }

  // Stage 2 — an isolated temp workspace. The plan/result/verify paths are
  // paths only: never pre-created (apply refuses an existing --result and
  // verify --out opens with wx).
  const tempProjectRoot = await mkdtemp(join(tmpdir(), "cf-seed-project-"));
  const tempOutputRoot = await mkdtemp(join(tmpdir(), "cf-seed-output-"));
  const workDir = await mkdtemp(join(tmpdir(), "cf-seed-work-"));
  const planPath = join(workDir, "plan.json");
  const resultPath = join(workDir, "result.jsonl");
  const verifyPath = join(workDir, "verify.json");
  try {
    for (const rel of SAMPLE_FILES) {
      const problem = await copySample(sourceRoot, tempProjectRoot, rel);
      if (problem !== undefined) {
        io.stderr(problem);
        return 1;
      }
    }

    // Stage 3 — plan -> apply -> verify.
    const subcommandArgs = (subcommand: string, extra: readonly string[]): readonly string[] => [
      subcommand,
      "--project-root",
      tempProjectRoot,
      "--output-root",
      tempOutputRoot,
      "--org",
      flags.org!,
      "--switched-at",
      flags.switchedAt!,
      "--include-samples",
      ...extra,
    ];
    if ((await runImport(subcommandArgs("plan", ["--out", planPath]), io)) !== 0) {
      io.stderr(`seed:sample: the plan run failed; nothing was written to the target.`);
      return 1;
    }
    let plan: { digest?: unknown } | null;
    try {
      plan = JSON.parse(await readFile(planPath, "utf8")) as { digest?: unknown } | null;
    } catch (error) {
      io.stderr(
        `seed:sample: could not read the plan file ${JSON.stringify(planPath)}: ${errorMessage(error)}`,
      );
      return 1;
    }
    const digest = plan?.digest;
    if (typeof digest !== "string" || digest.length === 0) {
      io.stderr(`seed:sample: the plan file has no digest; refusing to apply.`);
      return 1;
    }
    if (
      (await runImport(
        subcommandArgs("apply", ["--expect", digest, "--result", resultPath]),
        io,
      )) !== 0
    ) {
      return 1;
    }
    if (
      (await runImport(subcommandArgs("verify", ["--expect", digest, "--out", verifyPath]), io)) !==
      0
    ) {
      return 1;
    }
    let report: { ok?: unknown } | null;
    try {
      report = JSON.parse(await readFile(verifyPath, "utf8")) as { ok?: unknown } | null;
    } catch (error) {
      io.stderr(
        `seed:sample: could not read the verify report ${JSON.stringify(verifyPath)}: ${errorMessage(error)}`,
      );
      return 1;
    }
    if (report?.ok !== true) {
      io.stderr(`seed:sample: the verify report is not ok; refusing.`);
      return 1;
    }
    io.stdout(
      `seed:sample — org ${JSON.stringify(flags.org)} seeded from briefs/sample-campaign.yaml.`,
    );
    return 0;
  } finally {
    await rm(tempProjectRoot, { recursive: true, force: true });
    await rm(tempOutputRoot, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
