import { readFileSync, rmSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyCampaigns,
  describeResultRefusal,
  entryNotes,
  exitCodeFor,
  openResult,
  ResultWriter,
  type CampaignEntry,
  type MintRecorder,
} from "../apply.js";
import type { HashedContext } from "../campaign-step.js";
import type {
  FollowUpStep,
  ImportStep,
  MintedObject,
  RenderEntry,
  StepAddition,
  StepLine,
} from "../steps.js";

const SWITCHED_AT = "2026-10-01T00:00:00Z";
const CTX: HashedContext = {
  orgId: "local",
  switchedAt: new Date(SWITCHED_AT),
  projectRoot: "",
  outputRoot: "",
  includeSamples: false,
  fsOnly: false,
  expectedHashes: new Map(),
};
const CAMP = [{ slug: "camp", sourcePath: "x" }];
const A = { key: "org/local/campaign/c-1/renders/p1/1x1.png", path: "camp/p1/1x1.png" };
const B = { key: "org/local/campaign/c-1/renders/p1/9x16.mp4", path: "camp/p1/9x16.mp4" };
const C = { key: "org/local/campaign/c-1/renders/proofs/p1.pdf", path: "camp/proofs/p1.pdf" };
const REPORT_ROW = { kind: "report", status: "skipped", revision: "r1" } as const;
const POOL_ROW = { kind: "pool", status: "written", revision: "r2" } as const;

/** The campaign step of these tests: the campaign is there and nothing of it changed. */
const unchanged: ImportStep = async () => ({ outcome: "unchanged" });

/** A step that notes the line it was handed, then answers `added`. */
const noting =
  (lines: StepLine[], added: StepAddition): FollowUpStep =>
  async (...args) => {
    lines.push(args[2]);
    return added;
  };

/** A step that records each of `objects` as it goes, then answers `added`. */
const recording =
  (objects: readonly MintedObject[], added: StepAddition = { rows: [] }): FollowUpStep =>
  async (...args) => {
    for (const object of objects) await args[2].recordMinted(object);
    return added;
  };

