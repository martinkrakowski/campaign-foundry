import { describe, expect, it, vi } from "vitest";
import { InvalidAdClipError } from "../../../domain/value-objects/mp4-clip.js";
import {
  PublicMediaNotConfiguredError,
  PublishAdClipUseCase,
  PublishedClipRecordConflictError,
  type PublishAdClipDeps,
} from "../PublishAdClipUseCase.use-case.js";
import { fakePublicAdMedia, fakePublishedClipRecord } from "./_fakes.js";

/** One 4-byte big-endian uint32. */
const u32 = (n: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n, false);
  return bytes;
};

/** ASCII bytes of a short string (FourCCs, brands). */
const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** Concatenate byte arrays into one. */
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** One ISO BMFF box: 8-byte header (size, type) over the payload parts. */
const box = (type: string, ...payload: readonly Uint8Array[]): Uint8Array => {
  const body = concat(payload);
  return concat([u32(8 + body.length), ascii(type), body]);
};

/**
 * The box pieces of a minimal clip `validateAdClip` accepts: `ftyp` branded
 * `isom`, a `moov` with a 1-second v0 `mvhd`, and one video `trak` whose
 * `stsd` carries an `avc1` entry with an `avcC` child, plus an `mdat`.
 */
const clipPieces = (): { ftyp: Uint8Array; moov: Uint8Array; mdat: Uint8Array } => {
  const ftyp = box("ftyp", ascii("isom"), u32(0), ascii("isom"));
  const mvhdPayload = concat([
    new Uint8Array(12), // version 0 + flags + ctime + mtime
    u32(1000), // timescale
    u32(1000), // duration -> 1s
  ]);
  const mvhd = box("mvhd", mvhdPayload);
  const hdlr = box(
    "hdlr",
    new Uint8Array(8), // version/flags + pre_defined
    ascii("vide"),
  );
  const avcC = box("avcC", new Uint8Array(4));
  const entryBody = concat([new Uint8Array(78), avcC]);
  const entry = concat([u32(8 + entryBody.length), ascii("avc1"), entryBody]);
  const stsd = box("stsd", new Uint8Array(4), u32(1), entry);
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const mdia = box("mdia", hdlr, minf);
  const trak = box("trak", mdia);
  const moov = box("moov", mvhd, trak);
  return { ftyp, moov, mdat: box("mdat", new Uint8Array(4)) };
};

/** Faststart: ftyp -> moov -> mdat. */
const validAdClipBytes = (): Uint8Array => {
  const { ftyp, moov, mdat } = clipPieces();
  return concat([ftyp, moov, mdat]);
};

/** Non-faststart: ftyp -> mdat -> moov — the same bytes, mdat moved first. */
const nonFaststartAdClipBytes = (): Uint8Array => {
  const { ftyp, moov, mdat } = clipPieces();
  return concat([ftyp, mdat, moov]);
};

const ORG = "acme";
const CAMPAIGN = "0b9e6c1e-1111-4222-8333-444455556666";
const RENDER_KEY = `org/${ORG}/campaign/${CAMPAIGN}/renders/clip.mp4`;

/** A fake private object store: `get` serves bytes, every write is a spy. */
const fakeObjectStore = (bytes: Uint8Array | Error = validAdClipBytes()) => ({
  get: vi.fn(async (): Promise<{ readonly bytes: Uint8Array } | undefined> => {
    if (bytes instanceof Error) throw bytes;
    return { bytes };
  }),
  put: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  deletePrefix: vi.fn(async () => {}),
  copy: vi.fn(async () => {}),
});

const sha256 = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const makeDeps = (
  over: Partial<Omit<PublishAdClipDeps, "objectStore">> & {
    objectStore?: ReturnType<typeof fakeObjectStore>;
  } = {},
): { deps: PublishAdClipDeps; objectStore: ReturnType<typeof fakeObjectStore> } => {
  const objectStore = over.objectStore ?? fakeObjectStore();
  const { objectStore: _ignored, ...rest } = over;
  void _ignored;
  return {
    deps: {
      objectStore,
      publicAdMedia: "publicAdMedia" in over ? over.publicAdMedia : fakePublicAdMedia(),
      publishedClipRecord: rest.publishedClipRecord ?? fakePublishedClipRecord(),
      sha256: rest.sha256 ?? sha256,
    },
    objectStore,
  };
};

