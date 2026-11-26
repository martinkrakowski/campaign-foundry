import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../seed-sample.js";
import type { SeedSampleDeps } from "../seed-sample.js";
import { main as importMain } from "../import.js";
import { existingCounts } from "../../server/lib/import/existing-campaigns.js";
import {
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "../../server/lib/import/__tests__/fixtures/apply-harness.js";

/**
 * The `yarn seed:sample` CLI (PT-8g): one command that hydrates
 * `briefs/sample-campaign.yaml` into an empty postgres + s3 target by driving
 * `plan` -> `apply` -> `verify`, and refuses everything else.
 *
 * **`main` is called in process with its I/O injected, never spawned** — the
 * tests own what the CLI would have written and the exit code is the return
 * value. Every refusal branch is table-driven: usage (2), guards and target
 * refusals (1), and the stage-2/3 failures with a mocked `runImport`.
 */

const SWITCHED_AT = "2026-10-01T00:00:00Z";

describe.skipIf(ON_A_REAL_TEST_SERVER)("seed:sample CLI", () => {
  type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;
  let env: Env;

  /**
   * Run one seed `main` call with the PGlite client re-installed around it:
   * the seeder's own stage-1 check and every import subcommand close and reset
   * the process database (`closeDatabase`), so `env.reinstall()` before and
   * after each call is what keeps the harness DB wired across the whole run.
   */
  async function seedMain(argv: readonly string[], deps: SeedSampleDeps): Promise<number> {
    env.reinstall();
    try {
      return await main(argv, deps);
    } finally {
      env.reinstall();
    }
  }

  /**
   * The injected `runImport`: re-installs the PGlite client around each
   * `plan`/`apply`/`verify` call, since each subcommand ends by resetting the
   * process database.
   */
  function runImportDeps(
    out: string[],
    err: string[],
    runImport?: SeedSampleDeps["runImport"],
  ): SeedSampleDeps {
    const io = {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    };
    return {
      ...io,
      runImport:
        runImport ??
        (async (argv: readonly string[]) => {
          env.reinstall();
          try {
            return await importMain(argv, io);
          } finally {
            env.reinstall();
          }
        }),
    };
  }

  beforeEach(async () => {
    env = await useApplyEnvironment();
  });

  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("--help prints USAGE to stdout and exits 0", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await seedMain(["--help"], runImportDeps(out, err))).toBe(0);
    expect(out.join("\n")).toContain("usage: yarn seed:sample");
    expect(err).toEqual([]);
  });

  test("--help works with io-only deps (no runImport injected)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await main(["--help"], { stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(
      0,
    );
    expect(out.join("\n")).toContain("usage: yarn seed:sample");
    expect(err).toEqual([]);
  });

  test("usage refusal with no deps at all (io falls back to console)", async () => {
    expect(await main(["--bogus"])).toBe(2);
  });

  describe("usage refusals (exit 2)", () => {
    const cases: readonly [label: string, argv: readonly string[]][] = [
      ["missing --org", ["--switched-at", SWITCHED_AT]],
      ["missing --switched-at", ["--org", "local"]],
      ["missing flag value", ["--org", "local", "--switched-at"]],
      ["unknown flag", ["--org", "local", "--switched-at", SWITCHED_AT, "--bogus"]],
    ];
    for (const [label, argv] of cases) {
      test(label, async () => {
        const out: string[] = [];
        const err: string[] = [];
        expect(await seedMain(argv, runImportDeps(out, err))).toBe(2);
        expect(err.join("\n")).toContain("usage: yarn seed:sample");
        expect(out).toEqual([]);
      });
    }
  });

  describe("run refusals (exit 1)", () => {
    const seeded = "seeded";

    /** Seed once (the real path), so the org is non-empty. */
    async function seedOnce(): Promise<void> {
      const out: string[] = [];
      const err: string[] = [];
      expect(
        await seedMain(["--org", "local", "--switched-at", SWITCHED_AT], runImportDeps(out, err)),
      ).toBe(0);
    }

    /** argv for the org-refusal table, minus the label. */
    function argv(extra: readonly string[] = []): string[] {
      return ["--org", "local", "--switched-at", SWITCHED_AT, ...extra];
    }

    /** Pull one flag's value out of the argv a mocked `runImport` received. */
    function flagValue(argv: readonly string[], flag: string): string | undefined {
      const index = argv.indexOf(flag);
      return index === -1 ? undefined : argv[index + 1];
    }

    test("wrong STORE_BACKEND refuses before any write", async () => {
      process.env["STORE_BACKEND"] = "fs";
      const out: string[] = [];
      const err: string[] = [];
      expect(await seedMain(argv(), runImportDeps(out, err))).toBe(1);
      expect(err.join("\n")).toContain("STORE_BACKEND");
      expect(await existingCounts(env.db, "local")).toEqual({
        campaigns: 0,
        briefVersions: 0,
        reports: 0,
        assets: 0,
      });
    });

    test("missing org row refuses (probeTarget fails)", async () => {
      const out: string[] = [];
      const err: string[] = [];
      expect(
        await seedMain(
          ["--org", "no-such-org", "--switched-at", SWITCHED_AT],
          runImportDeps(out, err),
        ),
      ).toBe(1);
      expect(err.join("\n")).toContain("no-such-org");
    });

    test("unparseable --switched-at refuses via plan", async () => {
      const out: string[] = [];
      const err: string[] = [];
      expect(
        await seedMain(["--org", "local", "--switched-at", "not-a-date"], runImportDeps(out, err)),
      ).toBe(1);
      expect(err.join("\n")).toContain("not a valid date");
    });

    test("missing sample brief in the source root refuses before plan", async () => {
      const sourceRoot = mkdtempSync(join(tmpdir(), "cf-seed-src-"));
      try {
        const out: string[] = [];
        const err: string[] = [];
        expect(await seedMain(argv(["--project-root", sourceRoot]), runImportDeps(out, err))).toBe(
          1,
        );
        expect(err.join("\n")).toContain("sample-campaign.yaml");
        expect(await existingCounts(env.db, "local")).toEqual({
          campaigns: 0,
          briefVersions: 0,
          reports: 0,
          assets: 0,
        });
      } finally {
        rmSync(sourceRoot, { recursive: true, force: true });
      }
    });

    test("non-empty target org refuses and writes nothing (second seed)", async () => {
      await seedOnce();
      const out: string[] = [];
      const err: string[] = [];
      const putCount = env.objects.putCount;
      expect(await seedMain(argv(), runImportDeps(out, err))).toBe(1);
      expect(err.join("\n")).toContain("is not empty");
      expect(await existingCounts(env.db, "local")).toEqual({
        campaigns: 1,
        briefVersions: 1,
        reports: 0,
        assets: 2,
      });
      expect(env.objects.putCount).toBe(putCount);
    });

    describe("with a mocked runImport", () => {
      /** Read the file a mocked subcommand was told to write. */
      function readOut(argv: readonly string[], flag: string): string | undefined {
        const path = flagValue(argv, flag);
        return path === undefined ? undefined : readFileSync(path, "utf8");
      }

      const cases: readonly [label: string, runImport: SeedSampleDeps["runImport"]][] = [
        ["failed plan refuses", async () => 1],
        [
          "malformed plan.json refuses",
          async (argv) => {
            const path = flagValue(argv, "--out");
            if (path !== undefined) writeFileSync(path, "not json");
            return 0;
          },
        ],
        [
          "plan without a digest refuses",
          async (argv) => {
            const path = flagValue(argv, "--out");
            if (path !== undefined) writeFileSync(path, "{}\n");
            return 0;
          },
        ],
        [
          "failed apply refuses without running verify",
          async (argv) => {
            if (argv[0] === "plan") {
              const path = flagValue(argv, "--out");
              if (path !== undefined) writeFileSync(path, JSON.stringify({ digest: "d" }));
            }
            return argv[0] === "apply" ? 1 : 0;
          },
        ],
        [
          "failed verify refuses",
          async (argv) => {
            if (argv[0] === "plan") {
              const path = flagValue(argv, "--out");
              if (path !== undefined) writeFileSync(path, JSON.stringify({ digest: "d" }));
            }
            return argv[0] === "verify" ? 1 : 0;
          },
        ],
        [
          "unreadable verify report refuses",
          async (argv) => {
            if (argv[0] === "plan") {
              const path = flagValue(argv, "--out");
              if (path !== undefined) writeFileSync(path, JSON.stringify({ digest: "d" }));
            }
            return 0;
          },
        ],
        [
          "verify report that is not ok refuses",
          async (argv) => {
            if (argv[0] === "plan") {
              const path = flagValue(argv, "--out");
              if (path !== undefined) writeFileSync(path, JSON.stringify({ digest: "d" }));
            }
            if (argv[0] === "verify") {
              const path = flagValue(argv, "--out");
              if (path !== undefined) writeFileSync(path, '{"ok":false}\n');
            }
            return 0;
          },
        ],
      ];

      for (const [label, runImport] of cases) {
        test(label, async () => {
          const out: string[] = [];
          const err: string[] = [];
          expect(await seedMain(argv(), runImportDeps(out, err, runImport))).toBe(1);
          expect(await existingCounts(env.db, "local")).toEqual({
            campaigns: 0,
            briefVersions: 0,
            reports: 0,
            assets: 0,
          });
        });
      }
    });
  });

  test("hydration: seeds the sample campaign into an empty target, then refuses a second seed", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await seedMain(["--org", "local", "--switched-at", SWITCHED_AT], runImportDeps(out, err)),
    ).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("verify ok");
    expect(await existingCounts(env.db, "local")).toEqual({
      campaigns: 1,
      briefVersions: 1,
      reports: 0,
      assets: 2,
    });

    const putCount = env.objects.putCount;
    const out2: string[] = [];
    const err2: string[] = [];
    expect(
      await seedMain(["--org", "local", "--switched-at", SWITCHED_AT], runImportDeps(out2, err2)),
    ).toBe(1);
    expect(err2.join("\n")).toContain("is not empty");
    expect(await existingCounts(env.db, "local")).toEqual({
      campaigns: 1,
      briefVersions: 1,
      reports: 0,
      assets: 2,
    });
    expect(env.objects.putCount).toBe(putCount);
  });

  test("workDir is distinct from the temp project and output roots", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const seen: string[][] = [];
    // Capture the roots each subcommand received; they must be three distinct dirs.
    const deps = runImportDeps(out, err, async (argv) => {
      seen.push([...argv]);
      return 0;
    });
    // A fake plan/apply/verify run still needs a plan digest and a verify ok.
    await seedMain(["--org", "local", "--switched-at", SWITCHED_AT], {
      ...deps,
      runImport: async (argv) => {
        seen.push([...argv]);
        const outIndex = argv.indexOf("--out");
        const projectIndex = argv.indexOf("--project-root");
        const outputIndex = argv.indexOf("--output-root");
        if (argv[0] === "plan" && outIndex !== -1) {
          writeFileSync(argv[outIndex + 1]!, JSON.stringify({ digest: "d" }));
        }
        if (argv[0] === "verify" && outIndex !== -1) {
          writeFileSync(argv[outIndex + 1]!, JSON.stringify({ ok: true }));
        }
        expect(argv[projectIndex + 1]).not.toBe(argv[outputIndex + 1]);
        return 0;
      },
    });
    expect(seen.length).toBe(3);
  });
});
