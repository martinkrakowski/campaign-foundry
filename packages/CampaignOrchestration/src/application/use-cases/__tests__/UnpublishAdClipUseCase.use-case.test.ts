import { describe, expect, it, vi } from "vitest";
import {
  PublishedClipNotFoundError,
  UnpublishAdClipUseCase,
  type UnpublishAdClipDeps,
} from "../UnpublishAdClipUseCase.use-case.js";
import { PublicMediaNotConfiguredError } from "../PublishAdClipUseCase.use-case.js";
import {
  fakePublicAdMedia,
  fakePublishedClipRecord,
  type FakePublicAdMedia,
  type FakePublishedClipRecordPort,
} from "./_fakes.js";

const ORG = "acme";
const CAMPAIGN = "0b9e6c1e-1111-4222-8333-444455556666";
const KEY = `org/${ORG}/campaign/${CAMPAIGN}/renders/clip.mp4`;
const RECORDED_URL = "https://media.example.invalid/x";

const makeDeps = (
  over: Partial<UnpublishAdClipDeps> & { recorded?: string } = {},
): {
  deps: UnpublishAdClipDeps;
  publicAdMedia: FakePublicAdMedia;
  publishedClipRecord: FakePublishedClipRecordPort;
} => {
  const { recorded = KEY, ...rest } = over;
  const publishedClipRecord = fakePublishedClipRecord([
    {
      orgId: ORG,
      campaignId: CAMPAIGN,
      contentHash: "a".repeat(64),
      record: { key: recorded, url: RECORDED_URL },
    },
  ]);
  const publicAdMedia = fakePublicAdMedia();
  const deps: UnpublishAdClipDeps = {
    publicAdMedia,
    publishedClipRecord,
    ...rest,
  };
  return { deps, publicAdMedia, publishedClipRecord };
};

const execute = (
  deps: UnpublishAdClipDeps,
  input: { orgId?: string; campaignId?: string; key?: string } = {},
) =>
  new UnpublishAdClipUseCase(deps).execute({
    orgId: input.orgId ?? ORG,
    campaignId: input.campaignId ?? CAMPAIGN,
    key: input.key ?? KEY,
  });

describe("UnpublishAdClipUseCase", () => {
  it("removes the public object first, then the record", async () => {
    const { deps, publicAdMedia, publishedClipRecord } = makeDeps();
    const order: string[] = [];
    publicAdMedia.remove.mockImplementation(async () => {
      order.push("publicAdMedia.remove");
    });
    publishedClipRecord.remove.mockImplementation(async () => {
      order.push("publishedClipRecord.remove");
    });

    await execute(deps);

    expect(publicAdMedia.remove).toHaveBeenCalledWith(KEY);
    expect(deps.publishedClipRecord.remove).toHaveBeenCalledWith(ORG, KEY);
    expect(order).toEqual(["publicAdMedia.remove", "publishedClipRecord.remove"]);
  });

  it("refuses with PublicMediaNotConfiguredError when publicAdMedia is undefined", async () => {
    const { deps } = makeDeps({ publicAdMedia: undefined });
    await expect(execute(deps)).rejects.toThrow(PublicMediaNotConfiguredError);
    expect(deps.publishedClipRecord.listForCampaign).not.toHaveBeenCalled();
    expect(deps.publishedClipRecord.remove).not.toHaveBeenCalled();
  });

  it("throws PublishedClipNotFoundError when the key is not recorded for the org and campaign", async () => {
    for (const key of [
      "",
      "not-a-key",
      `org/${ORG}/campaign/${CAMPAIGN}/renders/../secrets.mp4`,
      "https://media.example.invalid/x",
    ]) {
      const { deps } = makeDeps();
      const publicAdMedia = deps.publicAdMedia!;
      await expect(execute(deps, { key })).rejects.toThrow(PublishedClipNotFoundError);
      expect(publicAdMedia.remove).not.toHaveBeenCalled();
      expect(deps.publishedClipRecord.remove).not.toHaveBeenCalled();
    }
  });

  it("refuses another org or campaign key identically to a missing key", async () => {
    for (const input of [
      { key: `org/other/campaign/${CAMPAIGN}/renders/clip.mp4` },
      {
        key: `org/${ORG}/campaign/11111111-2222-4333-8444-555566667777/renders/clip.mp4`,
      },
      { orgId: "other" },
      { campaignId: "11111111-2222-4333-8444-555566667777" },
    ]) {
      const { deps } = makeDeps();
      const publicAdMedia = deps.publicAdMedia!;
      await expect(execute(deps, input)).rejects.toThrow(PublishedClipNotFoundError);
      expect(publicAdMedia.remove).not.toHaveBeenCalled();
      expect(deps.publishedClipRecord.remove).not.toHaveBeenCalled();
    }
  });

  it("keeps the record when publicAdMedia.remove fails so unpublish remains retryable", async () => {
    const boom = new Error("public bucket unavailable");
    const { deps } = makeDeps({
      publicAdMedia: fakePublicAdMedia({ removeFails: boom }),
    });

    await expect(execute(deps)).rejects.toBe(boom);
    expect(deps.publishedClipRecord.remove).not.toHaveBeenCalled();
  });

  it("never writes to the private objectStore", async () => {
    // The use case's deps carry no objectStore at all; inject a write-spy
    // store anyway (cast) and assert every write verb stays untouched.
    const writes = { put: vi.fn(), delete: vi.fn(), deletePrefix: vi.fn(), copy: vi.fn() };
    const { deps } = makeDeps();
    const probe = { ...deps, objectStore: writes } as unknown as Record<string, unknown>;
    expect(probe.objectStore).toBeDefined();
    await new UnpublishAdClipUseCase(deps).execute({
      orgId: ORG,
      campaignId: CAMPAIGN,
      key: KEY,
    });
    expect(writes.put).not.toHaveBeenCalled();
    expect(writes.delete).not.toHaveBeenCalled();
    expect(writes.deletePrefix).not.toHaveBeenCalled();
    expect(writes.copy).not.toHaveBeenCalled();
  });
});
