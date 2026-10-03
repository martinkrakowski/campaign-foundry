import { describe, test, expect } from "vitest";
import { projectRoot } from "@campaignfoundry/shared";
import { AspectRatio } from "@campaignfoundry/CampaignOrchestration";
import { FileSystemSceneAssetResolver } from "../FileSystemSceneAssetResolver.js";
import { FileSystemAudioAssetResolver } from "../FileSystemAudioAssetResolver.js";
import { fsInputs } from "./fs-inputs.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};

/**
 * The two rejecting resolvers carry a distinction their message alone does not:
 * an UNSAFE ref and an UNREADABLE one both reject, with different messages, and
 * only the second carries the underlying failure as `cause`.
 *
 * That `cause` is load-bearing. `GenerateCampaignUseCase` and
 * `PreviewCreativeFrameUseCase` turn the rejection into a run failure, and the
 * `cause` is what says WHY — a missing file (`ENOENT`) is a brief naming an asset
 * that was never uploaded, while a decode failure is a file that arrived corrupt.
 * Dropping it leaves two indistinguishable failures behind a message that claims
 * to name the problem, and it is the one part of this contract no other suite
 * here asserts: `FileSystemSceneAssetResolver.test.ts` and
 * `FileSystemAudioAssetResolver.test.ts` pin the message text only.
 *
 * PT-4c moved both reads behind `InputAssetPort`, so the read failure is now a
 * port rejection rather than a `readFile` call in this file's own `try`. These
 * cases pin that the wrapping survived the move — the `cause` still rides out.
 */
describe("FileSystemSceneAssetResolver — what the rejection carries (PT-4c)", () => {
  test("an unsafe ref rejects as an invalid path, with no cause to report", async () => {
    const error = await new FileSystemSceneAssetResolver(fsInputs(projectRoot()))
      .resolveScene("/etc/passwd", ratio())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Scene "/etc/passwd" is not a valid asset path.');
    expect((error as Error).cause).toBeUndefined();
  });

  test("a missing scene rejects with the fs failure as its cause", async () => {
    const error = await new FileSystemSceneAssetResolver(fsInputs(projectRoot()))
      .resolveScene("assets/inputs/does-not-exist.png", ratio())
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Scene "assets/inputs/does-not-exist.png" could not be read.',
    );
    expect((error as Error).cause).toBeDefined();
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("an undecodable scene rejects with the DECODE failure — not ENOENT — as its cause", async () => {
    const error = await new FileSystemSceneAssetResolver(fsInputs(projectRoot()))
      .resolveScene("assets/inputs/README.txt", ratio())
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe('Scene "assets/inputs/README.txt" could not be read.');
    const cause = (error as Error).cause as NodeJS.ErrnoException;
    expect(cause).toBeDefined();
    // The file WAS found; it is the image decode that failed. A wrapper that
    // reported the read's outcome here would tell the operator to re-upload.
    expect(cause.code).not.toBe("ENOENT");
  });
});

describe("FileSystemAudioAssetResolver — what the rejection carries (PT-4c)", () => {
  test("an unsafe ref rejects as an invalid path, with no cause to report", async () => {
    const error = await new FileSystemAudioAssetResolver(fsInputs(projectRoot()))
      .resolveAudio("/etc/passwd")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Audio "/etc/passwd" is not a valid asset path.');
    expect((error as Error).cause).toBeUndefined();
  });

  test("a missing bed rejects with the fs failure as its cause", async () => {
    const error = await new FileSystemAudioAssetResolver(fsInputs(projectRoot()))
      .resolveAudio("assets/inputs/does-not-exist.mp3")
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Audio "assets/inputs/does-not-exist.mp3" could not be read.',
    );
    expect((error as Error).cause).toBeDefined();
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});
