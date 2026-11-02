import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as scanModule from "../../server/lib/import/scan.js";
import { database, resetDatabase, setDatabase } from "../../server/lib/db/database.js";
import type { SqlClient } from "../../server/lib/db/sql-client.js";
import { USAGE, VERIFY_USAGE, main } from "../import.js";
import type { CampaignEntry } from "../../server/lib/import/apply.js";
import { importTenant } from "../../server/lib/import/import-tenant.js";
import { setObjectStoreClient } from "../../server/lib/object-store/index.js";
import {
  getAssetStore,
  getReportStore,
  setAssetStore,
  setReportStore,
} from "../../server/lib/ports/index.js";
import {
  failOnNth,
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "../../server/lib/import/__tests__/fixtures/apply-harness.js";
import {
  briefBody,
  dropRoot,
  makeRoot,
  writeAt,
  writeBrief,
  writeHtmlLayerBrief,
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
 * bad `--org`, a missing or un-parseable `--switched-at`, an unknown subcommand, and
 * `verify`'s guards/refusals), and `0` for a plan that carries per-campaign refusals — because
 * a brief the parser refuses is a fact about the tree, not a failure to have run.
 */

const SWITCHED_AT = "2026-10-01T00:00:00Z";
const SAVED_STORE_BACKEND = process.env["STORE_BACKEND"];

/** The fs-only backend, set EXPLICITLY (the `auth-boot-guard.test.ts` convention). */
function useFileStores(): void {
  process.env["STORE_BACKEND"] = "fs";
}

function restoreEnv(): void {
  if (SAVED_STORE_BACKEND === undefined) delete process.env["STORE_BACKEND"];
  else process.env["STORE_BACKEND"] = SAVED_STORE_BACKEND;
}

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
    // Every test here except the `--org` refusal and the bad-value one wants the file
    // stores, and an operator's `.env.local` saying `STORE_BACKEND=postgres` would flip
    // all of them: `loadEnv` never overrides a var already in `process.env`, so naming it
    // here is what makes this suite mean the same thing on every machine.
    useFileStores();
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
    restoreEnv();
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

    // A REAL per-campaign refusal too, not just a skipped sample: a ref to a file that
    // does not exist (CodeRabbit on #681). Refusals are content of the plan, not its exit.
    writeBrief(root!, "camp-broken.yaml", {
      id: "camp-broken",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/gone.png" },
      ],
    });

    expect(await main(planArgv(), deps)).toBe(0);
    const plan = JSON.parse(out[3]!) as {
      samples: { skipped: number };
      refusals: readonly { slug: string | null }[];
    };
    expect(plan.samples.skipped).toBe(1);
    expect(plan.refusals).toEqual([expect.objectContaining({ slug: "camp-broken" })]);
  });

  test("plan lists the unreferenced own inputs, counts them in the census, and leaves the digest alone", async () => {
    type Printed = {
      unreferencedInputs: readonly { slug: string; count: number; names: readonly string[] }[];
      census: { unreferencedInputs: { count: number; names?: readonly string[] } };
      digest: string;
    };
    const first = io();
    expect(await main(planArgv(), first.deps)).toBe(0);
    const before = JSON.parse(first.out[3]!) as Printed;
    expect(before.unreferencedInputs).toEqual([]);
    expect(before.census.unreferencedInputs).toEqual({ count: 0 });

    writeAt(root!, "assets/inputs/camp-one/spare.png", PNG);
    writeAt(root!, "assets/inputs/camp-one/another.png", PNG);
    const second = io();
    expect(await main(planArgv(), second.deps)).toBe(0);
    const after = JSON.parse(second.out[3]!) as Printed;

    expect(after.unreferencedInputs).toEqual([
      { slug: "camp-one", count: 2, names: ["another.png", "spare.png"] },
    ]);
    expect(after.census.unreferencedInputs).toEqual({
      count: 2,
      names: ["camp-one/another.png", "camp-one/spare.png"],
    });
    // The owner's decision: the digest is NOT changed by an unreferenced file. It was
    // true before this lane (the digest hashes only briefs, sidecars and CLEAN refs),
    // and this holds it so.
    expect(after.digest).toBe(before.digest);
    expect(second.out[4]).toBe(first.out[4]);
    // `plan` is read-only: the spare files are still there.
    expect(existsSync(join(root!, "assets/inputs/camp-one/spare.png"))).toBe(true);
  });

  test("plan lists a uuid-shaped slug as refused, not as importable", async () => {
    const { out, deps } = io();
    const uuid = "11111111-1111-1111-1111-111111111111";
    writeBrief(root!, `${uuid}.yaml`, {
      id: uuid,
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
      ],
    });

    expect(await main(planArgv(), deps)).toBe(0);
    const plan = JSON.parse(out[3]!) as {
      campaigns: readonly { slug: string }[];
      refusals: readonly { slug: string | null; reason: string }[];
    };
    expect(plan.campaigns.map((one) => one.slug)).toEqual(["camp-one"]);
    expect(plan.refusals).toEqual([
      expect.objectContaining({ slug: uuid, reason: `a uuid-shaped slug is refused: ${uuid}` }),
    ]);
    expect(out[4]).toMatch(/^1 importable, 1 refused, digest /);
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

  /**
   * Fable fix round 1, FIX 2b: `plan` never rejects, whatever the run throws.
   *
   * The entry guard is `main(...).then(code => { process.exitCode = code })` — there is no
   * rejection handler, and the brief fixes it verbatim — so a rejection out of `plan`
   * became an unhandled rejection and an abort with no plan and no message. This test
   * stands in for every throw the CLI cannot rule out internally, `storeBackend()` refusing
   * a bad `STORE_BACKEND` among them.
   */
  test("FIX 2b: a THROW inside plan is a run-level refusal, not a rejected promise", async () => {
    const boom = new Error("the tree is on fire");
    const scan = vi.spyOn(scanModule, "scanBriefs").mockRejectedValue(boom);
    const { out, err, deps } = io();
    try {
      expect(await main(planArgv(), deps)).toBe(1);
      expect(err).toEqual(["the tree is on fire"]);
      // Nothing half-printed: a run that failed to plan must not leave a plan-shaped
      // header on stdout for an operator to mistake for the plan.
      expect(out).toEqual([]);
    } finally {
      scan.mockRestore();
    }
  });

  test("FIX 2b: a bad STORE_BACKEND value refuses instead of rejecting", async () => {
    const saved = process.env["STORE_BACKEND"];
    process.env["STORE_BACKEND"] = "postgres-ish";
    const { err, deps } = io();
    try {
      expect(await main(planArgv(), deps)).toBe(1);
      expect(err[0]).toContain("STORE_BACKEND must be");
    } finally {
      if (saved === undefined) delete process.env["STORE_BACKEND"];
      else process.env["STORE_BACKEND"] = saved;
    }
  });

  test("a flag with no value, and a flag this command does not take, both refuse", async () => {
    for (const [argv, reason] of [
      [["plan", "--org"], "--org needs a value."],
      [["plan", "--org", "--switched-at", "2026-10-01T00:00:00Z"], "--org needs a value."],
      [["plan", "--bogus", "x"], "--bogus is not a flag this command takes."],
    ] as const) {
      const { err, deps } = io();
      expect(await main(argv, deps)).toBe(1);
      expect(err).toEqual([reason]);
    }
  });

  test("an UNKNOWN or MISSING subcommand is the usage, and exits 1", async () => {
    // `apply` and `verify` are NOT here: they are known subcommands with their own
    // refusals, which is a different refusal from "there is no such command".
    for (const argv of [[], ["inspect"], ["--help"], ["--switched-at", SWITCHED_AT]]) {
      const { err, deps } = io();
      expect(await main(argv, deps)).toBe(1);
      expect(err).toEqual([USAGE]);
    }
  });

  test("verify --help prints the usage and exits 0", async () => {
    const { out, err, deps } = io();
    expect(await main(["verify", "--help"], deps)).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("usage: yarn import verify --switched-at <iso>");
    expect(out.join("\n")).toContain("0  every planned and org-wide check matched");
    expect(out.join("\n")).toContain(
      "1  at least one check mismatched, or the run itself was refused",
    );
  });

  test("verify on the file stores refuses and exits 1", async () => {
    const { out, err, deps } = io();
    expect(
      await main(
        ["verify", "--project-root", root!, "--output-root", output!, "--switched-at", SWITCHED_AT],
        deps,
      ),
    ).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["verify needs STORE_BACKEND=postgres, and STORE_BACKEND is fs"]);
  });

  test("an unparseable DATABASE_URL does not break verify's refusal", async () => {
    const saved = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = "::not-a-url";
    const { out, err, deps } = io();
    try {
      expect(await main(["verify", "--project-root", root!, "--output-root", output!], deps)).toBe(
        1,
      );
      expect(err).toEqual(["verify needs STORE_BACKEND=postgres, and STORE_BACKEND is fs"]);
      expect(out).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = saved;
    }
  });

  test("apply --help prints a usage holding the three exit-code lines", async () => {
    const { out, err, deps } = io();
    expect(await main(["apply", "--help"], deps)).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain("0  nothing was refused and nothing is partial");
    expect(text).toContain(
      "1  at least one campaign is partial (a write of it failed, or one of its report, pool or decision rows was refused, or one of its renders is missing, was refused or failed), or the run itself failed, or the run wrote something and refused at least one campaign",
    );
    expect(text).toContain(
      "3  the run wrote nothing: at least one campaign was refused before any write, none was created or completed, no row was written, no render was created, nothing is partial",
    );
  });

  test("without injected IO the output goes to the process's own streams", async () => {
    // The defaults are a real code path: `yarn import` spawns this CLI with no deps, so
    // the arrows behind the default parameter have to work, not just typecheck.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main(["verify"])).toBe(1);
      expect(await main(["inspect"])).toBe(1);
      expect(await main(planArgv())).toBe(0);
      expect(error).toHaveBeenNthCalledWith(
        1,
        "verify needs STORE_BACKEND=postgres, and STORE_BACKEND is fs",
      );
      expect(error).toHaveBeenNthCalledWith(2, USAGE);
      expect(log).toHaveBeenCalledWith(`import plan — switched-at: ${SWITCHED_AT}`);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

/**
 * PT-8a2: the `--out` plan file, the TWO exit classes, and the pool `plan` opened.
 *
 * **There are two exit classes, not one** (req 18): a run-level refusal — a root this
 * run cannot read, a missing or un-parseable `--switched-at`, an unknown org — exits
 * NON-ZERO and writes NO JSON at all, while every per-campaign refusal exits 0 and
 * appears in the plan's refusal list. `--out` is the only machine-readable surface, so
 * the tests read the written FILE, never piped stdout.
 */

/** source.test.ts's spy: answers nothing, records everything, ends when asked. */
function spyClient(orgRows: readonly unknown[] = []): SqlClient {
  return {
    query: vi.fn(async () => ({ rows: orgRows })) as unknown as SqlClient["query"],
    exec: vi.fn(async () => undefined),
    transaction: vi.fn(async () => {
      throw new Error("the importer must never open a transaction");
    }),
    end: vi.fn(async () => undefined),
  };
}

describe("the plan file, the exit classes and the pool (PT-8a2 reqs 18 and 20)", () => {
  let root: string | undefined;
  let output: string | undefined;
  const savedEnv = new Map(
    ["STORE_BACKEND", "DATABASE_URL"].map((key) => [key, process.env[key]] as const),
  );

  beforeEach(() => {
    useFileStores();
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
    resetDatabase();
    dropRoot(root);
    root = undefined;
    output = undefined;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

  test("req 18: --out writes the plan file, and the summary line follows the JSON line", async () => {
    // A report with one VALID field and one ESCAPING one: the named render is
    // separated from the orphan one (D223), and the escape names nothing.
    writeAt(output!, "camp-one/logo.png", PNG);
    writeAt(
      output!,
      "reports/camp-one.json",
      JSON.stringify({
        halted: false,
        assets: [{ outputPath: "camp-one/logo.png", proofPath: "../../etc/passwd" }],
        log: [],
      }),
    );
    const outPath = join(root!, "plan.json");
    const { out, err, deps } = io();

    expect(await main(planArgv("--out", outPath), deps)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(`import plan — switched-at: ${SWITCHED_AT}`);
    expect(out[1]).toBe("org: local");
    expect(out[2]).toBe("backend: fs-only");

    const content = readFileSync(outPath, "utf8");
    expect(content).toBe(`${out[3]}\n`);
    const plan = JSON.parse(content) as {
      includeSamples: boolean;
      reports: unknown[];
      pools: unknown[];
      decisions: unknown[];
      census: Record<string, unknown>;
      digest: string;
    };
    expect(plan.includeSamples).toBe(false);
    expect(plan.reports).toEqual([
      {
        slug: "camp-one",
        present: true,
        fields: [
          {
            field: "outputPath",
            path: "camp-one/logo.png",
            status: "ok",
            resolved: join(output!, "camp-one/logo.png"),
          },
          {
            field: "proofPath",
            path: "../../etc/passwd",
            status: "refused",
            resolved: null,
            reason: "Path escapes the allowed directory.",
          },
        ],
        problems: [],
      },
    ]);
    // The escape is on the run's refusal list, with the slug and the field set (D223).
    expect(
      (
        JSON.parse(out[3]!) as {
          refusals: { slug: string; reason: string; field: string }[];
        }
      ).refusals,
    ).toEqual([
      {
        slug: "camp-one",
        sourcePath: join(output!, "reports/camp-one.json"),
        reason: "Path escapes the allowed directory.",
        field: "proofPath",
      },
    ]);
    expect(plan.pools).toEqual([{ slug: "camp-one", present: false, problems: [] }]);
    expect(plan.decisions).toEqual([{ slug: "camp-one", present: false, problems: [] }]);
    expect(Object.keys(plan.census).sort()).toEqual(
      [
        "backgroundCache",
        "drafts",
        "jobs",
        "lastOpened",
        "legacyReportPointer",
        "nonBriefFiles",
        "orphanRenders",
        "packages",
        "providerKeys",
        "refusedBriefs",
        "samples",
        "templates",
        "unreferencedInputs",
        "usage",
      ].sort(),
    );
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
    // The named render is not an orphan (D223); the summary is the LAST line:
    // `<n> importable, <m> refused, digest <first 12 hex>`.
    expect(plan.census.orphanRenders).toEqual({ count: 0 });
    expect(out[4]).toMatch(/^1 importable, 1 refused, digest [0-9a-f]{12}$/);
  });

  test("req 18: an all-refused tree still exits 0, and the JSON lists every refusal", async () => {
    // Both briefs are refused — the retired layer, and a ref to a missing file —
    // and no run-level refusal is in play, so the run still plans (exit 0).
    writeHtmlLayerBrief(root!, "camp-one.yaml", "camp-one");
    writeBrief(root!, "camp-broken.yaml", {
      id: "camp-broken",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/gone.png" },
      ],
    });
    const { out, deps } = io();

    expect(await main(planArgv(), deps)).toBe(0);
    const plan = JSON.parse(out[3]!) as {
      campaigns: { slug: string }[];
      refusals: { slug: string | null; reason: string }[];
    };
    // D223: a refusal is a fact about the tree, never the end of the run.
    expect(plan.campaigns).toEqual([]);
    // A parse refusal never learned the id (slug null); the ref refusal did.
    expect(plan.refusals.map((one) => one.slug).sort()).toEqual(["camp-broken", null]);
    expect(out[4]).toMatch(/^0 importable, 2 refused, digest [0-9a-f]{12}$/);
  });

  test("req 18: an unreadable --project-root exits 1 and NO --out file appears", async () => {
    const outPath = join(root!, "plan.json");
    const { out, err, deps } = io();
    const missing = join(root!, "no-such-dir");

    expect(
      await main(
        planArgv("--out", outPath).map((arg) => (arg === root! ? missing : arg)),
        deps,
      ),
    ).toBe(1);
    expect(err[0]).toContain(`--project-root ${JSON.stringify(missing)}`);
    expect(out).toEqual([]);
    expect(existsSync(outPath)).toBe(false);
  });

  test("req 18: a missing --switched-at exits 1 with no --out file", async () => {
    const outPath = join(root!, "plan.json");
    const { out, err, deps } = io();

    expect(
      await main(
        ["plan", "--project-root", root!, "--output-root", output!, "--out", outPath],
        deps,
      ),
    ).toBe(1);
    expect(err).toEqual(["--switched-at <iso> is required"]);
    expect(out).toEqual([]);
    expect(existsSync(outPath)).toBe(false);
  });

  test("req 18: an --out with no value refuses with its exact message (ported from PT-8a1's loop)", async () => {
    const { out, err, deps } = io();

    expect(await main(["plan", "--out"], deps)).toBe(1);
    expect(err).toEqual(["--out needs a value."]);
    expect(out).toEqual([]);
  });

  test("req 18: an --out under a missing directory exits 1, names the ENOENT, prints nothing", async () => {
    const outPath = join(root!, "no-such-dir", "plan.json");
    const { out, err, deps } = io();

    expect(await main(planArgv("--out", outPath), deps)).toBe(1);
    expect(err[0]).toContain("ENOENT");
    // Nothing half-printed: a failed write is a failed run.
    expect(out).toEqual([]);
  });

  test("req 20: a postgres run ends the pool once, even when the org row is missing", async () => {
    process.env["STORE_BACKEND"] = "postgres";
    process.env["DATABASE_URL"] =
      process.env["TEST_PG_URL"] ?? "postgres://cf_test@127.0.0.1:5433/postgres";
    const spy = spyClient();
    setDatabase(spy);

    // The probe refuses a missing org row (a RUN-level refusal, exit 1) — and the
    // pool the probe OPENED is still ended exactly once.
    expect(await main(planArgv(), io().deps)).toBe(1);
    expect(spy.query).toHaveBeenCalledTimes(1);
    expect(spy.end).toHaveBeenCalledTimes(1);
  });

  test("req 20: a failed close uninstalls the client, names the failure, keeps the plan's code", async () => {
    process.env["STORE_BACKEND"] = "postgres";
    process.env["DATABASE_URL"] =
      process.env["TEST_PG_URL"] ?? "postgres://cf_test@127.0.0.1:5433/postgres";
    const spy = spyClient([{ id: "local" }]);
    spy.end = vi.fn(async () => {
      throw new Error("the pool is stuck");
    });
    setDatabase(spy);
    const { out, err, deps } = io();

    // The plan succeeded (exit 0) and stays 0: a failed close does not become
    // the run's answer — but it is NAMED, and the broken client is uninstalled
    // either way, so a second in-process run builds a fresh one.
    expect(await main(planArgv(), deps)).toBe(0);
    expect(spy.end).toHaveBeenCalledTimes(1);
    expect(err).toEqual(["could not close the database: the pool is stuck"]);
    expect(out).toHaveLength(5);
    // `database()` no longer answers with the stuck client: resetDatabase ran
    // inside the finally, and the next `database()` rebuilds from the env.
    expect(database()).not.toBe(spy);
    resetDatabase();
  });

  test("req 20: a fs-only run never opens, so never ends, a pool", async () => {
    const spy = spyClient();
    setDatabase(spy);

    expect(await main(planArgv(), io().deps)).toBe(0);
    expect(spy.end).not.toHaveBeenCalled();
  });

  test("req 20: a rejecting pool end still returns the plan's own code", async () => {
    process.env["STORE_BACKEND"] = "postgres";
    process.env["DATABASE_URL"] =
      process.env["TEST_PG_URL"] ?? "postgres://cf_test@127.0.0.1:5433/postgres";
    const spy = spyClient([{ id: "local" }]);
    spy.end = vi.fn(async () => {
      throw new Error("the pool is stuck");
    });
    setDatabase(spy);

    // The plan succeeded (exit 0) and stays 0: a failed close is swallowed, the
    // way a refusal that already named its problem is not re-reported.
    expect(await main(planArgv(), io().deps)).toBe(0);
    expect(spy.end).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)("the verify subcommand (PT-8f3)", () => {
  type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;
  let env: Env;
  let root: string | undefined;
  let output: string | undefined;
  const tmpFiles: string[] = [];
  const S3_VARS = [
    "S3_ENDPOINT",
    "S3_PUBLIC_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ] as const;

  beforeEach(async () => {
    env = await useApplyEnvironment();
    root = makeRoot();
    output = join(root, "output");
    mkdirSync(output, { recursive: true });
    writeAt(root, "assets/inputs/logo.png", PNG);
    writeBrief(root, "camp.yaml", {
      id: "camp",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
      ],
    });
  });

  afterEach(async () => {
    dropRoot(root);
    root = undefined;
    output = undefined;
    for (const path of tmpFiles.splice(0)) rmSync(path, { recursive: true, force: true });
    for (const key of S3_VARS) delete process.env[key];
    await restoreApplyEnvironment();
  });

  function argv(subcommand: string, ...extra: readonly string[]): string[] {
    return [
      subcommand,
      "--project-root",
      root!,
      "--output-root",
      output!,
      "--org",
      "local",
      "--switched-at",
      SWITCHED_AT,
      ...extra,
    ];
  }

  /** `plan` then `apply` the tree; answers the plan's digest and the minted asset's key. */
  async function applyTree(label: string): Promise<{ digest: string; assetKey: string }> {
    const planOut = join(tmpdir(), `cf-cli-plan-${label}-${process.pid}.json`);
    const result = join(tmpdir(), `cf-cli-result-${label}-${process.pid}.jsonl`);
    rmSync(planOut, { force: true });
    rmSync(result, { force: true });
    tmpFiles.push(planOut, result);
    const deps = { stdout: () => {}, stderr: () => {} };

    expect(await main(argv("plan", "--out", planOut), deps)).toBe(0);
    const digest = (JSON.parse(readFileSync(planOut, "utf8")) as { digest: string }).digest;

    env.reinstall();
    expect(
      await main(
        [
          "apply",
          "--project-root",
          root!,
          "--output-root",
          output!,
          "--org",
          "local",
          "--switched-at",
          SWITCHED_AT,
          "--expect",
          digest,
          "--result",
          result,
        ],
        deps,
      ),
    ).toBe(0);
    const lines = readFileSync(result, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const campaign = lines.find(
      (line) => line.kind === "campaign" && line.slug === "camp",
    ) as unknown as CampaignEntry | undefined;
    const assetKey = campaign?.minted.assets[0]?.key ?? "";
    expect(assetKey).not.toBe("");
    return { digest, assetKey };
  }

  test("plan → apply → verify: a clean target exits 0, writes valid JSON before stdout, and prints entity counts", async () => {
    const { digest } = await applyTree("e2e");
    env.reinstall();
    const outPath = join(tmpdir(), `cf-cli-verify-e2e-${process.pid}.json`);
    tmpFiles.push(outPath);
    const { out, err, deps } = io();
    expect(await main(argv("verify", "--expect", digest, "--out", outPath), deps)).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe(`import verify — switched-at: ${SWITCHED_AT}`);
    expect(out[1]).toBe("org: local");
    expect(out[2]).toBe(`digest: ${digest}`);
    expect(out).toContain("campaign: 1 checked, 1 matched, 0 mismatched");
    expect(out).toContain("asset: 1 checked, 1 matched, 0 mismatched");
    expect(out).toContain("render: 0 checked, 0 matched, 0 mismatched");
    expect(out).toContain("org: 1 campaigns, 1 versions, 1 assets");
    expect(out[out.length - 1]).toBe("verify ok");

    const report = JSON.parse(readFileSync(outPath, "utf8")) as {
      switchedAt: string;
      orgId: string;
      digest: string;
      ok: boolean;
      counts: Record<string, { checked: number; matched: number }>;
      orgCounts: { campaigns: number; briefVersions: number; assets: number };
      checks: unknown[];
      orgChecks: unknown[];
    };
    expect(report.switchedAt).toBe(SWITCHED_AT);
    expect(report.orgId).toBe("local");
    expect(report.digest).toBe(digest);
    expect(report.ok).toBe(true);
    expect(report.counts.campaign).toEqual({ checked: 1, matched: 1 });
    expect(report.orgCounts).toEqual({ campaigns: 1, briefVersions: 1, reports: 0, assets: 1 });
    expect(report.orgChecks).toEqual([]);
  });

  test("flipping one byte of a stored object makes verify exit 1 naming that asset", async () => {
    const { assetKey } = await applyTree("flip");
    const stored = Buffer.from((await env.objects.get(assetKey))!.bytes);
    stored[stored.length - 1] = stored[stored.length - 1]! ^ 0xff;
    await env.objects.put(assetKey, stored);

    env.reinstall();
    const { out, err, deps } = io();
    expect(await main(argv("verify"), deps)).toBe(1);
    expect(err).toEqual([]);
    expect(out).toContain("campaign: 1 checked, 0 matched, 1 mismatched");
    expect(out.some((line) => line.includes(": asset mismatch: "))).toBe(true);
    expect(out[out.length - 1]).toBe("verify FAILED");
  });

  test("a wrong --expect exits 1 before the target's rows are read", async () => {
    const { digest } = await applyTree("expect");
    env.reinstall();
    const wrong = "0".repeat(64);
    const { out, err, deps } = io();
    expect(await main(argv("verify", "--expect", wrong), deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([`verify: --expect ${wrong} differs from re-planned digest ${digest}`]);
  });

  test("unknown flags and --result are refused by verify", async () => {
    for (const flag of ["--result", "--bogus"]) {
      env.reinstall();
      const { out, err, deps } = io();
      expect(await main(argv("verify", flag, "x"), deps)).toBe(1);
      expect(out).toEqual([]);
      expect(err).toEqual([`${flag} is not a flag this command takes.`]);
    }
  });

  test("an --out write failure exits 1 with nothing printed to stdout", async () => {
    await applyTree("outfail");
    env.reinstall();
    const badDir = mkdtempSync(join(tmpdir(), "cf-bad-out-"));
    tmpFiles.push(badDir);
    const { out, err, deps } = io();
    expect(await main(argv("verify", "--out", badDir), deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("EEXIST");
  });

  test("verify refuses an --out path under the project root or the output root and writes nothing", async () => {
    await applyTree("out-under-roots");
    for (const rel of ["verify.json", "output/verify.json"]) {
      // Each run closes the pool it opened (req 20), so the next run needs the
      // double reinstalled — as every other multi-run test here does.
      env.reinstall();
      const outPath = join(root!, rel);
      const { out, err, deps } = io();
      expect(await main(argv("verify", "--out", outPath), deps)).toBe(1);
      expect(out).toEqual([]);
      expect(err).toEqual([`--out ${JSON.stringify(outPath)} is under the project or output root`]);
      expect(existsSync(outPath)).toBe(false);
    }
  });

  test("verify refuses an --out path whose parent directory does not exist and writes nothing", async () => {
    await applyTree("out-no-parent");
    env.reinstall();
    const missingDir = join(tmpdir(), `cf-no-parent-${process.pid}`);
    const outPath = join(missingDir, "verify.json");
    const { out, err, deps } = io();
    expect(await main(argv("verify", "--out", outPath), deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `--out ${JSON.stringify(outPath)} has no existing parent directory: ${JSON.stringify(missingDir)}`,
    ]);
    expect(existsSync(outPath)).toBe(false);
  });

  test("an --out that is a symlink to a file under the project root exits 1 and the target is byte-identical; a dangling symlink creates nothing at its target", async () => {
    await applyTree("out-symlink");
    env.reinstall();

    const targetFile = join(root!, "briefs/camp.yaml");
    const originalBytes = readFileSync(targetFile);
    const symlinkPath = join(tmpdir(), `cf-cli-symlink-target-${process.pid}.json`);
    rmSync(symlinkPath, { force: true });
    symlinkSync(targetFile, symlinkPath);
    tmpFiles.push(symlinkPath);

    const { out: out1, err: err1, deps: deps1 } = io();
    expect(await main(argv("verify", "--out", symlinkPath), deps1)).toBe(1);
    expect(out1).toEqual([]);
    expect(err1[0]).toContain("EEXIST");
    expect(readFileSync(targetFile)).toEqual(originalBytes);

    env.reinstall();
    const danglingTarget = join(root!, "briefs/does-not-exist.yaml");
    const danglingSymlink = join(tmpdir(), `cf-cli-dangling-${process.pid}.json`);
    rmSync(danglingSymlink, { force: true });
    symlinkSync(danglingTarget, danglingSymlink);
    tmpFiles.push(danglingSymlink);

    const { out: out2, err: err2, deps: deps2 } = io();
    expect(await main(argv("verify", "--out", danglingSymlink), deps2)).toBe(1);
    expect(out2).toEqual([]);
    expect(err2[0]).toContain("EEXIST");
    expect(existsSync(danglingTarget)).toBe(false);
  });

  test("report rows whose error embeds configured secrets redacts them in stdout and in the --out file", async () => {
    writeAt(output!, "reports/camp.json", JSON.stringify({ halted: false, assets: [], log: [] }));
    await applyTree("report-secrets");
    env.reinstall();
    process.env.DATABASE_URL = "postgres://cf_test:p%40ss@127.0.0.1:5432/cf_home";
    process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
    process.env.S3_PUBLIC_ENDPOINT = "http://127.0.0.1:9000";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_BUCKET = "bucket";
    process.env.S3_ACCESS_KEY_ID = "key";
    process.env.S3_SECRET_ACCESS_KEY = "shhh";

    const realReports = getReportStore(importTenant("local"));
    const evilReports = new Proxy(realReports, {
      get(target, prop) {
        if (prop === "getRevision") {
          return async () => {
            throw new Error(
              "could not reach postgres://cf_test:p%40ss@127.0.0.1:5432/cf_home (password p@ss) with S3_SECRET_ACCESS_KEY=shhh",
            );
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    setReportStore(evilReports);

    const outPath = join(tmpdir(), `cf-cli-verify-report-secrets-${process.pid}.json`);
    tmpFiles.push(outPath);
    const { out, err, deps } = io();
    try {
      expect(await main(argv("verify", "--out", outPath), deps)).toBe(1);
      expect(err).toEqual([]);
      expect(existsSync(outPath)).toBe(true);
      const fileContent = readFileSync(outPath, "utf8");
      const streamsAndFile = [...out, ...err, fileContent];
      for (const text of streamsAndFile) {
        expect(text).not.toContain("p%40ss");
        expect(text).not.toContain("p@ss");
        expect(text).not.toContain("shhh");
      }
      expect(fileContent).toContain("[redacted]");
      expect(out.some((line) => line.includes("[redacted]"))).toBe(true);
      expect(out.some((line) => line.includes("report mismatch:"))).toBe(true);
      expect(out[out.length - 1]).toBe("verify FAILED");

      const parsed = JSON.parse(fileContent) as {
        ok: boolean;
        checks: { entity: string; status: string; reason?: string }[];
      };
      expect(parsed.ok).toBe(false);
      const reportCheck = parsed.checks.find((c) => c.entity === "report");
      expect(reportCheck?.status).toBe("mismatch");
      expect(reportCheck?.reason).toContain("[redacted]");
      expect(reportCheck?.reason).not.toContain("p%40ss");
      expect(reportCheck?.reason).not.toContain("p@ss");
      expect(reportCheck?.reason).not.toContain("shhh");
    } finally {
      for (const key of S3_VARS) delete process.env[key];
      process.env.DATABASE_URL = "postgres://nobody@unused.invalid:5432/none";
    }
  });

  test('password a"b in a report reason never reaches the file', async () => {
    writeAt(output!, "reports/camp.json", JSON.stringify({ halted: false, assets: [], log: [] }));
    await applyTree("quote-secret");
    env.reinstall();
    process.env.DATABASE_URL = "postgres://cf_test:a%22b@127.0.0.1:5432/cf_home";

    const realReports = getReportStore(importTenant("local"));
    const evilReports = new Proxy(realReports, {
      get(target, prop) {
        if (prop === "getRevision") {
          return async () => {
            throw new Error('failed with password a"b');
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    setReportStore(evilReports);

    const outPath = join(tmpdir(), `cf-cli-verify-quote-secret-${process.pid}.json`);
    rmSync(outPath, { force: true });
    tmpFiles.push(outPath);
    const { out, err, deps } = io();
    try {
      expect(await main(argv("verify", "--out", outPath), deps)).toBe(1);
      expect(err).toEqual([]);
      expect(existsSync(outPath)).toBe(true);
      const fileContent = readFileSync(outPath, "utf8");
      expect(fileContent).not.toContain('a"b');
      expect(fileContent).not.toContain('a\\"b');
      expect(fileContent).toContain("[redacted]");
      const parsed = JSON.parse(fileContent) as {
        ok: boolean;
        checks: { entity: string; status: string; reason?: string }[];
      };
      expect(parsed.ok).toBe(false);
      const reportCheck = parsed.checks.find((c) => c.entity === "report");
      expect(reportCheck?.status).toBe("mismatch");
      expect(reportCheck?.reason).toContain("[redacted]");
      expect(reportCheck?.reason).not.toContain('a"b');
      expect(reportCheck?.reason).not.toContain('a\\"b');
    } finally {
      process.env.DATABASE_URL = "postgres://nobody@unused.invalid:5432/none";
    }
  });

  test("verify refuses an --out path under roots and redacts JSON-escaped secrets in the refusal", async () => {
    await applyTree("out-refusal-secret");
    env.reinstall();
    process.env.DATABASE_URL = "postgres://cf_test:a%22b@127.0.0.1:5432/cf_home";
    const outPath = join(root!, 'secret-a"b.json');
    const { out, err, deps } = io();
    try {
      expect(await main(argv("verify", "--out", outPath), deps)).toBe(1);
      expect(out).toEqual([]);
      expect(err).toHaveLength(1);
      expect(err[0]).toContain("[redacted]");
      expect(err[0]).not.toContain('a"b');
      expect(err[0]).not.toContain('a\\"b');
      expect(existsSync(outPath)).toBe(false);
    } finally {
      process.env.DATABASE_URL = "postgres://nobody@unused.invalid:5432/none";
    }
  });

  test("a target read that throws exits 1 with the error on stderr, nothing on stdout and no --out file", async () => {
    await applyTree("throw");
    env.reinstall();
    setAssetStore(failOnNth(getAssetStore(importTenant("local")), "readAssetById", 1));
    const outPath = join(tmpdir(), `cf-cli-verify-throw-${process.pid}.json`);
    tmpFiles.push(outPath);
    const { out, err, deps } = io();
    expect(await main(argv("verify", "--out", outPath), deps)).toBe(1);
    expect(err[0]).toBe("injected");
    expect(out).toEqual([]);
    expect(existsSync(outPath)).toBe(false);
  });

  test("a store whose thrown error embeds the configured secrets redacts them on stderr", async () => {
    await applyTree("redact");
    env.reinstall();
    process.env.DATABASE_URL = "postgres://cf_test:p%40ss@127.0.0.1:5432/cf_home";
    process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
    process.env.S3_PUBLIC_ENDPOINT = "http://127.0.0.1:9000";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_BUCKET = "bucket";
    process.env.S3_ACCESS_KEY_ID = "key";
    process.env.S3_SECRET_ACCESS_KEY = "shhh";
    const evil = new Proxy(env.objects, {
      get(target, prop) {
        if (prop === "get") {
          return async () => {
            throw new Error(
              "could not reach postgres://cf_test:p%40ss@127.0.0.1:5432/cf_home (password p@ss) with S3_SECRET_ACCESS_KEY=shhh",
            );
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    setObjectStoreClient(evil);
    env.db.end = vi.fn(async () => {
      throw new Error(
        "could not close pool for postgres://cf_test:p%40ss@127.0.0.1:5432/cf_home with password p@ss",
      );
    });

    const outPath = join(tmpdir(), `cf-cli-verify-redact-${process.pid}.json`);
    tmpFiles.push(outPath);
    const { out, err, deps } = io();
    try {
      expect(await main(argv("verify", "--out", outPath), deps)).toBe(1);
      expect(err).toHaveLength(2);
      expect(err[0]).toContain("[redacted]");
      expect(err[1]).toContain("could not close the database:");
      expect(err[1]).toContain("[redacted]");
      for (const line of err) {
        expect(line).not.toContain("p%40ss");
        expect(line).not.toContain("p@ss");
        expect(line).not.toContain("shhh");
      }
      expect(out).toEqual([]);
      expect(existsSync(outPath)).toBe(false);
    } finally {
      for (const key of S3_VARS) delete process.env[key];
      process.env.DATABASE_URL = "postgres://nobody@unused.invalid:5432/none";
    }
  });

  test("secret s/+= appearing as s%2F%2B%3D is redacted", async () => {
    await applyTree("s3-encoded-secret");
    env.reinstall();
    process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
    process.env.S3_PUBLIC_ENDPOINT = "http://127.0.0.1:9000";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_BUCKET = "bucket";
    process.env.S3_ACCESS_KEY_ID = "key";
    process.env.S3_SECRET_ACCESS_KEY = "s/+=";

    const evil = new Proxy(env.objects, {
      get(target, prop) {
        if (prop === "get") {
          return async () => {
            throw new Error("could not reach S3 with signature s%2F%2B%3D and key s/+=");
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    setObjectStoreClient(evil);

    const { out, err, deps } = io();
    try {
      expect(await main(argv("verify"), deps)).toBe(1);
      expect(err).toHaveLength(1);
      expect(err[0]).toContain("[redacted]");
      expect(err[0]).not.toContain("s%2F%2B%3D");
      expect(err[0]).not.toContain("s/+=");
      expect(out).toEqual([]);
    } finally {
      for (const key of S3_VARS) delete process.env[key];
    }
  });

  test("a database close error that embeds configured secrets redacts them on stderr", async () => {
    await applyTree("closeredact");
    env.reinstall();
    process.env.DATABASE_URL = "postgres://cf_test:p%40ss@127.0.0.1:5432/cf_home";
    env.db.end = vi.fn(async () => {
      throw new Error(
        "could not close pool for postgres://cf_test:p%40ss@127.0.0.1:5432/cf_home with password p@ss",
      );
    });

    const { out, err, deps } = io();
    try {
      expect(await main(argv("verify"), deps)).toBe(0);
      expect(err).toHaveLength(1);
      expect(err[0]).toContain("could not close the database:");
      expect(err[0]).toContain("[redacted]");
      expect(err[0]).not.toContain("p%40ss");
      expect(err[0]).not.toContain("p@ss");
      expect(out[out.length - 1]).toBe("verify ok");
    } finally {
      process.env.DATABASE_URL = "postgres://nobody@unused.invalid:5432/none";
    }
  });

  test("verify prints org-wide mismatches with an org: prefix", async () => {
    await applyTree("actorcli");
    await env.db.query(
      `update brief_version set actor = $1
        where campaign_id = (select id from campaign where slug = $2)`,
      ["user-1", "camp"],
    );
    // A live campaign whose latest version still carries a path ref: an org-wide
    // asset mismatch that also exercises the `item` half of the printed org line.
    const inserted = await env.db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ($1, $2) returning id`,
      ["local", "pathy"],
    );
    await env.db.query(
      `insert into brief_version (campaign_id, version, body, revision, actor)
       values ($1, 1, $2, $3, $4)`,
      [
        inserted.rows[0]!.id,
        JSON.stringify(
          briefBody({
            id: "pathy",
            products: [
              { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/logo.png" },
            ],
          }),
        ),
        "rev-pathy",
        "import:pt-8",
      ],
    );
    env.reinstall();
    const { out, err, deps } = io();
    expect(await main(argv("verify"), deps)).toBe(1);
    expect(err).toEqual([]);
    expect(out).toContain(
      'org: camp: campaign mismatch: latest brief_version actor is "user-1", expected "import:pt-8"',
    );
    expect(out).toContain(
      'org: pathy (assets/logo.png): asset mismatch: latest brief_version still carries path ref "assets/logo.png"',
    );
    expect(out[out.length - 1]).toBe("verify FAILED");
  });

  test("verify without --switched-at exits 1", async () => {
    env.reinstall();
    const { out, err, deps } = io();
    expect(
      await main(
        ["verify", "--project-root", root!, "--output-root", output!, "--org", "local"],
        deps,
      ),
    ).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["--switched-at <iso> is required"]);
  });

  test("verify refuses unless OBJECT_STORE is s3", async () => {
    process.env.OBJECT_STORE = "fs";
    const { out, err, deps } = io();
    expect(await main(argv("verify"), deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["verify needs OBJECT_STORE=s3, and OBJECT_STORE is fs"]);
  });

  test("apply prints a step error on stdout when a scoped existing-campaign report fails", async () => {
    const inserted = await env.db.query<{ id: string }>(
      `insert into campaign (org_id, slug, created_at) values ('local', 'pre-camp', '2026-09-30T00:00:00Z') returning id`,
    );
    await env.db.query(
      `insert into brief_version (campaign_id, version, body, revision, actor)
       values ($1, 1, $2, 'rev-1', 'import:pt-8')`,
      [inserted.rows[0]!.id, JSON.stringify(briefBody({ id: "pre-camp", products: [] }))],
    );
    await env.db.query(
      `insert into report (org_id, campaign_id, body, revision) values ('local', 'pre-camp', 'not-valid-json {', 'r-1')`,
    );

    const planOut = join(tmpdir(), `cf-cli-plan-step-err-${process.pid}.json`);
    const result = join(tmpdir(), `cf-cli-result-step-err-${process.pid}.jsonl`);
    tmpFiles.push(planOut, result);

    const depsPlan = { stdout: () => {}, stderr: () => {} };
    expect(await main(argv("plan", "--out", planOut), depsPlan)).toBe(0);
    const digest = (JSON.parse(readFileSync(planOut, "utf8")) as { digest: string }).digest;

    env.reinstall();
    const { out, err, deps } = io();
    const code = await main(argv("apply", "--expect", digest, "--result", result), deps);
    expect(code).toBe(1);
    expect(err).toEqual([]);
    expect(out).toContain("pre-camp: existing renders (no-upload)");
    expect(
      out.some((line) =>
        line.startsWith("  a later step failed: the stored report body for pre-camp is not JSON"),
      ),
    ).toBe(true);
  });
});