/** Run the one campaign through `steps`; answers its line, every line, and the counts. */
async function run(
  steps: readonly FollowUpStep[],
  onMinted?: MintRecorder,
): Promise<{
  entry: CampaignEntry;
  entries: CampaignEntry[];
  counts: Awaited<ReturnType<typeof applyCampaigns>>;
}> {
  const entries: CampaignEntry[] = [];
  const counts = await applyCampaigns(
    CTX,
    CAMP,
    [unchanged, ...steps],
    async (entry) => {
      entries.push(entry);
    },
    onMinted,
  );
  return { entry: entries[0]!, entries, counts };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("applyCampaigns: what a follow-up step is handed", () => {
  test("a follow-up step is handed the rows the steps before it put on the line", async () => {
    const lines: StepLine[] = [];
    await run([
      noting(lines, { rows: [REPORT_ROW] }),
      noting(lines, { rows: [POOL_ROW] }),
      noting(lines, { rows: [] }),
    ]);
    expect(lines.map((line) => line.rows)).toEqual([[], [REPORT_ROW], [REPORT_ROW, POOL_ROW]]);
  });

  test("an object a step records goes to the recorder at once, with the campaign's slug, before the step goes on", async () => {
    const order: string[] = [];
    const onMinted: MintRecorder = async (slug, object) => {
      await sleep(5);
      order.push(`recorded ${slug} ${object.key}`);
    };
    const step: FollowUpStep = async (...args) => {
      for (const object of [A, B]) {
        order.push(`created ${object.path}`);
        await args[2].recordMinted(object);
      }
      return { rows: [] };
    };
    const { entry, counts } = await run([step], onMinted);
    expect(order).toEqual([
      `created ${A.path}`,
      `recorded camp ${A.key}`,
      `created ${B.path}`,
      `recorded camp ${B.key}`,
    ]);
    expect(entry.minted).toEqual({ assets: [], objects: [A, B] });
    expect(counts.objectsMinted).toBe(2);
    expect(entry.partial).toBeUndefined();
  });
});

describe("applyCampaigns: the objects a step records", () => {
  test("the objects several steps record join the line in order; without a recorder they still join it", async () => {
    const { entry, counts } = await run([recording([A]), recording([]), recording([B, C])]);
    expect(entry.minted).toEqual({ assets: [], objects: [A, B, C] });
    expect(counts.objectsMinted).toBe(3);
  });

  test("an object both recorded and answered at the step's end is listed and counted once; one only answered still counts", async () => {
    const step = recording([A], { rows: [], minted: { objects: [A, B] } });
    const { entry, counts } = await run([step]);
    expect(entry.minted).toEqual({ assets: [], objects: [A, B] });
    expect(counts.objectsMinted).toBe(2);
  });

  test("what a step recorded stays on the line and in the count when the step then throws", async () => {
    const dies: FollowUpStep = async (...args) => {
      await args[2].recordMinted(A);
      throw new Error("the store went away");
    };
    const after = vi.fn(async (): Promise<StepAddition> => ({ rows: [] }));
    const { entry, counts } = await run([dies, after]);
    expect(entry).toEqual({
      slug: "camp",
      outcome: "unchanged",
      partial: true,
      minted: { assets: [], objects: [A] },
      unreferencedInputs: { count: 0, names: [] },
      stepError: "the store went away",
    });
    expect(after).not.toHaveBeenCalled();
    expect(counts.objectsMinted).toBe(1);
    expect(counts.partial).toBe(true);
    // One campaign refused beside it: the run created an object, so 1, never 3.
    expect(exitCodeFor(counts, 1)).toBe(1);
  });
});

describe("applyCampaigns: a recorder that fails", () => {
  const FULL = "could not write the result file (ENOSPC)";
  const failing: MintRecorder = async () => {
    throw new Error(FULL);
  };
  const TWO = [...CAMP, { slug: "next", sourcePath: "y" }];

  test("a recorder that fails ends the run: the step's next write never happens, and no later step or campaign runs", async () => {
    const created: string[] = [];
    const step: FollowUpStep = async (...args) => {
      for (const object of [A, B]) {
        created.push(object.path);
        await args[2].recordMinted(object);
      }
      return { rows: [] };
    };
    const after = vi.fn(async (): Promise<StepAddition> => ({ rows: [] }));
    const entries: CampaignEntry[] = [];
    await expect(
      applyCampaigns(
        CTX,
        TWO,
        [unchanged, step, after],
        async (entry) => {
          entries.push(entry);
        },
        failing,
      ),
    ).rejects.toThrow(FULL);
    expect(created).toEqual([A.path]);
    expect(after).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });

  test("a step that swallows the recorder's failure cannot hide it: the run still ends before the next step", async () => {
    const swallows: FollowUpStep = async (...args) => {
      await args[2].recordMinted(A).catch(() => undefined);
      return { rows: [] };
    };
    const after = vi.fn(async (): Promise<StepAddition> => ({ rows: [] }));
    const entries: CampaignEntry[] = [];
    await expect(
      applyCampaigns(
        CTX,
        TWO,
        [unchanged, swallows, after],
        async (entry) => {
          entries.push(entry);
        },
        failing,
      ),
    ).rejects.toThrow(FULL);
    expect(after).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });
});

describe("applyCampaigns: the renders on a campaign's line", () => {
  const render = (status: RenderEntry["status"]): RenderEntry =>
    status === "refused" || status === "failed" || status === "missing"
      ? { path: A.path, status, reason: "why" }
      : { path: A.path, status, key: A.key };

  test("a render that is missing, refused or failed makes the line partial and the run exit 1; written, skipped and present leave it clean", async () => {
    for (const status of ["written", "skipped", "present"] as const) {
      const { entry, counts } = await run([async () => ({ rows: [], renders: [render(status)] })]);
      expect(entry.partial).toBeUndefined();
      expect(counts.partial).toBe(false);
      expect(exitCodeFor(counts, 0)).toBe(0);
    }
    for (const status of ["missing", "refused", "failed"] as const) {
      const { entry, counts } = await run([async () => ({ rows: [], renders: [render(status)] })]);
      expect(entry.partial).toBe(true);
      expect(counts.partial).toBe(true);
      expect(exitCodeFor(counts, 0)).toBe(1);
    }
  });

  test("the renders of every step join the line in order, and the report row stays as it was", async () => {
    const written = { kind: "report", status: "written", revision: "r1" } as const;
    const one: RenderEntry = { path: A.path, status: "written", key: A.key };
    const two: RenderEntry = { path: "camp/p1/4x5.png", status: "missing", key: "k/4x5" };
    const three: RenderEntry = { path: C.path, status: "skipped", key: C.key };
    const { entry, counts } = await run([
      async () => ({ rows: [written] }),
      async () => ({ rows: [], renders: [one, two] }),
      async () => ({ rows: [], renders: [three] }),
    ]);
    expect(entry.rows).toEqual([written]);
    expect(entry.renders).toEqual([one, two, three]);
    expect(entry.partial).toBe(true);
    expect(counts.rowsWritten).toBe(1);
    // A line whose steps answered no renders has no `renders` field at all.
    const none = await run([async () => ({ rows: [written] })]);
    expect("renders" in none.entry).toBe(false);
  });

  test("entryNotes prints one line per render, after the rows and before a step's error", () => {
    const entry: CampaignEntry = {
      slug: "camp",
      outcome: "created",
      minted: { assets: [] },
      unreferencedInputs: { count: 0, names: [] },
      rows: [{ kind: "report", status: "written", revision: "r1" }],
      renders: [
        { path: A.path, status: "written", key: A.key },
        { path: "camp/p1/4x5.png", status: "missing", key: "k/4x5" },
        { path: "other/x.png", status: "refused", reason: "not this campaign" },
      ],
      stepError: "a step blew up",
    };
    expect(entryNotes(entry)).toEqual([
      "  report: written",
      "  render camp/p1/1x1.png: written",
      "  render camp/p1/4x5.png: missing",
      "  render other/x.png: refused: not this campaign",
      "  a later step failed: a step blew up",
    ]);
  });
});

describe("ResultWriter: one line per created object", () => {
  const path = join(tmpdir(), `cf-apply-step-line-${process.pid}.jsonl`);
  afterEach(() => rmSync(path, { force: true }));
  const lines = (): Record<string, unknown>[] =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  test("each created object has its own line, on the file before the step goes on and before the campaign's line", async () => {
    const writer = new ResultWriter(await openResult(path), SWITCHED_AT, "local", "digest");
    await writer.header();
    const onFile: boolean[] = [];
    const step: FollowUpStep = async (...args) => {
      for (const object of [A, B]) {
        await args[2].recordMinted(object);
        onFile.push(readFileSync(path, "utf8").includes(`"key":"${object.key}"`));
      }
      return { rows: [] };
    };
    const counts = await applyCampaigns(
      CTX,
      CAMP,
      [unchanged, step],
      (entry) => writer.add(entry),
      (...told) => writer.object(told[1]),
    );
    expect(onFile).toEqual([true, true]);
    expect(lines().map((line) => line.kind)).toEqual(["header", "object", "object", "campaign"]);
    expect(lines()[1]).toEqual({ kind: "object", key: A.key, path: A.path });
    expect(lines()[2]).toEqual({ kind: "object", key: B.key, path: B.path });
    expect(lines()[3]).toMatchObject({ slug: "camp", minted: { assets: [], objects: [A, B] } });
    // No summary yet: this is what a run that died here leaves, and `apply` says so.
    expect(await describeResultRefusal(path)).toContain("it is the record of an interrupted run");
    await writer.summary(counts);
    await writer.close();
    expect(lines()[4]).toMatchObject({ kind: "summary", objectsMinted: 2 });
  });

  test("an object's line is synced to disk before `object` answers", async () => {
    const calls: string[] = [];
    const handle = {
      write: async (...args: [Buffer, number, number]) => {
        calls.push("write");
        return { bytesWritten: args[2] };
      },
      sync: async () => {
        calls.push("sync");
      },
    } as unknown as FileHandle;
    await new ResultWriter(handle, SWITCHED_AT, "local", "digest").object(A);
    expect(calls).toEqual(["write", "sync"]);
  });
});
