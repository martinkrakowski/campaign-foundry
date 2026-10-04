import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectRoot as processProjectRoot } from "@campaignfoundry/shared";
import { outputRoot as processOutputRoot } from "../../config.js";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { deriveOrgId, probeTarget, resolveSource, SWITCHED_AT_REQUIRED } from "../source.js";
import type { SourceFlags } from "../source.js";
import { dropRoot, makeRoot } from "./fixtures/tree.js";

/**
 * PT-8a reqs 1–5: the run-level refusals, and the read-only target probe.
 *
 * **`resolveSource` is where a run either has a source or a reason it has none**, so a
 * refusal here is a run-level one: it stops the CLI, and the CLI's exit code is 1. Every
 * test names the refusal it expects, because a refusal nobody can tell apart from another
 * is a refusal nobody can act on.
 *
 * The database is reached only through `database()` (`db/database.ts:16`), which is what
 * lets a test install a spy and count the queries: the fs-only branch's whole claim is
 * that it issues NONE.
 */

const SWITCHED_AT = "2026-10-01T00:00:00Z";
const ENV_KEYS = ["STORE_BACKEND", "DATABASE_URL", "OUTPUT_DIR"] as const;
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

/** A `SqlClient` that answers nothing and records every statement it was asked for. */
function spyClient(): SqlClient {
  return {
    query: vi.fn(async () => ({ rows: [] })),
    exec: vi.fn(async () => undefined),
    transaction: vi.fn(async () => {
      throw new Error("the importer's probe must never open a transaction");
    }),
    end: vi.fn(async () => undefined),
  };
}

/** Point the environment at the file stores (the default) or at a configured postgres. */
function setEnv(backend: "fs" | "postgres"): void {
  // Named EXPLICITLY, never left unset (the `auth-boot-guard.test.ts` convention):
  // `loadEnv()` never overrides a var already in `process.env`, so an operator's
  // `.env.local` saying `STORE_BACKEND=postgres` would otherwise flip every fs-only test
  // in this file on their machine and not on mine.
  process.env["STORE_BACKEND"] = backend;
  if (backend === "postgres") {
    // The harness's own URL: loopback, and the credential comes from the operator's
    // `.pgpass` rather than from here. It only has to be PRESENT for `resolveSource`;
    // every test that reaches a database installs its own client with `setDatabase`.
    process.env["DATABASE_URL"] =
      process.env["TEST_PG_URL"] ?? "postgres://cf_test@127.0.0.1:5433/postgres";
  } else {
    // SET, deliberately: an operator's `.env.local` may name a database the app has not
    // been moved onto yet, and `STORE_BACKEND` is the only thing that says which. A test
    // that inferred the backend from this URL's presence would prove nothing.
    process.env["DATABASE_URL"] = "postgres://cf_test@127.0.0.1:5433/postgres";
  }
  delete process.env["OUTPUT_DIR"];
}

function restoreEnv(): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** One temp tree with both roots present, which is what a readable source looks like. */
function roots(): { root: string; output: string } {
  const root = makeRoot();
  const output = join(root, "output");
  mkdirSync(output, { recursive: true });
  return { root, output };
}

