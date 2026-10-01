import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { runCli, type LaneWatchCliIo } from "../cli.js";
import { WAVE_EVENT_SCRIPT } from "../lib/emit.js";
import { ALLOWED_PATHS, SESSION_ID } from "../lib/server.js";
import { fetchStub, json, spawnStub } from "./fixtures.js";

const SERVER = "http://127.0.0.1:4096";
const SESSION = "ses_abc123";

afterEach(() => {
  vi.useRealTimers();
});

/** A session body with every field the row names present and reporting. */
const COMPLETE = {
  time: { created: 1_700_000_000_000, updated: 1_700_000_061_999 },
  tokens: { input: 1200, output: 340, reasoning: 90, cache: { read: 80, write: 7 } },
  cost: 0.4213,
  title: "HXF4 lane:watch",
  directory: "/repo/.worktrees/cf-hxf4",
};

interface Harness {
  readonly io: LaneWatchCliIo;
  readonly log: string[];
  readonly err: string[];
  readonly fetchCalls: {
    readonly pathname: string;
    readonly method: string;
    readonly redirect: string;
    readonly signal: AbortSignal;
  }[];
  readonly spawnCalls: { readonly command: string; readonly args: readonly string[] }[];
}

function harness(
  argv: readonly string[],
  answers: Parameters<typeof fetchStub>[0],
  spawnAnswers: Parameters<typeof spawnStub>[0] = [{ code: 0, stderr: "" }],
): Harness {
  const log: string[] = [];
  const err: string[] = [];
  const stub = fetchStub(answers);
  const spawned = spawnStub(spawnAnswers);
  return {
    log,
    err,
    fetchCalls: stub.calls,
    spawnCalls: spawned.calls,
    io: {
      argv,
      log: (text) => log.push(text),
      logError: (text) => err.push(text),
      fetch: stub.fetch,
      spawn: spawned.spawn,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      reconnectDelayMs: 0,
    },
  };
}

const usageArgv = (extra: readonly string[] = []): readonly string[] => [
  "usage",
  "--server",
  SERVER,
  "--session",
  SESSION,
  ...extra,
];

