import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, WAVE_EVENT_SCRIPT, emit, emitArgv } from "../lib/emit.js";
import { fail, ok, runnerFor } from "./fixtures.js";

const TARGET = { wave: "wave-hardening-w06", lane: "HXF11-lane-verify" };
const DETAIL = { steps: [{ step: "tests", exit: 0, key: "1 passed" }], verified: "2222" };

describe("emitArgv", () => {
  test("is the script's own order, with the stage this tool writes", () => {
    expect(emitArgv(TARGET, null, "settled", DETAIL)).toEqual([
      "wave-hardening-w06",
      "HXF11-lane-verify",
      "gate",
      "settled",
      "--detail",
      JSON.stringify(DETAIL),
    ]);
  });

  test("--logdir is passed only when one was given, never invented", () => {
    expect(emitArgv(TARGET, "/logs/w06", "failed", DETAIL).slice(0, 2)).toEqual([
      "--logdir",
      "/logs/w06",
    ]);
    expect(emitArgv(TARGET, null, "failed", DETAIL).slice(0, 2)).not.toContain("--logdir");
  });

  test("the detail is compact, because the script validates it with json.loads", () => {
    expect(emitArgv(TARGET, null, "settled", DETAIL).at(-1)).toBe(
      '{"steps":[{"step":"tests","exit":0,"key":"1 passed"}],"verified":"2222"}',
    );
  });
});

describe("the paths emit resolves", () => {
  test("the script and the repo root come from THIS module's URL, never the cwd", () => {
    // Three levels up from tools/lane-verify/lib is the repository root, so the
    // script is reached through it rather than through whatever directory the
    // operator happened to be standing in — which for this tool is a lane
    // worktree, and whose branch is the thing being verified.
    expect(WAVE_EVENT_SCRIPT).toBe(`${REPO_ROOT}scripts/wave-event.sh`);
    expect(REPO_ROOT.endsWith("/")).toBe(true);
    expect(REPO_ROOT).toBe(fileURLToPath(new URL("../../..", import.meta.url)));
  });
});

describe("emit", () => {
  test("runs the script in this repo, not in the worktree being verified", async () => {
    const { run, calls } = runnerFor({
      [`sh ${WAVE_EVENT_SCRIPT} ${emitArgv(TARGET, null, "settled", DETAIL).join(" ")}`]: ok(),
    });
    expect(await emit(TARGET, null, "settled", DETAIL, { run, logError: () => undefined })).toBe(0);
    expect(calls[0]?.command).toBe("sh");
    expect(calls[0]?.cwd).toBe(REPO_ROOT);
  });

  test("the script's own exit code stands, so a refused event is not a green gate", async () => {
    const { run } = runnerFor({
      [`sh ${WAVE_EVENT_SCRIPT} ${emitArgv(TARGET, null, "settled", DETAIL).join(" ")}`]: fail(
        2,
        "",
        "invalid stage: gate\n",
      ),
    });
    expect(await emit(TARGET, null, "settled", DETAIL, { run, logError: () => undefined })).toBe(2);
  });

  test("the script's reason on stderr is relayed, because it is the only copy of it", async () => {
    const seen: string[] = [];
    const { run } = runnerFor({
      [`sh ${WAVE_EVENT_SCRIPT} ${emitArgv(TARGET, null, "failed", DETAIL).join(" ")}`]: fail(
        2,
        "",
        "invalid lane: HXF11\n",
      ),
    });
    await emit(TARGET, null, "failed", DETAIL, { run, logError: (text) => seen.push(text) });
    expect(seen).toEqual(["wave-event.sh: invalid lane: HXF11"]);
  });

  test("a script that could not be launched is a failure, and it names the launch", async () => {
    const seen: string[] = [];
    const { run } = runnerFor({});
    expect(
      await emit(TARGET, null, "settled", DETAIL, { run, logError: (text) => seen.push(text) }),
    ).toBe(1);
    expect(seen[0]).toMatch(/wave-event\.sh could not be run: no scripted answer/);
  });
});