describe("resolveSource (PT-8a reqs 1-4)", () => {
  let root: string;
  let output: string;

  /** This suite's flags, with both roots pointed at the temp tree by default. */
  function flags(over: Partial<SourceFlags> = {}): SourceFlags {
    return {
      includeSamples: false,
      switchedAt: SWITCHED_AT,
      projectRoot: root,
      outputRoot: output,
      ...over,
    };
  }

  beforeEach(() => {
    ({ root, output } = roots());
    setEnv("fs");
    setDatabase(spyClient());
  });

  afterEach(() => {
    resetDatabase();
    dropRoot(root);
    restoreEnv();
  });

  test("req 1: both roots default as config.ts resolves them", async () => {
    // `OUTPUT_DIR` is set rather than creating `<repo>/output` in the real checkout: this
    // test is about which directory `config.ts` resolves, and making it true by writing
    // into the repository would leave state behind for every later run on this machine.
    // `outputRoot()` is `resolve(projectRoot(), OUTPUT_DIR ?? "output")`, so the override
    // IS the resolution being asserted.
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    process.env["OUTPUT_DIR"] = out;
    const defaulted = await resolveSource({ includeSamples: false, switchedAt: SWITCHED_AT });

    expect(defaulted).toMatchObject({
      ok: true,
      source: {
        backend: "fs-only",
        ctx: { projectRoot: resolve(processProjectRoot()), outputRoot: resolve(out) },
      },
    });
    expect(resolve(processOutputRoot())).toBe(resolve(out));
  });

  test("req 1: both flags override the roots, and an absent one refuses NAMING the path", async () => {
    expect(flags({ includeSamples: true })).toMatchObject({ includeSamples: true });

    const missing = join(root, "no-such-dir");
    for (const [over, flag] of [
      [{ projectRoot: missing }, "--project-root"],
      [{ outputRoot: missing }, "--output-root"],
    ] as const) {
      const refused = await resolveSource(flags(over));
      expect(refused).toMatchObject({ ok: false });
      // The refusal NAMES the path: an operator who typed the flag needs to be told which
      // of the two roots was wrong, not that "a root" was.
      expect(refused.ok === false && refused.reason).toEqual(
        expect.stringContaining(`${flag} ${JSON.stringify(missing)}`),
      );
    }
  });

  test("req 1: a root that is not a directory is refused too", async () => {
    const file = join(root, "a-file");
    writeFileSync(file, "not a directory\n");

    expect(await resolveSource(flags({ projectRoot: file }))).toEqual({
      ok: false,
      reason: `--project-root ${JSON.stringify(file)} is not a directory.`,
    });
  });

  test("req 2: the process root maps to local", async () => {
    expect(deriveOrgId(root)).toBe("local");
    expect(await resolveSource(flags())).toMatchObject({
      ok: true,
      source: { ctx: { orgId: "local" } },
    });
  });

  test("req 2: a root under orgs/<id>/ maps to <id>", async () => {
    const scoped = join(root, "orgs", "acme");
    mkdirSync(scoped, { recursive: true });

    expect(deriveOrgId(scoped)).toBe("acme");
    expect(await resolveSource(flags({ projectRoot: scoped }))).toMatchObject({
      ok: true,
      source: { ctx: { orgId: "acme" } },
    });
  });

  test("req 3: --org is accepted only when a database is configured AND the row is there", async () => {
    setEnv("postgres");
    const db = await migratedDatabase();
    setDatabase(db);
    try {
      expect(await resolveSource(flags({ org: "local" }))).toMatchObject({
        ok: true,
        source: { backend: "postgres", ctx: { orgId: "local" } },
      });

      expect(await resolveSource(flags({ org: "nope" }))).toEqual({
        ok: false,
        reason: 'no org "nope" exists in the target database.',
      });
    } finally {
      resetDatabase();
      await db.end();
    }
    // `migratedDatabase()` on PGlite applies the whole shipped migration set in process,
    // and on a slow host that alone outruns vitest's 5 s default — the same reason
    // `ownership.test.ts` and `briefs.test.ts` carry an explicit budget. On a real server
    // (TEST_PG_URL) this is a 110 ms template clone.
  }, 30_000);

  test("req 3: --org on the FILE STORES refuses, whatever DATABASE_URL says", async () => {
    setEnv("fs");
    const spy = spyClient();
    setDatabase(spy);

    expect(await resolveSource(flags({ org: "local" }))).toEqual({
      ok: false,
      reason:
        '--org "local" needs STORE_BACKEND=postgres: the file stores have no org row to ' +
        "check it against.",
    });
    expect(spy.query).not.toHaveBeenCalled();
  });

  test("req 4: a MISSING --switched-at refuses with its own message", async () => {
    expect(SWITCHED_AT_REQUIRED).toBe("--switched-at <iso> is required");
    expect(await resolveSource({ includeSamples: false })).toEqual({
      ok: false,
      reason: SWITCHED_AT_REQUIRED,
    });
  });

  test("req 4: an UN-PARSEABLE --switched-at refuses with a DIFFERENT message", async () => {
    const reason = '--switched-at <iso> is not a valid date: "the day before"';
    expect(await resolveSource({ includeSamples: false, switchedAt: "the day before" })).toEqual({
      ok: false,
      reason,
    });
    // Two mistakes, two fixes, two messages. With one message the operator cannot tell
    // "you forgot the flag" from "you meant something else by it".
    expect(reason).not.toBe(SWITCHED_AT_REQUIRED);
  });

  test("req 4: a valid --switched-at is parsed ONCE into a Date on the context", async () => {
    const outcome = await resolveSource(flags());

    expect(outcome).toMatchObject({
      ok: true,
      source: {
        // Verbatim, so `plan`'s header echoes the string a reviewer checks against the
        // deploy log rather than a re-serialised Date (`bin/__tests__/import.test.ts`
        // asserts the header carries this same string).
        switchedAtIso: SWITCHED_AT,
        ctx: { switchedAt: new Date(SWITCHED_AT) },
      },
    });
    const ctx = outcome.ok ? outcome.source.ctx : undefined;
    // The Date PT-8a0's `StepContext` types, with the one method a later step needs.
    expect(ctx?.switchedAt.getTime()).toBe(Date.parse(SWITCHED_AT));
  });

  test("req 4: --switched-at is asked BEFORE the roots, so a missing flag names itself", async () => {
    expect(
      await resolveSource(flags({ switchedAt: undefined, projectRoot: join(root, "gone") })),
    ).toEqual({ ok: false, reason: SWITCHED_AT_REQUIRED });
  });
});