describe("lane:watch usage", () => {
  test("renders every field the row names, on one line", async () => {
    const h = harness(usageArgv(), [json(COMPLETE)]);
    expect(await runCli(h.io)).toBe(0);
    expect(h.log).toEqual([
      "secs=61 tokens_in=1200 tokens_out=340 reasoning=90 cache_read=80 cache_write=7 " +
        'cost=0.4213 title="HXF4 lane:watch" directory="/repo/.worktrees/cf-hxf4"',
    ]);
    expect(h.err).toEqual([]);
  });

  test("--json round-trips: the record parses back, and the line agrees with it", async () => {
    const record = await (async () => {
      const h = harness(usageArgv(["--json"]), [json(COMPLETE)]);
      expect(await runCli(h.io)).toBe(0);
      expect(h.log).toHaveLength(1);
      return JSON.parse(h.log[0]) as Record<string, unknown>;
    })();
    expect(record).toEqual({
      secs: 61,
      tokens_in: 1200,
      tokens_out: 340,
      reasoning: 90,
      cache_read: 80,
      cache_write: 7,
      cost: 0.4213,
      title: "HXF4 lane:watch",
      directory: "/repo/.worktrees/cf-hxf4",
    });
    // The round trip is only real if the human line and the JSON are the same
    // value seen twice, so the line is checked against the parsed record.
    const line = harness(usageArgv(), [json(COMPLETE)]);
    expect(await runCli(line.io)).toBe(0);
    for (const [key, value] of Object.entries(record)) {
      expect(line.log[0], key).toContain(`${key}=${JSON.stringify(value) ?? value}`);
    }
  });

  test("secs floors the milliseconds, never rounds them up", async () => {
    // 1_700_000_061_999 − 1_700_000_000_000 is 61.999s. A lane that ran 61.999
    // seconds ran 61 seconds, and a watcher billing in whole seconds must not
    // claim 62.
    const h = harness(usageArgv(["--json"]), [json(COMPLETE)]);
    expect(await runCli(h.io)).toBe(0);
    expect(JSON.parse(h.log[0]).secs).toBe(61);
  });

  test("a 404 exits 1 and names the session", async () => {
    const body = { name: "NotFoundError", data: { message: `Session not found: ${SESSION}` } };
    const h = harness(usageArgv(), [json(body, 404)]);
    expect(await runCli(h.io)).toBe(1);
    expect(h.log).toEqual([]);
    expect(h.err.join("\n")).toContain(`no such session: ${SESSION}`);
  });

  test("a missing tokens or cost exits 3 and prints null, never a guessed 0", async () => {
    // scripts/lane-usage.sh reads these columns out of opencode's SQLite and
    // prints 0 for a row that is not there yet, which is how a lane that has
    // billed nothing came to look identical to one that has not billed yet.
    const cases: readonly {
      readonly drop: readonly string[];
      readonly named: string;
      readonly nullKeys: readonly string[];
    }[] = [
      {
        drop: ["tokens"],
        named: "tokens",
        nullKeys: ["tokens_in", "tokens_out", "reasoning", "cache_read", "cache_write"],
      },
      { drop: ["cost"], named: "cost", nullKeys: ["cost"] },
      {
        drop: ["tokens", "cost"],
        named: "tokens and cost",
        nullKeys: ["tokens_in", "cache_write", "cost"],
      },
    ];
    for (const { drop, named, nullKeys } of cases) {
      const body: Record<string, unknown> = { ...COMPLETE };
      for (const key of drop) delete body[key];
      const h = harness(usageArgv(["--json"]), [json(body)]);
      expect(await runCli(h.io), named).toBe(3);
      const record = JSON.parse(h.log[0]) as Record<string, unknown>;
      for (const key of nullKeys) expect(record[key], `${named}/${key}`).toBeNull();
      // The fields the server DID report survive on the same record.
      expect(record.secs, named).toBe(61);
      expect(h.err.join("\n"), named).toContain(`did not report ${named}`);
    }
    // A body with neither time nor totals is the thinnest a session can be.
    const h = harness(usageArgv(["--json"]), [json({ title: "t" })]);
    expect(await runCli(h.io)).toBe(3);
    expect(JSON.parse(h.log[0])).toMatchObject({ tokens_in: null, cost: null, secs: null });
  });

  test("a session with no time reports secs as null rather than NaN", async () => {
    const h = harness(usageArgv(["--json"]), [json({ ...COMPLETE, time: undefined })]);
    expect(await runCli(h.io)).toBe(0);
    expect(JSON.parse(h.log[0]).secs).toBeNull();
  });

  test("a tokens object with no cache block is INCOMPLETE, not a reading", async () => {
    // This expectation FLIPPED in fix round 2, deliberately. Testing only that
    // the top-level `tokens` object existed let a record printed with two null
    // cache counters exit 0 — and with `--emit` that reading was appended to
    // the wave as a clean `settled` event under a success code. A count the
    // server did not report is unreported, whatever object it sits in.
    const body = { ...COMPLETE, tokens: { input: 10, output: 20, reasoning: 0 } };
    const h = harness(usageArgv(["--json"]), [json(body)]);
    expect(await runCli(h.io)).toBe(3);
    // What the server DID report still survives on the record.
    expect(JSON.parse(h.log[0])).toMatchObject({
      tokens_in: 10,
      tokens_out: 20,
      reasoning: 0,
      cache_read: null,
      cache_write: null,
      cost: 0.4213,
    });
    // The message names the counts, not the object, because the object was
    // there — the two numbers inside it were not.
    expect(h.err.join("\n")).toContain("did not report tokens.cache.read and tokens.cache.write");
  });

  test("a missing time leaves secs null but does NOT make the reading incomplete", async () => {
    // The row names only tokens and cost for exit 3. A session whose clock the
    // server has not published is a missing DURATION, not a missing total —
    // refusing to report the totals over it would discard a reading that is
    // otherwise complete.
    const body = { ...COMPLETE, time: undefined };
    const h = harness(usageArgv(["--json"]), [json(body)]);
    expect(await runCli(h.io)).toBe(0);
    expect(JSON.parse(h.log[0])).toMatchObject({ secs: null, tokens_in: 1200, cost: 0.4213 });
    expect(h.err.join("\n")).not.toContain("did not report");
  });

  test("a null tokens, or a null cost, is unreported rather than a success", async () => {
    // `=== undefined` did not catch either, so a server sending `null` for
    // them produced a record printed as null and an exit 0.
    for (const [field, value, named] of [
      ["tokens", null, "tokens"],
      ["cost", null, "cost"],
    ] as const) {
      const body: Record<string, unknown> = { ...COMPLETE, [field]: value };
      const h = harness(usageArgv(["--json"]), [json(body)]);
      expect(await runCli(h.io), named).toBe(3);
      expect(h.err.join("\n"), named).toContain(`did not report ${named}`);
    }
  });

  test("a session with no title and no directory reports them as empty, not as text", async () => {
    const body = { ...COMPLETE, title: undefined, directory: undefined };
    const h = harness(usageArgv(["--json"]), [json(body)]);
    expect(await runCli(h.io)).toBe(0);
    expect(JSON.parse(h.log[0])).toMatchObject({ title: "", directory: "" });
  });

  test("a body that is JSON but not a session object is a failed read", async () => {
    // Unusable, not incomplete. `null` threw and exited 2, telling the
    // operator their command line was wrong; a number, string or array fell
    // through to exit 3 as though the server had reported a tokenless session.
    // All three are the server's fault and are reported as a failed read.
    for (const [what, body] of [
      ["null", null],
      ["a number", 42],
      ["a string", "not a session"],
      ["an array", [1, 2, 3]],
    ] as const) {
      const h = harness(usageArgv(), [json(body)]);
      expect(await runCli(h.io), what).toBe(1);
      expect(h.log, what).toEqual([]);
      expect(h.err.join("\n"), what).toContain("did not return a session object");
    }
  });

  test("a read that fails, or a body that is not JSON, exits 1", async () => {
    const failed = harness(usageArgv(), [{ reject: new Error("tunnel refused") }]);
    expect(await runCli(failed.io)).toBe(1);
    expect(failed.err.join("\n")).toContain("tunnel refused");

    const broken = harness(usageArgv(), [new Response("<html>", { status: 200 })]);
    expect(await runCli(broken.io)).toBe(1);
    expect(broken.err.join("\n")).toContain("did not return JSON");

    const server = harness(usageArgv(), [json({}, 500)]);
    expect(await runCli(server.io)).toBe(1);
    expect(server.err.join("\n")).toContain("answered 500");
  });

  test("a non-loopback --server is refused before any request is made", async () => {
    for (const server of ["http://example.com:4096", "http://10.0.0.5:4096"]) {
      const h = harness(["usage", "--server", server, "--session", SESSION], [json(COMPLETE)]);
      expect(await runCli(h.io), server).toBe(2);
      expect(h.fetchCalls, server).toEqual([]);
      expect(h.err.join("\n"), server).toContain("ocm tunnel");
    }
  });

  test("an https --server, or one that is not a URL at all, is refused", async () => {
    const secure = harness(
      ["usage", "--server", "https://127.0.0.1:4096", "--session", SESSION],
      [json(COMPLETE)],
    );
    expect(await runCli(secure.io)).toBe(2);
    expect(secure.err.join("\n")).toContain("must be http://");

    const nonsense = harness(
      ["usage", "--server", "127.0.0.1:4096", "--session", SESSION],
      [json(COMPLETE)],
    );
    expect(await runCli(nonsense.io)).toBe(2);
    expect(nonsense.err.join("\n")).toContain("is not a URL");
  });

  test("a session id that is not ses_… is refused before any request is made", async () => {
    for (const session of ["abc", "ses_", "ses_a-b", "SES_abc", "ses_a/b", "../ses_abc"]) {
      const h = harness(["usage", "--server", SERVER, "--session", session], [json(COMPLETE)]);
      expect(await runCli(h.io), session).toBe(2);
      expect(h.fetchCalls, session).toEqual([]);
      expect(h.err.join("\n"), session).toContain(SESSION_ID.source);
    }
  });

  test("every request is a GET, refuses redirects, and names an allowlisted path", async () => {
    const h = harness(usageArgv(), [json(COMPLETE)]);
    expect(await runCli(h.io)).toBe(0);
    expect(h.fetchCalls.length).toBeGreaterThan(0);
    for (const call of h.fetchCalls) {
      expect(call.method).toBe("GET");
      expect(call.redirect).toBe("error");
      expect(ALLOWED_PATHS.test(call.pathname)).toBe(true);
      expect(call.pathname).toBe(`/session/${SESSION}`);
    }
  });
});

