import { afterEach, describe, expect, test, vi } from "vitest";
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

  test("a tokens object with no cache block reports the cache counters as null", async () => {
    // The cache counters are nested, so they can be absent while the tokens
    // object itself is present and reporting. That is a reading, not a
    // failure — exit 0 — and the two missing counters are null, not 0.
    const body = { ...COMPLETE, tokens: { input: 10, output: 20, reasoning: 0 } };
    const h = harness(usageArgv(["--json"]), [json(body)]);
    expect(await runCli(h.io)).toBe(0);
    expect(JSON.parse(h.log[0])).toMatchObject({
      tokens_in: 10,
      tokens_out: 20,
      reasoning: 0,
      cache_read: null,
      cache_write: null,
      cost: 0.4213,
    });
  });

  test("a session with no title and no directory reports them as empty, not as text", async () => {
    const body = { ...COMPLETE, title: undefined, directory: undefined };
    const h = harness(usageArgv(["--json"]), [json(body)]);
    expect(await runCli(h.io)).toBe(0);
    expect(JSON.parse(h.log[0])).toMatchObject({ title: "", directory: "" });
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
  const emitArgv = (extra: readonly string[] = []): readonly string[] => [
    ...usageArgv(["--emit", "/tmp/wave-1", "wave-1", "HXF4", "implement", ...extra]),
  ];

  test("runs wave-event.sh with exactly the documented argv, and the detail is compact", async () => {
    // --json so the printed record and the emitted detail can be compared byte
    // for byte: the wave log and the operator's terminal must hold one value.
    const h = harness(
      [...usageArgv(["--json"]), "--emit", "/tmp/wave-1", "wave-1", "HXF4", "implement"],
      [json(COMPLETE)],
    );
    expect(await runCli(h.io)).toBe(0);
    expect(h.spawnCalls).toHaveLength(1);
    const call = h.spawnCalls[0];
    expect(call.command).toBe("sh");
    const [script, ...args] = call.args;
    // Resolved from this repo's own import.meta.url, so it is the repo's
    // script and not whatever the operator's cwd happens to point at.
    expect(script).toBe(WAVE_EVENT_SCRIPT);
    expect(script?.endsWith("/scripts/wave-event.sh")).toBe(true);
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

  test("an incomplete usage is not emitted, and its exit code is passed through", async () => {
    // A `settled` event whose detail reads tokens: null would show the status
    // page a lane settled from a reading that said it knew nothing.
    const body = { ...COMPLETE };
    delete (body as Record<string, unknown>)["cost"];
    const h = harness(emitArgv(), [json(body)]);
    expect(await runCli(h.io)).toBe(3);
    expect(h.spawnCalls).toEqual([]);
  });

  test("a missing session is not emitted either", async () => {
    const h = harness(emitArgv(), [json({}, 404)]);
    expect(await runCli(h.io)).toBe(1);
    expect(h.spawnCalls).toEqual([]);
  });
});