describe("probeTarget (PT-8a req 5, D225)", () => {
  beforeEach(() => {
    setEnv("fs");
    setDatabase(spyClient());
  });

  afterEach(() => {
    resetDatabase();
    restoreEnv();
  });

  test("req 5: the fs-only branch names its backend and issues ZERO queries", async () => {
    const spy = spyClient();
    setDatabase(spy);

    expect(await probeTarget("local", false)).toEqual({ ok: true, backend: "fs-only" });
    // The whole claim of this branch: there is no row behind a file store to confirm, so
    // nothing is asked. A stray query here would make "read-only" mean "harmless".
    expect(spy.query).not.toHaveBeenCalled();
    expect(spy.exec).not.toHaveBeenCalled();
    expect(spy.transaction).not.toHaveBeenCalled();
  });

  test("req 5: postgres with no DATABASE_URL refuses naming the org", async () => {
    process.env["STORE_BACKEND"] = "postgres";
    delete process.env["DATABASE_URL"];

    expect(await probeTarget("local", false)).toEqual({
      ok: false,
      reason: 'no database is configured to probe org "local": DATABASE_URL is not set.',
    });
  });

  test("req 5: against a REAL database the probe finds the seeded org and refuses a missing one", async () => {
    setEnv("postgres");
    const db = await migratedDatabase();
    setDatabase(db);
    try {
      // `0001_org.sql:13` seeds exactly one row, and the probe must find THAT row rather
      // than a row some earlier test put there. The count is asserted so a probe that
      // "found" `local` by inventing an answer could not pass.
      expect(await probeTarget("local", false)).toEqual({ ok: true, backend: "postgres" });
      expect(await probeTarget("nope", true)).toEqual({
        ok: false,
        reason: 'no org "nope" exists in the target database.',
      });
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from org");
      expect(rows[0]).toMatchObject({ n: 1 });
    } finally {
      resetDatabase();
      await db.end();
    }
    // The PGlite budget, for the same reason as the test above.
  }, 30_000);
});
