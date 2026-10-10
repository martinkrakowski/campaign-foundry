import { mkdtempSync, rmSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openResult } from "../apply.js";

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
