import { describe, expect, test } from "vitest";
import { defaultLogDir } from "../logdir.js";

/** `exists` backed by a fixed set of paths — every candidate not listed reads as absent. */
const existsIn =
  (paths: readonly string[]) =>
  (path: string): boolean =>
    paths.includes(path);

const NONE = existsIn([]);

describe("defaultLogDir", () => {
  test("no env: root is /tmp/.waves, and with nothing on disk the wave-prefixed default wins", () => {
    expect(defaultLogDir("w06", {}, NONE)).toBe("/tmp/.waves/wave-w06");
  });

  test("HOME sets the default root", () => {
    expect(defaultLogDir("w06", { HOME: "/Users/op" }, NONE)).toBe("/Users/op/.waves/wave-w06");
  });

  test("WAVE_LOG_ROOT overrides HOME entirely", () => {
    expect(defaultLogDir("w06", { HOME: "/Users/op", WAVE_LOG_ROOT: "/srv/waves" }, NONE)).toBe(
      "/srv/waves/wave-w06",
    );
  });

  test("a wave id already starting with 'wave' defaults to root/<wave>, not root/wave-<wave>", () => {
    expect(defaultLogDir("wave-hardening-w06", { HOME: "/h" }, NONE)).toBe(
      "/h/.waves/wave-hardening-w06",
    );
  });

  test("root/wave-<wave> existing wins outright — the first candidate", () => {
    const exists = existsIn(["/h/.waves/wave-w06"]);
    expect(defaultLogDir("w06", { HOME: "/h" }, exists)).toBe("/h/.waves/wave-w06");
  });

  test("root/wave<wave> (no dash) wins when the dashed form is absent", () => {
    const exists = existsIn(["/h/.waves/wavew06"]);
    expect(defaultLogDir("w06", { HOME: "/h" }, exists)).toBe("/h/.waves/wavew06");
  });

  test("root/<wave> only competes when wave itself already starts with 'wave'", () => {
    const exists = existsIn(["/h/.waves/wave-hardening-w06"]);
    expect(defaultLogDir("wave-hardening-w06", { HOME: "/h" }, exists)).toBe(
      "/h/.waves/wave-hardening-w06",
    );
  });

  test("a plain wave id never matches the bare root/<wave> candidate, even if it exists", () => {
    // "w06" does not start with "wave", so /h/.waves/w06 is never tried —
    // existence there must not be picked up.
    const exists = existsIn(["/h/.waves/w06"]);
    expect(defaultLogDir("w06", { HOME: "/h" }, exists)).toBe("/h/.waves/wave-w06");
  });

  test("/tmp/wave-<wave> wins once every root candidate is absent", () => {
    const exists = existsIn(["/tmp/wave-w06"]);
    expect(defaultLogDir("w06", { HOME: "/h" }, exists)).toBe("/tmp/wave-w06");
  });

  test("/tmp/wave<wave> wins after /tmp/wave-<wave>", () => {
    const exists = existsIn(["/tmp/wavew06"]);
    expect(defaultLogDir("w06", { HOME: "/h" }, exists)).toBe("/tmp/wavew06");
  });

  test("/tmp/<wave> is the last candidate, and only for a wave id already prefixed", () => {
    const exists = existsIn(["/tmp/wave-hardening-w06"]);
    expect(defaultLogDir("wave-hardening-w06", { HOME: "/h" }, exists)).toBe(
      "/tmp/wave-hardening-w06",
    );
  });

  test("candidate priority: an earlier candidate wins even when a later one also exists", () => {
    const exists = existsIn(["/h/.waves/wave-w06", "/tmp/wave-w06"]);
    expect(defaultLogDir("w06", { HOME: "/h" }, exists)).toBe("/h/.waves/wave-w06");
  });

  test("nothing exists and the wave id does not start with 'wave': default is root/wave-<wave>", () => {
    expect(defaultLogDir("w06", { HOME: "/h" }, NONE)).toBe("/h/.waves/wave-w06");
  });

  test("LOGDIR wins outright — wave-event.sh:41 reads it before any candidate search", () => {
    expect(defaultLogDir("w06", { LOGDIR: "/custom/wave-log" }, NONE)).toBe("/custom/wave-log");
  });

  test("LOGDIR wins even over WAVE_LOG_ROOT and an existing candidate", () => {
    const exists = existsIn(["/h/.waves/wave-w06"]);
    expect(
      defaultLogDir(
        "w06",
        { LOGDIR: "/custom/wave-log", HOME: "/h", WAVE_LOG_ROOT: "/srv/waves" },
        exists,
      ),
    ).toBe("/custom/wave-log");
  });

  test("LOGDIR set to the empty string is treated as unset — the candidate search still runs", () => {
    // wave-event.sh: LOGDIR="${LOGDIR:-}" then `[ -z "$LOGDIR" ]` — POSIX
    // ${VAR:-} substitutes on empty too, so an empty LOGDIR is unset in
    // every way wave-event.sh can tell.
    expect(defaultLogDir("w06", { LOGDIR: "", HOME: "/h" }, NONE)).toBe("/h/.waves/wave-w06");
  });

  test("LOGDIR never triggers an exists() call — it is not a candidate to verify", () => {
    let called = false;
    const exists = (): boolean => {
      called = true;
      return false;
    };
    defaultLogDir("w06", { LOGDIR: "/custom/wave-log" }, exists);
    expect(called).toBe(false);
  });
});
