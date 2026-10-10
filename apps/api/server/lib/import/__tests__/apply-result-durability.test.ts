import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openResult, ResultWriter, replan } from "../apply.js";
import { main } from "../../../../bin/import.js";
import { useApplyEnvironment, restoreApplyEnvironment } from "./fixtures/apply-harness.js";
import { makeRoot, writeBrief, writeAt, PNG, dropRoot } from "./fixtures/tree.js";
import { database, resetDatabase, setDatabase } from "../../db/database.js";
import type { SqlClient } from "../../db/sql-client.js";
import type { StepContext } from "../steps.js";

const SWITCHED_AT = "2026-10-01T00:00:00Z";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  open: vi.fn(),
}));

const openMock = vi.mocked(open);
const hand = (fd: number) => {
  const sync = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  return { handle: { sync, close, fd } as unknown as FileHandle, sync, close };
};

let base: string;
beforeEach(() => {
  openMock.mockReset();
  base = mkdtempSync(join(tmpdir(), "dur-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("openResult", () => {
  test("syncs the parent directory after creating the file", async () => {
    const file = join(base, "r.jsonl");
    const fh = hand(17);
    const dh = hand(18);
    openMock.mockImplementationOnce(async () => fh.handle);
    openMock.mockImplementationOnce(async () => dh.handle);
    const result = await openResult(file);
    expect(openMock.mock.calls[0]).toEqual([file, "wx"]);
    expect(openMock.mock.calls[1]).toEqual([dirname(resolve(file)), "r"]);
    expect(result).toBe(fh.handle);
    expect(dh.sync).toHaveBeenCalledTimes(1);
    expect(dh.close).toHaveBeenCalledTimes(1);
    expect(fh.close).not.toHaveBeenCalled();
    await fh.close();
  });

  test("closes the new file handle and rethrows when the directory sync fails", async () => {
    const file = join(base, "r2.jsonl");
    const dirErr = new Error("dir sync failed");
    const fh = hand(17);
    const dh = hand(18);
    dh.sync.mockRejectedValue(dirErr);
    openMock.mockImplementationOnce(async () => fh.handle);
    openMock.mockImplementationOnce(async () => dh.handle);
    await expect(openResult(file)).rejects.toThrow("dir sync failed");
    expect(openMock.mock.calls).toHaveLength(2);
    expect(fh.close).toHaveBeenCalled();
    expect(dh.sync).toHaveBeenCalledTimes(1);
    expect(dh.close).toHaveBeenCalled();
  });

  test("rethrows the original sync error when closing the new file also fails", async () => {
    const dirErr = new Error("dir sync failed");
    const fh = hand(17);
    fh.close.mockRejectedValue(new Error("file close failed"));
    const dh = hand(18);
    dh.sync.mockRejectedValue(dirErr);
    openMock.mockImplementationOnce(async () => fh.handle);
    openMock.mockImplementationOnce(async () => dh.handle);
    await expect(openResult(join(base, "r3.jsonl"))).rejects.toThrow("dir sync failed");
    expect(fh.close).toHaveBeenCalled();
  });

  test("still refuses an existing file with EEXIST and opens no directory", async () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    openMock.mockImplementationOnce(async () => Promise.reject(eexist));
    await expect(openResult(join(base, "r4.jsonl"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(openMock.mock.calls).toHaveLength(1);
    expect(openMock.mock.calls[0][1]).toBe("wx");
  });
});

describe("ResultWriter short writes", () => {
  const writeHandle = (writeImpl: ReturnType<typeof vi.fn>) => {
    const sync = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    return {
      handle: { sync, close, write: writeImpl, fd: 17 } as unknown as FileHandle,
      sync,
      close,
      write: writeImpl,
    };
  };

  test("a short write is continued until the whole line is on the handle", async () => {
    const line =
      JSON.stringify({
        kind: "campaign",
        slug: "camp",
        outcome: "created",
        minted: { campaignId: "dead", assets: [] },
        unreferencedInputs: { count: 0, names: [] },
      }) + "\n";
    const len = Buffer.byteLength(line, "utf8");
    const write = vi
      .fn()
      .mockResolvedValueOnce({ bytesWritten: 3 })
      .mockResolvedValueOnce({ bytesWritten: len - 3 });
    const { handle, sync, write: writeMock } = writeHandle(write);
    const writer = new ResultWriter(handle, "2026-10-01T00:00:00Z", "local", "abc");
    await writer.add({
      slug: "camp",
      outcome: "created",
      minted: { campaignId: "dead", assets: [] },
      unreferencedInputs: { count: 0, names: [] },
    });
    expect(writeMock.mock.calls[0]).toEqual([expect.any(Buffer), 0, len]);
    expect(writeMock.mock.calls[1]).toEqual([expect.any(Buffer), 3, len - 3]);
    expect(writeMock.mock.calls.length).toBe(2);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  test("a write that reports no progress throws and stops looping", async () => {
    const write = vi.fn().mockResolvedValue({ bytesWritten: 0 });
    const { handle } = writeHandle(write);
    const writer = new ResultWriter(handle, "2026-10-01T00:00:00Z", "local", "abc");
    await expect(
      writer.add({
        slug: "camp",
        outcome: "created",
        minted: { campaignId: "dead", assets: [] },
        unreferencedInputs: { count: 0, names: [] },
      }),
    ).rejects.toThrow("short write: no progress");
    expect(write.mock.calls.length).toBe(1);
  });
});

describe("failed result-file close (req 20 mirror)", () => {
  let env: Awaited<ReturnType<typeof useApplyEnvironment>>;
  let root: string | undefined;

  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    openMock.mockReset();
    await restoreApplyEnvironment();
    resetDatabase();
    if (root !== undefined) dropRoot(root);
  });

  function io(): {
    out: string[];
    err: string[];
    deps: { stdout: (s: string) => void; stderr: (s: string) => void };
  } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
  }

  test("a failed close of the result file is named, keeps the run's exit code and still closes the database", async () => {
    const real = await vi.importActual("node:fs/promises");
    const realOpen = (
      real as {
        open: (
          path: PathLike | FileHandle,
          flags: string | number | undefined,
          mode?: number,
        ) => Promise<FileHandle>;
      }
    ).open;

    root = makeRoot();
    const output = join(root, "output");
    mkdirSync(output, { recursive: true });
    writeAt(root, "assets/inputs/camp/logo.png", PNG);
    writeBrief(root, "camp.yaml", {
      id: "camp",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
      ],
    });

    const ctx: StepContext = {
      orgId: "local",
      switchedAt: new Date(SWITCHED_AT),
      projectRoot: root,
      outputRoot: output,
      includeSamples: false,
      fsOnly: false,
    };
    const digest = (await replan(ctx)).digest;
    const result = join(tmpdir(), `cf-apply-5b-${process.pid}.json`);

    const close = vi.fn().mockRejectedValue(new Error("the result file is stuck"));
    const write = vi.fn().mockImplementation(async (buf: Buffer) => buf.length);
    const sync = vi.fn().mockResolvedValue(undefined);
    const badHandle = { write, sync, close, fd: 17 } as unknown as FileHandle;

    openMock.mockImplementation(async (path, mode) => {
      if (mode === "wx" && String(path).endsWith(".json")) return badHandle;
      return realOpen(path, mode);
    });

    env.reinstall();
    const end = vi.fn(async () => undefined);
    const realDb = database() as SqlClient & { query: SqlClient["query"] };
    setDatabase({
      query: realDb.query.bind(realDb),
      exec: realDb.exec.bind(realDb),
      end: end as SqlClient["end"],
      transaction: realDb.transaction.bind(realDb),
    } as SqlClient);
    const { out, err, deps } = io();
    try {
      const code = await main(
        [
          "apply",
          "--project-root",
          root,
          "--output-root",
          output,
          "--switched-at",
          SWITCHED_AT,
          "--org",
          "local",
          "--result",
          result,
          "--expect",
          digest,
        ],
        deps,
      );
      expect(code).toBe(0);
      expect(err).toEqual(["could not close the result file: the result file is stuck"]);
      expect(end).toHaveBeenCalledTimes(1);
    } finally {
      openMock.mockReset();
      rmSync(result, { force: true });
    }
  });
});
