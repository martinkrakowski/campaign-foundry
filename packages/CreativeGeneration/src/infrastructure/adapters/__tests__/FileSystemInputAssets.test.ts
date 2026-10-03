import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { projectRoot } from "@campaignfoundry/shared";
import { FileSystemInputAssets } from "../FileSystemInputAssets.js";

/**
 * PT-4c: the port's whole contract is "which refs come back `undefined`, and
 * what the other ones reject with". Every rule it promises is the rule
 * `resolveAssetPath` already enforces, so each case below is asserted HERE
 * through `read()` as well as there — a wrapper that widened the confinement by
 * one ref would turn a skipped asset into a file-existence oracle over the whole
 * repository, which is the exact failure `safe-path.ts` was written to prevent.
 */
describe("FileSystemInputAssets (InputAssetPort adapter)", () => {
  test("returns undefined for an empty ref — never a throw", async () => {
    const inputs = new FileSystemInputAssets(projectRoot());
    await expect(inputs.read("")).resolves.toBeUndefined();
  });

  test("returns undefined for an absolute path", async () => {
    const inputs = new FileSystemInputAssets(projectRoot());
    await expect(inputs.read("/etc/passwd")).resolves.toBeUndefined();
  });

  test("returns undefined for a ref that escapes the assets/ subtree", async () => {
    const inputs = new FileSystemInputAssets(projectRoot());
    await expect(inputs.read("assets/../package.json")).resolves.toBeUndefined();
    await expect(inputs.read("../secret.png")).resolves.toBeUndefined();
  });

  test("returns undefined for the assets/ directory itself (empty relative path)", async () => {
    const inputs = new FileSystemInputAssets(projectRoot());
    await expect(inputs.read("assets")).resolves.toBeUndefined();
  });

  test("confines to the root it is given, not the process's project root (D167)", async () => {
    const root = "/tmp/tenant-root";
    const inputs = new FileSystemInputAssets(root);
    await expect(inputs.read("../assets/x.png")).resolves.toBeUndefined();
    await expect(inputs.read("assets/inputs/x.png")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("returns the raw bytes of a safe ref, untouched", async () => {
    const inputs = new FileSystemInputAssets(projectRoot());
    const bytes = await inputs.read("assets/inputs/hydra-logo.png");
    expect(bytes).toBeDefined();
    // Byte-for-byte what is on disk: the port decodes nothing, so a consumer's
    // own decode sees exactly the stored file.
    expect(Buffer.from(bytes as Uint8Array)).toEqual(
      await readFile(resolve(projectRoot(), "assets", "inputs", "hydra-logo.png")),
    );
  });

  test("rejects a safe ref that names nothing, with the fs code preserved", async () => {
    const inputs = new FileSystemInputAssets(projectRoot());
    // Not wrapped: a consumer branches on ENOENT (the logo skips it silently), so
    // the code has to survive the trip through the port.
    await expect(inputs.read("assets/inputs/does-not-exist.png")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects a read failure that is not ENOENT with its own code intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-input-assets-"));
    try {
      // A directory where the ref names a file: EISDIR, not ENOENT, so a consumer
      // treating every rejection alike would warn where it used to skip.
      mkdirSync(join(root, "assets", "inputs", "not-a-file"), { recursive: true });
      await expect(
        new FileSystemInputAssets(root).read("assets/inputs/not-a-file"),
      ).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns undefined — not a throw — for a safe ref under a root that does not exist", async () => {
    // Nothing under an absent root can be safe, but an absent root is a
    // misconfigured deployment rather than a hostile brief, so the port reports
    // it the way it reports any other unreadable location: through the rejection
    // the read would have raised, never by escaping as a different error.
    const inputs = new FileSystemInputAssets(join(tmpdir(), "cf-no-such-root-pt4c"));
    await expect(inputs.read("assets/inputs/x.png")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(inputs.read("../outside.png")).resolves.toBeUndefined();
  });

  test("two instances over the same root read the same bytes (no per-call state)", async () => {
    const first = new FileSystemInputAssets(projectRoot());
    const second = new FileSystemInputAssets(projectRoot());
    expect(Buffer.from((await first.read("assets/inputs/hydra-logo.png")) as Uint8Array)).toEqual(
      Buffer.from((await second.read("assets/inputs/hydra-logo.png")) as Uint8Array),
    );
  });
});

/** A fixture written into a scratch root, so the confined-read path is exercised off `projectRoot()` too. */
describe("FileSystemInputAssets over a scratch root", () => {
  test("reads a file created under that root's own assets/ tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-input-assets-ok-"));
    try {
      mkdirSync(join(root, "assets", "inputs"), { recursive: true });
      const file = join(root, "assets", "inputs", "x.txt");
      writeFileSync(file, "hello");
      // The raw readFile result, so the scratch root is proved end to end rather
      // than only against projectRoot()'s checked-in assets.
      const bytes = await new FileSystemInputAssets(root).read("assets/inputs/x.txt");
      expect(Buffer.from(bytes as Uint8Array)).toEqual(await readFile(file));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
