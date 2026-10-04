import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { USAGE, main } from "../import.js";
import {
  dropRoot,
  makeRoot,
  writeAt,
  writeBrief,
  PNG,
} from "../../server/lib/import/__tests__/fixtures/tree.js";

/**
 * The PT-8a CLI entry: `plan` runs and prints, and everything else refuses.
 *
 * **`main` is called in process with its I/O injected, never spawned** — so the tests own
 * what the CLI would have written and `main` stays the `Promise<number>` PT-8a2 keeps. It
 * never calls `process.exit`; the entry guard sets `process.exitCode` from the number this
 * returns, which is why a refusal is a return value here rather than an exit.
 *
 * The exit code IS the taxonomy: `1` for every RUN-level refusal (an unreadable source, a
 * bad `--org`, a missing or un-parseable `--switched-at`, an unknown subcommand, and the
 * two stubs), and `0` for a plan that carries per-campaign refusals — because a brief the
 * parser refuses is a fact about the tree, not a failure to have run.
 */

const SWITCHED_AT = "2026-10-01T00:00:00Z";

function io(): {
  out: string[];
  err: string[];
  deps: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) } };
}

describe("import CLI (PT-8a)", () => {
  let root: string | undefined;
  let output: string | undefined;

  beforeEach(() => {
    root = makeRoot();
    output = join(root, "output");
    mkdirSync(output, { recursive: true });
    mkdirSync(join(root, "briefs"), { recursive: true });
    writeAt(root, "assets/inputs/logo.png", PNG);
    writeBrief(root, "camp-one.yaml", {
      id: "camp-one",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
      ],
    });
  });

  afterEach(() => {
    dropRoot(root);
    root = undefined;
    output = undefined;
  });

  /** `plan` against this suite's temp tree, with any flags added or replaced. */
  function planArgv(...extra: readonly string[]): string[] {
    return [
      "plan",
      "--project-root",
      root!,
      "--output-root",
      output!,
      "--switched-at",
      SWITCHED_AT,
      ...extra,
    ];
  }

  test("plan prints the header and the plan, and exits 0", async () => {
    const { out, err, deps } = io();

    expect(await main(planArgv(), deps)).toBe(0);
    expect(err).toEqual([]);
    // The header is what a reviewer checks by hand: the cutover instant VERBATIM, the org
    // the tree was written under, and which backend answered.
    expect(out[0]).toBe(`import plan — switched-at: ${SWITCHED_AT}`);
    expect(out[1]).toBe("org: local");
    expect(out[2]).toBe("backend: fs-only");

    const plan = JSON.parse(out[3]!) as {
      switchedAt: string;
      orgId: string;
      backend: string;
      campaigns: { slug: string; refs: { kind: string }[] }[];
      refusals: unknown[];
      samples: { skipped: number; imported: number };
    };
    // The same string, echoed: `--switched-at` is not re-serialised on the way out.
    expect(plan.switchedAt).toBe(SWITCHED_AT);
    expect(plan.orgId).toBe("local");
    expect(plan.backend).toBe("fs-only");
    expect(plan.campaigns.map((one) => one.slug)).toEqual(["camp-one"]);
    expect(plan.campaigns[0]!.refs).toEqual([
      { ref: "assets/inputs/logo.png", kind: "root-level" },
    ]);
    expect(plan.refusals).toEqual([]);
    expect(plan.samples).toEqual({ skipped: 0, imported: 0 });
  });

  test("plan exits 0 even when the tree holds refusals", async () => {
    const { out, deps } = io();
    writeBrief(root!, "sample-demo.yaml", {
      id: "sample-demo",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
      ],
    });

    expect(await main(planArgv(), deps)).toBe(0);
    const plan = JSON.parse(out[3]!) as { samples: { skipped: number } };
    expect(plan.samples.skipped).toBe(1);
  });

  test("--include-samples is read by plan", async () => {
    const { out, deps } = io();
    writeBrief(root!, "sample-demo.yaml", {
      id: "sample-demo",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
      ],
    });

    expect(await main(planArgv("--include-samples"), deps)).toBe(0);
    const plan = JSON.parse(out[3]!) as { campaigns: { slug: string }[]; samples: unknown };
    expect(plan.campaigns.map((one) => one.slug).sort()).toEqual(["camp-one", "sample-demo"]);
    expect(plan.samples).toEqual({ skipped: 0, imported: 1 });
  });

  test("a MISSING --switched-at refuses with its exact message and exits 1", async () => {
    const { out, err, deps } = io();

    expect(await main(["plan", "--project-root", root!, "--output-root", output!], deps)).toBe(1);
    expect(err).toEqual(["--switched-at <iso> is required"]);
    expect(out).toEqual([]);
  });

  test("an UN-PARSEABLE --switched-at refuses with its own message and exits 1", async () => {
    const { err, deps } = io();

    expect(
      await main(
        ["plan", "--project-root", root!, "--output-root", output!, "--switched-at", "soon"],
        deps,
      ),
    ).toBe(1);
    expect(err).toEqual(['--switched-at <iso> is not a valid date: "soon"']);
  });

  test("an UNREADABLE root refuses naming the path and exits 1", async () => {
    const { err, deps } = io();
    const missing = join(root!, "no-such-dir");

    expect(
      await main(
        ["plan", "--project-root", missing, "--output-root", output!, "--switched-at", SWITCHED_AT],
        deps,
      ),
    ).toBe(1);
    expect(err[0]).toContain(`--project-root ${JSON.stringify(missing)}`);
  });

  test("an --org on the FILE STORES refuses naming the id, and exits 1", async () => {
    const { err, deps } = io();

    expect(await main(planArgv("--org", "local"), deps)).toBe(1);
    expect(err).toEqual([
      '--org "local" needs STORE_BACKEND=postgres: the file stores have no org row to ' +
        "check it against.",
    ]);
  });

  test("a flag with no value, and a flag this command does not take, both refuse", async () => {
    for (const [argv, reason] of [
      [["plan", "--org"], "--org needs a value."],
      [["plan", "--bogus", "x"], "--bogus is not a flag this command takes."],
    ] as const) {
      const { err, deps } = io();
      expect(await main(argv, deps)).toBe(1);
      expect(err).toEqual([reason]);
    }
  });

  test("an UNKNOWN or MISSING subcommand is the usage, and exits 1", async () => {
    // `apply` and `verify` are NOT here: they are known subcommands that refuse with
    // `not yet implemented`, which is a different refusal from "there is no such command".
    for (const argv of [[], ["inspect"], ["--help"], ["--switched-at", SWITCHED_AT]]) {
      const { err, deps } = io();
      expect(await main(argv, deps)).toBe(1);
      expect(err).toEqual([USAGE]);
    }
  });

  test("apply and verify refuse as not-yet-implemented, and exit 1", async () => {
    for (const subcommand of ["apply", "verify"]) {
      const { err, deps } = io();
      expect(await main([subcommand], deps)).toBe(1);
      expect(err).toEqual([`${subcommand}: not yet implemented`]);
    }
  });

  test("without injected IO the output goes to the process's own streams", async () => {
    // The defaults are a real code path: `yarn import` spawns this CLI with no deps, so
    // the arrows behind the default parameter have to work, not just typecheck.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main(["apply"])).toBe(1);
      expect(await main(["inspect"])).toBe(1);
      expect(await main(planArgv())).toBe(0);
      expect(error).toHaveBeenNthCalledWith(1, "apply: not yet implemented");
      expect(error).toHaveBeenNthCalledWith(2, USAGE);
      expect(log).toHaveBeenCalledWith(`import plan — switched-at: ${SWITCHED_AT}`);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