const execute = (deps: PublishAdClipDeps, renderKey: string = RENDER_KEY) =>
  new PublishAdClipUseCase(deps).execute({ orgId: ORG, campaignId: CAMPAIGN, renderKey });

describe("PublishAdClipUseCase", () => {
  it("publishes a valid clip, records it, and returns the public record", async () => {
    const { deps, objectStore } = makeDeps();
    const publicAdMedia = deps.publicAdMedia!;
    const record = await execute(deps);

    expect(objectStore.get).toHaveBeenCalledWith(RENDER_KEY);
    expect(publicAdMedia.publish).toHaveBeenCalledWith(
      ORG,
      expect.any(Uint8Array),
      sha256(validAdClipBytes()),
    );
    expect(deps.publishedClipRecord.record).toHaveBeenCalledWith(
      ORG,
      CAMPAIGN,
      record.key,
      record.url,
      sha256(validAdClipBytes()),
      expect.any(Function),
    );
    expect(record.url).toBe(`https://media.example.invalid/${record.key}`);
  });

  it("returns the existing record without publishing when the content hash is already recorded", async () => {
    const clip = validAdClipBytes();
    const objectStore = fakeObjectStore(clip);
    const publicAdMedia = fakePublicAdMedia();
    const publishedClipRecord = fakePublishedClipRecord([
      {
        orgId: ORG,
        campaignId: CAMPAIGN,
        contentHash: sha256(clip),
        record: { key: "org/acme/aaaa/hash.mp4", url: "https://media.example.invalid/x" },
      },
    ]);
    const deps: PublishAdClipDeps = { objectStore, publicAdMedia, publishedClipRecord, sha256 };

    const record = await execute(deps);

    expect(record).toEqual({
      key: "org/acme/aaaa/hash.mp4",
      url: "https://media.example.invalid/x",
    });
    expect(publicAdMedia.publish).not.toHaveBeenCalled();
    expect(publishedClipRecord.record).not.toHaveBeenCalled();
  });

  it("refuses with PublicMediaNotConfiguredError when publicAdMedia is undefined", async () => {
    const { deps, objectStore } = makeDeps({ publicAdMedia: undefined });
    await expect(execute(deps)).rejects.toThrow(PublicMediaNotConfiguredError);
    expect(objectStore.get).not.toHaveBeenCalled();
    expect(deps.publishedClipRecord.find).not.toHaveBeenCalled();
  });

  it("refuses a renderKey outside the org and campaign render prefix without reading objectStore", async () => {
    for (const renderKey of [
      "",
      "org/acme/campaign/renders/clip.mp4",
      `org/${ORG}/campaign/${CAMPAIGN}/inputs/clip.mp4`,
      `org/${ORG}/campaign/${CAMPAIGN}/packages/clip.mp4`,
      `org/${ORG}/campaign/${CAMPAIGN}/renders/../secrets.mp4`,
    ]) {
      const { deps, objectStore } = makeDeps();
      await expect(execute(deps, renderKey)).rejects.toMatchObject({
        name: "InvalidRenderKeyError",
      });
      expect(objectStore.get).not.toHaveBeenCalled();
    }
  });

  it("refuses another org or campaign renderKey identically to an invalid key", async () => {
    for (const renderKey of [
      "org/other/campaign/renders/clip.mp4",
      `org/${ORG}/campaign/11111111-2222-4333-8444-555566667777/renders/clip.mp4`,
      `org/${ORG}/campaign/${CAMPAIGN}/renders/../../other/clip.mp4`,
    ]) {
      const { deps, objectStore } = makeDeps();
      await expect(execute(deps, renderKey)).rejects.toMatchObject({
        name: "InvalidRenderKeyError",
      });
      expect(objectStore.get).not.toHaveBeenCalled();
    }
  });

  it("throws RenderClipNotFoundError when the render object is missing", async () => {
    const objectStore = fakeObjectStore();
    objectStore.get.mockResolvedValue(undefined);
    const publicAdMedia = fakePublicAdMedia();
    const deps: PublishAdClipDeps = {
      objectStore,
      publicAdMedia,
      publishedClipRecord: fakePublishedClipRecord(),
      sha256,
    };

    await expect(execute(deps)).rejects.toMatchObject({ name: "RenderClipNotFoundError" });
    expect(publicAdMedia.publish).not.toHaveBeenCalled();
    expect(deps.publishedClipRecord.record).not.toHaveBeenCalled();
  });

  it("propagates objectStore.get failures without publishing", async () => {
    const boom = new Error("store down");
    const objectStore = fakeObjectStore(boom);
    const publicAdMedia = fakePublicAdMedia();
    const deps: PublishAdClipDeps = {
      objectStore,
      publicAdMedia,
      publishedClipRecord: fakePublishedClipRecord(),
      sha256,
    };

    await expect(execute(deps)).rejects.toBe(boom);
    expect(publicAdMedia.publish).not.toHaveBeenCalled();
    expect(deps.publishedClipRecord.record).not.toHaveBeenCalled();
  });

  it("propagates validateAdClip refusal without publishing", async () => {
    const { deps } = makeDeps({ objectStore: fakeObjectStore(new Uint8Array([1, 2, 3])) });
    const publicAdMedia = deps.publicAdMedia!;

    await expect(execute(deps)).rejects.toThrow(InvalidAdClipError);
    expect(publicAdMedia.publish).not.toHaveBeenCalled();
    expect(deps.publishedClipRecord.record).not.toHaveBeenCalled();
  });

  it("refuses non-faststart clip as not-faststart without publishing or recording", async () => {
    const { deps } = makeDeps({ objectStore: fakeObjectStore(nonFaststartAdClipBytes()) });
    const publicAdMedia = deps.publicAdMedia!;

    const error = await execute(deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvalidAdClipError);
    expect((error as InvalidAdClipError).reason).toBe("not-faststart");
    // No public object and no ledger row.
    expect(publicAdMedia.publish).not.toHaveBeenCalled();
    expect(deps.publishedClipRecord.record).not.toHaveBeenCalled();
  });

  it("propagates publicAdMedia.publish failure without recording", async () => {
    const boom = new Error("public bucket unavailable");
    const { deps } = makeDeps({ publicAdMedia: fakePublicAdMedia({ publishFails: boom }) });

    await expect(execute(deps)).rejects.toBe(boom);
    expect(deps.publishedClipRecord.record).not.toHaveBeenCalled();
  });

  it("removes the newly published object and rethrows when record fails", async () => {
    const boom = new Error("ledger write failed");
    const publicAdMedia = fakePublicAdMedia();
    const publishedClipRecord = {
      ...fakePublishedClipRecord(),
      record: vi.fn(async () => {
        throw boom;
      }),
    };
    const { deps } = makeDeps({ publicAdMedia, publishedClipRecord });

    await expect(execute(deps)).rejects.toBe(boom);
    // The one object this call created is cleaned up.
    expect(publicAdMedia.remove).toHaveBeenCalledTimes(1);
  });

  it("removes the object and reports the refusal when the record is refused for a tombstoned campaign (CFAR6-record)", async () => {
    // The Postgres ledger refuses `record` for a campaign whose `deleted_at`
    // is set (CFAR6-record) — from this use case's side the refusal is any
    // record error, and the duty is the same: no clip fact, no orphan bytes,
    // and the refusal reported to the caller.
    const refusal = new Error(
      "Refusing to record a published clip for a campaign that is not live.",
    );
    refusal.name = "PublishedClipRecordRefusedError";
    const publicAdMedia = fakePublicAdMedia();
    const publishedClipRecord = {
      ...fakePublishedClipRecord(),
      record: vi.fn(async () => {
        throw refusal;
      }),
    };
    const { deps } = makeDeps({ publicAdMedia, publishedClipRecord });

    await expect(execute(deps)).rejects.toBe(refusal);
    expect(publicAdMedia.remove).toHaveBeenCalledTimes(1);
  });

  it("when cleanup remove fails, the original record error is rethrown", async () => {
    const recordError = new Error("ledger write failed");
    const cleanupError = new Error("public bucket unavailable");
    const publicAdMedia = fakePublicAdMedia({ removeFails: cleanupError });
    const publishedClipRecord = {
      ...fakePublishedClipRecord(),
      record: vi.fn(async () => {
        throw recordError;
      }),
    };
    const { deps } = makeDeps({ publicAdMedia, publishedClipRecord });

    await expect(execute(deps)).rejects.toBe(recordError);
  });

  it("removes its object and returns the winner when record returns exists with a different key", async () => {
    const winner = { key: "org/acme/ffff/hash.mp4", url: "https://media.example.invalid/winner" };
    let findCalls = 0;
    const publishedClipRecord = {
      ...fakePublishedClipRecord(),
      record: vi.fn(async () => "exists" as const),
      // First find (idempotency check) sees nothing; the post-record find
      // resolves the winner under a DIFFERENT key.
      find: vi.fn(async () => {
        findCalls += 1;
        return findCalls >= 2 ? winner : undefined;
      }),
    };
    const publicAdMedia = fakePublicAdMedia();
    const { deps } = makeDeps({ publicAdMedia, publishedClipRecord });

    const record = await execute(deps);

    expect(record).toEqual(winner);
    // The loser — the object THIS call created — is removed; the winner is not.
    expect(publicAdMedia.remove).toHaveBeenCalledTimes(1);
    expect(publicAdMedia.remove).not.toHaveBeenCalledWith(winner.key);
  });

  it("returns the winner with no remove when record returns exists with the same key", async () => {
    let findCalls = 0;
    const publishedKeys: string[] = [];
    const publicAdMedia = fakePublicAdMedia();
    publicAdMedia.publish.mockImplementation(
      async (orgId: string, _bytes: Uint8Array, hash: string) => {
        const key = `org/${orgId}/aaaa/${hash}.mp4`;
        publishedKeys.push(key);
        return { key, url: `https://media.example.invalid/${key}` };
      },
    );
    const publishedClipRecord = {
      ...fakePublishedClipRecord(),
      record: vi.fn(async () => "exists" as const),
      // First find (idempotency check) sees nothing; the post-record find
      // resolves the winner — whose key IS the key this call published.
      find: vi.fn(async () => {
        findCalls += 1;
        return findCalls >= 2
          ? { key: publishedKeys[0]!, url: `https://media.example.invalid/${publishedKeys[0]}` }
          : undefined;
      }),
    };
    const { deps } = makeDeps({ publicAdMedia, publishedClipRecord });

    const record = await execute(deps);

    expect(record).toEqual({
      key: publishedKeys[0],
      url: `https://media.example.invalid/${publishedKeys[0]}`,
    });
    expect(publicAdMedia.remove).not.toHaveBeenCalled();
  });

  it("removes the object and throws PublishedClipRecordConflictError when record returns exists but find is undefined", async () => {
    const publicAdMedia = fakePublicAdMedia();
    const publishedClipRecord = {
      ...fakePublishedClipRecord(),
      record: vi.fn(async () => "exists" as const),
      find: vi.fn(async () => undefined),
    };
    const { deps } = makeDeps({ publicAdMedia, publishedClipRecord });

    await expect(execute(deps)).rejects.toThrow(PublishedClipRecordConflictError);
    // The object this call created is removed — the only remove there is.
    expect(publicAdMedia.remove).toHaveBeenCalledTimes(1);
  });

  it("hands record a precondition that reports whether the published object still exists", async () => {
    const publicAdMedia = fakePublicAdMedia();
    let seen: (() => Promise<boolean>) | undefined;
    const publishedClipRecord = {
      ...fakePublishedClipRecord(),
      record: vi.fn(
        async (
          _o: string,
          _c: string,
          _k: string,
          _u: string,
          _h: string,
          stillThere?: () => Promise<boolean>,
        ) => {
          seen = stillThere;
          return "recorded" as const;
        },
      ),
    };
    const { deps } = makeDeps({ publicAdMedia, publishedClipRecord });
    const record = await execute(deps);

    expect(seen).toBeDefined();
    expect(await seen!()).toBe(true);
    await publicAdMedia.remove(record.key);
    expect(await seen!()).toBe(false);
  });

  it("never writes to the private objectStore", async () => {
    const { deps, objectStore } = makeDeps();
    await execute(deps);
    expect(objectStore.put).not.toHaveBeenCalled();
    expect(objectStore.delete).not.toHaveBeenCalled();
    expect(objectStore.deletePrefix).not.toHaveBeenCalled();
    expect(objectStore.copy).not.toHaveBeenCalled();
  });
});