describe("lane:watch usage --emit", () => {
  // `--json` throughout, so the printed record and the emitted `--detail` can
  // be compared byte for byte: the wave log and the operator's terminal must
  // hold one value.
  const emitArgv = (extra: readonly string[] = []): readonly string[] => [
    ...usageArgv(["--json", "--emit", "/tmp/wave-1", "wave-1", "HXF4", "implement", ...extra]),
  ];

  test("runs wave-event.sh with exactly the documented argv, and the detail is compact", async () => {
    const h = harness(emitArgv(), [json(COMPLETE)]);
    expect(await runCli(h.io)).toBe(0);
    expect(h.spawnCalls).toHaveLength(1);
    const call = h.spawnCalls[0];
    expect(call.command).toBe("sh");
    const [script, ...args] = call.args;
    // Resolved from this repo's own import.meta.url, so it is the repo's
    // script and not whatever the operator's cwd happens to point at. The stat
    // is what pins the `../` DEPTH: a wrong count still ends in
    // `…/scripts/wave-event.sh` as a string, and only existsSync notices that
    // the file it names is not there. A stat, not a spawn — nothing runs.
    expect(script).toBe(WAVE_EVENT_SCRIPT);
    expect(existsSync(WAVE_EVENT_SCRIPT)).toBe(true);
    expect(args.slice(0, 7)).toEqual([
      "--logdir",
      "/tmp/wave-1",
      "wave-1",
      "HXF4",
      "implement",
      "settled",
      "--detail",
    ]);
    expect(args[7]).toBe(h.log[0]);
    // wave-event.sh rejects a --detail carrying spaces, so compactness is a
    // contract with the script rather than a style preference.
    expect(args[7]).not.toMatch(/[:,]\s/);
  });

  test("--json --emit keeps stdout as exactly one JSON value", async () => {
    // The confirmation is a diagnostic, so it belongs on stderr. On stdout it
    // made `lane:watch usage --json --emit … | jq` fail on a SUCCESSFUL run,
    // which is the one case where nobody expects a parse error.
    const h = harness(emitArgv(), [json(COMPLETE)]);
    expect(await runCli(h.io)).toBe(0);
    expect(() => JSON.parse(h.log.join("\n"))).not.toThrow();
    expect(h.log).toHaveLength(1);
    expect(h.err.join("\n")).toContain("emitted settled for HXF4 at implement");
  });

  test("--event failed is passed through to the script, which owns that list", async () => {
    const h = harness(emitArgv(["--event", "failed"]), [json(COMPLETE)]);
    expect(await runCli(h.io)).toBe(0);
    expect(h.spawnCalls[0].args).toContain("failed");
  });

  test("a wave-event.sh that exits 2 relays its stderr and its exit code", async () => {
    // The stage list lives in the script, not here. An unknown stage therefore
    // answers with the script's own reason, and no second copy of the list
    // exists in this tool to drift out of step with it.
    const h = harness(
      emitArgv(["--event", "nonsense"]),
      [json(COMPLETE)],
      [
        {
          code: 2,
          stderr: "unknown event: nonsense — stage is one of: plan-review dispatch implement\n",
        },
      ],
    );
    expect(await runCli(h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("unknown event: nonsense");
  });

  test("a spawn that cannot run at all is 1, and says so", async () => {
    const h = harness(emitArgv(), [json(COMPLETE)], [new Error("spawn sh ENOENT")]);
    expect(await runCli(h.io)).toBe(1);
    expect(h.err.join("\n")).toContain("spawn sh ENOENT");
  });

  test("an incomplete usage is still emitted, with its missing fields as null", async () => {
    // The lane that errored before billing anything is the one whose timing
    // matters most, and it is exactly the reading that is incomplete. The
    // detail carries JSON `null` for what the server did not report and keeps
    // `secs` — never the string "unknown", and never a 0 — so a reader can
    // tell "not reported" from "nothing spent".
    for (const event of ["settled", "failed"]) {
      const body = { ...COMPLETE };
      delete (body as Record<string, unknown>)["tokens"];
      const h = harness(emitArgv(event === "failed" ? ["--event", "failed"] : []), [json(body)]);
      expect(await runCli(h.io), event).toBe(3);
      expect(h.spawnCalls, event).toHaveLength(1);
      expect(h.spawnCalls[0].args, event).toContain(event);
      // args[0] is the script itself; --detail is args[7] and its value args[8].
      const detail = h.spawnCalls[0].args[8] as string;
      expect(detail, event).toBe(h.log[0]);
      expect(JSON.parse(detail), event).toMatchObject({
        secs: 61,
        tokens_in: null,
        cost: 0.4213,
      });
    }
  });

  test("a script that refuses the event outranks the incomplete reading", async () => {
    // 2 (the script refused the stage) is more specific than 3 (the reading
    // was incomplete), so it is the code the operator sees.
    const body = { ...COMPLETE };
    delete (body as Record<string, unknown>)["cost"];
    const h = harness(
      emitArgv(["--event", "nonsense"]),
      [json(body)],
      [{ code: 2, stderr: "unknown event: nonsense\n" }],
    );
    expect(await runCli(h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("unknown event: nonsense");
  });

  test("a missing session is not emitted either", async () => {
    const h = harness(emitArgv(), [json({}, 404)]);
    expect(await runCli(h.io)).toBe(1);
    expect(h.spawnCalls).toEqual([]);
  });
});
