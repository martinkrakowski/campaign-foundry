import { describe, expect, test } from "vitest";
import { SWEEP_USAGE, parseSweepArgs } from "../lib/args.js";

const argv = (extra: readonly string[] = []): string[] => [
  "--pr",
  "361",
  "--thread",
  "PRRT_kwDOT361",
  "--body",
  "the class text",
  ...extra,
];

describe("parseSweepArgs", () => {
  test("the happy path: pr, one thread, inline body, no --post", () => {
    expect(parseSweepArgs(argv())).toEqual({
      pr: 361,
      threadIds: ["PRRT_kwDOT361"],
      body: { text: "the class text" },
      post: false,
    });
  });

  test("collects every --thread, in order", () => {
    const parsed = parseSweepArgs([
      "--pr",
      "9",
      "--thread",
      "PRRT_a",
      "--thread",
      "PRRT_b",
      "--thread",
      "PRRT_c",
      "--body",
      "x",
    ]);
    expect(parsed.threadIds).toEqual(["PRRT_a", "PRRT_b", "PRRT_c"]);
  });

  test("--post flips the sign-off flag", () => {
    expect(parseSweepArgs([...argv(), "--post"]).post).toBe(true);
  });

  test("--body-file carries a path, not text", () => {
    expect(parseSweepArgs(["--pr", "9", "--thread", "PRRT_a", "--body-file", "d.md"]).body).toEqual({
      file: "d.md",
    });
  });

  test("both body sources are refused", () => {
    expect(() =>
      parseSweepArgs(["--pr", "9", "--thread", "a", "--body", "x", "--body-file", "y"]),
    ).toThrow(/mutually exclusive/);
  });

  test("no body at all is refused", () => {
    expect(() => parseSweepArgs(["--pr", "9", "--thread", "a"])).toThrow(/body is required/);
  });

  test("a missing --pr is refused", () => {
    expect(() => parseSweepArgs(["--thread", "a", "--body", "x"])).toThrow(/--pr is required/);
  });

  test("a non-numeric --pr is refused", () => {
    expect(() => parseSweepArgs(["--pr", "abc", "--thread", "a", "--body", "x"])).toThrow(
      /wants a number/,
    );
  });

  test("no --thread is refused — a class of zero resolves nothing", () => {
    expect(() => parseSweepArgs(["--pr", "9", "--body", "x"])).toThrow(/at least one --thread/);
  });

  test("an option starved of its value is refused", () => {
    for (const flag of ["--pr", "--thread", "--body", "--body-file"]) {
      expect(() => parseSweepArgs([flag])).toThrow(new RegExp(`missing value for ${flag}`));
    }
  });

  test("an unknown argument is refused, with the usage line", () => {
    const message = (() => {
      try {
        parseSweepArgs(["--pr", "9", "--yolo"]);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain("unknown argument '--yolo'");
    expect(message).toContain(SWEEP_USAGE);
  });
});
