import { describe, expect, test } from "vitest";
import { DEFAULT_STALL_SECS, parseFollowArgs, parseUsageArgs } from "../lib/args.js";
import { LANE_WATCH_USAGE } from "../lib/usage-text.js";

const SERVER = "http://127.0.0.1:4096";
const SESSION = "ses_abc123";

describe("parseUsageArgs", () => {
  test("reads the server, the session, and nothing else", () => {
    expect(parseUsageArgs(["--server", SERVER, "--session", SESSION])).toEqual({
      command: "usage",
      server: SERVER,
      session: SESSION,
      json: false,
      emit: null,
    });
  });

  test("--json asks for the record rather than the line", () => {
    expect(parseUsageArgs(["--server", SERVER, "--session", SESSION, "--json"]).json).toBe(true);
  });

  test("--emit takes its four operands positionally, and settles by default", () => {
    expect(
      parseUsageArgs([
        "--server",
        SERVER,
        "--session",
        SESSION,
        "--emit",
        "/tmp/wave-1",
        "wave-1",
        "HXF4",
        "implement",
      ]),
    ).toEqual({
      command: "usage",
      server: SERVER,
      session: SESSION,
      json: false,
      emit: {
        logdir: "/tmp/wave-1",
        wave: "wave-1",
        lane: "HXF4",
        stage: "implement",
        event: "settled",
      },
    });
  });

  test("--event overrides the default, and may come before or after --emit", () => {
    const after = parseUsageArgs([
      "--server",
      SERVER,
      "--session",
      SESSION,
      "--emit",
      "/tmp/wave-1",
      "wave-1",
      "HXF4",
      "implement",
      "--event",
      "failed",
    ]);
    const before = parseUsageArgs([
      "--event",
      "failed",
      "--server",
      SERVER,
      "--session",
      SESSION,
      "--emit",
      "/tmp/wave-1",
      "wave-1",
      "HXF4",
      "implement",
    ]);
    expect(after.emit?.event).toBe("failed");
    expect(before.emit?.event).toBe("failed");
  });

  test("refuses a command line it cannot act on, each with the usage line", () => {
    const rejected: readonly string[][] = [
      [], // no --server, no --session
      ["--session", SESSION], // no --server
      ["--server", SERVER], // no --session
      ["--server"], // starved
      ["--server", "--session", SESSION], // the value looks like the next flag
      ["--server", SERVER, "--session", SESSION, "--emit"], // --emit with no operands
      ["--server", SERVER, "--session", SESSION, "--emit", "/tmp", "wave-1", "HXF4"], // one short
      ["--server", SERVER, "--session", SESSION, "--event"], // starved
      ["--server", SERVER, "--session", SESSION, "--event", "failed"], // --event with no --emit
      ["--server", SERVER, "--session", SESSION, "--nope"], // unknown
    ];
    for (const argv of rejected) {
      expect(() => parseUsageArgs(argv), argv.join(" ")).toThrow(LANE_WATCH_USAGE);
    }
  });
});

describe("parseFollowArgs", () => {
  test("defaults the stall to the row's 600 seconds", () => {
    expect(parseFollowArgs(["--server", SERVER, "--session", SESSION])).toEqual({
      command: "follow",
      server: SERVER,
      session: SESSION,
      stallSecs: DEFAULT_STALL_SECS,
    });
    expect(DEFAULT_STALL_SECS).toBe(600);
  });

  test("--stall is read in seconds", () => {
    expect(
      parseFollowArgs(["--server", SERVER, "--session", SESSION, "--stall", "30"]).stallSecs,
    ).toBe(30);
  });

  test("refuses a stall that is not a whole number of seconds", () => {
    expect(() =>
      parseFollowArgs(["--server", SERVER, "--session", SESSION, "--stall", "30s"]),
    ).toThrow("whole number of seconds");
  });

  test("refuses a command line it cannot act on, each with the usage line", () => {
    const rejected: readonly string[][] = [
      [],
      ["--session", SESSION],
      ["--server", SERVER],
      ["--server", SERVER, "--session", SESSION, "--stall"],
      ["--server", SERVER, "--session", SESSION, "--json"], // a usage-only flag
      ["--server", SERVER, "--session", SESSION, "--nope"],
    ];
    for (const argv of rejected) {
      expect(() => parseFollowArgs(argv), argv.join(" ")).toThrow(LANE_WATCH_USAGE);
    }
  });
});
