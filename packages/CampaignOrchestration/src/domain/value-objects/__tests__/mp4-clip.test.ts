import { describe, test, expect } from "vitest";
import {
  AD_CLIP_MAX_BOXES,
  AD_CLIP_MAX_BYTES,
  AD_CLIP_MAX_DURATION_SECONDS,
  InvalidAdClipError,
  validateAdClip,
} from "../mp4-clip.js";
import type { AdClipRejectionReason } from "../mp4-clip.js";

// ---- hand-built byte fixtures ------------------------------------------------

/** Big-endian uint32 bytes. */
function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/** 4-byte ASCII field, space-padded (box types and FourCCs). */
function type4(value: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) out.push(i < value.length ? value.charCodeAt(i) : 0x20);
  return out;
}

/** ISO BMFF box: header + payload. `size` selects the declared size form. */
function box(type: string, payload: number[], size: "u32" | "zero" | "large" = "u32"): number[] {
  if (size === "zero") return [...u32(0), ...type4(type), ...payload];
  if (size === "large") {
    return [...u32(1), ...type4(type), ...u32(0), ...u32(payload.length + 16), ...payload];
  }
  return [...u32(payload.length + 8), ...type4(type), ...payload];
}

function ftyp(brand = "isom", compatible: string[] = ["isom", "mp41"]): number[] {
  return box("ftyp", [...type4(brand), ...u32(0), ...compatible.map(type4).flat()]);
}

/** `mvhd` FullBox payload: version 0 (timescale/duration as uint32) or 1. */
function mvhd(timescale: number, duration: number, version = 0): number[] {
  if (version === 1) {
    return box("mvhd", [
      1,
      0,
      0,
      0, // version 1 + flags
      ...new Array<number>(16).fill(0), // creation + modification (64-bit each)
      ...u32(timescale),
      ...u32(0),
      ...u32(duration), // 64-bit duration, high then low
    ]);
  }
  return box("mvhd", [
    0,
    0,
    0,
    0, // version 0 + flags
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // creation + modification
    ...u32(timescale),
    ...u32(duration),
  ]);
}

function hdlr(handler: string): number[] {
  return box("hdlr", [0, 0, 0, 0, 0, 0, 0, 0, ...type4(handler), ...new Array<number>(12).fill(0)]);
}

/** Visual sample entry (`avc1`/`avc3`/`hvc1`): 78 fixed bytes + child boxes. */
function sampleEntry(type: string, children: number[][]): number[] {
  return box(type, [...new Array<number>(78).fill(0), ...children.flat()]);
}

function avcC(): number[] {
  // Minimal plausible AVCDecoderConfigurationRecord; the validator only
  // requires the box type to be present.
  return box("avcC", [1, 100, 0, 28, 255, 225, 0, 24, 103, 100, 0, 40, 172, 52, 193]);
}

function stsd(entry: number[]): number[] {
  return box("stsd", [0, 0, 0, 0, ...u32(1), ...entry]);
}

function stbl(children: number[][]): number[] {
  return box("stbl", children.flat());
}

function minf(children: number[][]): number[] {
  return box("minf", children.flat());
}

function mdia(children: number[][]): number[] {
  return box("mdia", children.flat());
}

function trak(children: number[][]): number[] {
  return box("trak", children.flat());
}

function videoTrak(entryType: string, opts?: { withAvcC?: boolean }): number[] {
  const children = opts?.withAvcC === false ? [] : [avcC()];
  return trak([mdia([hdlr("vide"), minf([stbl([stsd(sampleEntry(entryType, children))])])])]);
}

function moov(children: number[][]): number[] {
  return box("moov", children.flat());
}

/** A tiny well-formed clip: ftyp + moov(mvhd + one avc1 video trak). */
function tinyClip(opts?: {
  timescale?: number;
  duration?: number;
  version?: 0 | 1;
  brand?: string;
}): Uint8Array {
  return new Uint8Array([
    ...ftyp(opts?.brand),
    ...moov([
      mvhd(opts?.timescale ?? 600, opts?.duration ?? 600, opts?.version),
      videoTrak("avc1"),
    ]),
  ]);
}

function concat(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

/** Asserts the call throws InvalidAdClipError with exactly `reason`. */
function expectRejection(bytes: unknown, reason: AdClipRejectionReason): void {
  expect(() => validateAdClip(bytes as Uint8Array)).toThrowError(InvalidAdClipError);
  try {
    validateAdClip(bytes as Uint8Array);
  } catch (error) {
    expect((error as InvalidAdClipError).reason).toBe(reason);
    return;
  }
  expect.fail(`expected an InvalidAdClipError with reason "${reason}"`);
}

// ---- tests -------------------------------------------------------------------

describe("mp4-clip (ad clip validation)", () => {
  test("refuses null, wrong primitives, non-iterable, array holes, prototype-polluting keys, and throwing getters as not-mp4", () => {
    expectRejection(null, "not-mp4");
    expectRejection(undefined, "not-mp4");
    expectRejection("not bytes at all", "not-mp4");
    expectRejection(42, "not-mp4");
    // Array-like with a length but no byte identity; also non-iterable (no
    // Symbol.iterator), so neither iteration nor indexing can extract bytes.
    expectRejection({ length: 4, 0: 0, 1: 1, 2: 2, 3: 3 }, "not-mp4");
    expectRejection({ length: 0 }, "not-mp4");
    // An array hole (a sparse array is not a Uint8Array).
    const withHoles: number[] = [0, 0, 0, 16];
    withHoles.length = 8;
    expectRejection(withHoles, "not-mp4");
    // Prototype-polluting keys: still just a plain object, not a Uint8Array,
    // and never assigned onto any output object.
    const polluting: Record<string, unknown> = {};
    polluting["__proto__"] = { polluted: true };
    polluting.constructor = () => {};
    polluting.prototype = { polluted: true };
    expectRejection(polluting, "not-mp4");
    expectRejection({ ["__proto__"]: { length: 8 } }, "not-mp4");
    // A getter that throws on read.
    const throwingGetter = new Proxy(new Uint8Array(8), {
      get(target, key, receiver) {
        if (key === "byteLength") throw new Error("boom");
        return Reflect.get(target, key, receiver);
      },
    });
    expectRejection(throwingGetter, "not-mp4");
    // A proxy that throws on every trap.
    const hostileProxy = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        getPrototypeOf() {
          throw new Error("boom");
        },
        has() {
          throw new Error("boom");
        },
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    expectRejection(hostileProxy, "not-mp4");
  });

  test("refuses empty input as not-mp4", () => {
    expectRejection(new Uint8Array(0), "not-mp4");
  });

  test("refuses input over AD_CLIP_MAX_BYTES as too-large", () => {
    expectRejection(new Uint8Array(AD_CLIP_MAX_BYTES + 1), "too-large");
  });

  test("refuses random non-MP4 bytes as not-mp4", () => {
    // Deterministic pseudo-random garbage whose first box size stays in range.
    const bytes = new Uint8Array(64);
    bytes.set([0, 0, 0, 32], 0);
    for (let i = 4; i < 64; i++) bytes[i] = (i * 37 + 11) % 256;
    expectRejection(bytes, "not-mp4");
  });

  test("refuses unsupported ftyp brand as not-mp4", () => {
    expectRejection(
      concat(ftyp("xxxx", ["xxxx"]), moov([mvhd(600, 600), videoTrak("avc1")])),
      "not-mp4",
    );
  });

  test("refuses MP4 missing moov or mvhd as not-mp4", () => {
    expectRejection(concat(ftyp()), "not-mp4");
    expectRejection(concat(ftyp(), moov([videoTrak("avc1")])), "not-mp4");
  });

  test("refuses non-faststart clip with mdat before moov as not-faststart", () => {
    expectRejection(
      concat(ftyp(), box("mdat", []), moov([mvhd(600, 600), videoTrak("avc1")])),
      "not-faststart",
    );
    // Multiple mdat boxes: the FIRST mdat is the one that must follow moov.
    expectRejection(
      concat(
        ftyp(),
        box("mdat", []),
        moov([mvhd(600, 600), videoTrak("avc1")]),
        box("mdat", [1, 2]),
      ),
      "not-faststart",
    );
  });

  test("accepts a faststart clip with ftyp -> moov -> mdat and returns ValidatedAdClip", () => {
    const bytes = concat(
      ftyp(),
      moov([mvhd(600, 600), videoTrak("avc1")]),
      box("mdat", [1, 2, 3, 4]),
    );
    expect(validateAdClip(bytes)).toEqual({
      sizeBytes: bytes.byteLength,
      durationSeconds: 1,
      timescale: 600,
      durationUnits: 600,
    });
    // A clip with no mdat box at all keeps the pre-faststart outcome: accepted.
    expect(validateAdClip(tinyClip()).durationUnits).toBe(600);
  });

  test("refuses input exceeding AD_CLIP_MAX_BOXES as not-mp4", () => {
    // More top-level boxes than the whole-parse budget, after a valid ftyp.
    const parts: number[][] = [ftyp()];
    for (let i = 0; i <= AD_CLIP_MAX_BOXES; i++) parts.push(box("free", []));
    expectRejection(concat(...parts), "not-mp4");
  });

  test("refuses truncated mid-box input as truncated", () => {
    // A box header cut short: fewer than 8 bytes remain.
    expectRejection(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79]), "truncated");
  });

  test("refuses box size extending past end of data as truncated", () => {
    // Header claims 24 bytes; only 16 are present.
    expectRejection(new Uint8Array([...u32(24), ...type4("ftyp"), ...type4("isom")]), "truncated");
  });

  test("refuses short hdlr box (< 20 bytes) as truncated without RangeError", () => {
    const shortHdlr = box("hdlr", [0, 0, 0, 0, 0, 0, 0, 0]); // 16-byte box
    const bytes = concat(ftyp(), moov([mvhd(600, 600), trak([mdia([shortHdlr])])]));
    try {
      validateAdClip(bytes);
      expect.fail("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidAdClipError);
      expect((error as InvalidAdClipError).reason).toBe("truncated");
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  test("refuses zero duration and zero timescale as zero-duration", () => {
    expectRejection(concat(ftyp(), moov([mvhd(600, 0), videoTrak("avc1")])), "zero-duration");
    expectRejection(concat(ftyp(), moov([mvhd(0, 600), videoTrak("avc1")])), "zero-duration");
  });

  test("refuses clip exceeding AD_CLIP_MAX_DURATION_SECONDS as too-long", () => {
    expectRejection(
      concat(ftyp(), moov([mvhd(1, AD_CLIP_MAX_DURATION_SECONDS + 1), videoTrak("avc1")])),
      "too-long",
    );
  });

  test("refuses HEVC (hvc1) track as not-h264", () => {
    expectRejection(concat(ftyp(), moov([mvhd(600, 600), videoTrak("hvc1")])), "not-h264");
  });

  test("refuses avc1 sample entry missing avcC child as not-h264", () => {
    expectRejection(
      concat(ftyp(), moov([mvhd(600, 600), videoTrak("avc1", { withAvcC: false })])),
      "not-h264",
    );
  });

  test("refuses file with one H.264 video track and one HEVC video track as not-h264", () => {
    expectRejection(
      concat(ftyp(), moov([mvhd(600, 600), videoTrak("avc1"), videoTrak("hvc1")])),
      "not-h264",
    );
  });

  test("refuses trak missing mdia as not-mp4", () => {
    expectRejection(concat(ftyp(), moov([mvhd(600, 600), trak([hdlr("vide")])])), "not-mp4");
  });

  test("refuses trak missing hdlr as not-mp4", () => {
    expectRejection(
      concat(
        ftyp(),
        moov([mvhd(600, 600), trak([mdia([minf([stbl([stsd(sampleEntry("avc1", [avcC()]))])])])])]),
      ),
      "not-mp4",
    );
  });

  test("refuses largesize box header below 16 bytes as truncated", () => {
    // size == 1 promises a 64-bit largesize, but only 12 bytes exist.
    expectRejection(new Uint8Array([...u32(1), ...type4("ftyp"), 0, 0, 0, 0]), "truncated");
  });

  test("accepts valid tiny H.264 MP4 (avc1 and avc3 with avcC) and returns ValidatedAdClip", () => {
    const bytes = tinyClip();
    expect(validateAdClip(bytes)).toEqual({
      sizeBytes: bytes.byteLength,
      durationSeconds: 1,
      timescale: 600,
      durationUnits: 600,
    });

    // A second valid clip: avc3 entry, 30 fps * 1 s = timescale 900.
    const avc3 = concat(ftyp(), moov([mvhd(900, 900), videoTrak("avc3")]));
    expect(validateAdClip(avc3)).toEqual({
      sizeBytes: avc3.byteLength,
      durationSeconds: 1,
      timescale: 900,
      durationUnits: 900,
    });

    // mvhd version 1 (64-bit duration) parses to the same duration.
    const v1 = concat(ftyp(), moov([mvhd(600, 600, 1), videoTrak("avc1")]));
    expect(validateAdClip(v1)).toEqual({
      sizeBytes: v1.byteLength,
      durationSeconds: 1,
      timescale: 600,
      durationUnits: 600,
    });

    // A size-0 ("extends to end") moov is still found.
    const sized = concat(ftyp(), box("moov", [mvhd(600, 600), videoTrak("avc1")].flat(), "zero"));
    expect(validateAdClip(sized).durationUnits).toBe(600);

    // A valid clip and an invalid one give different outcomes — the
    // validator is not an identity function in disguise.
    expect(() => validateAdClip(new Uint8Array(64))).toThrowError(InvalidAdClipError);
    expect(validateAdClip(bytes).durationUnits).toBe(600);
  });

  test("reads a 64-bit largesize box and refuses a bad largesize header", () => {
    const sized = concat(ftyp(), box("moov", [mvhd(600, 600), videoTrak("avc1")].flat(), "large"));
    expect(validateAdClip(sized).durationUnits).toBe(600);

    const withLarge = (high: number, low: number, extra = 0): Uint8Array =>
      new Uint8Array([
        ...ftyp(),
        ...u32(1),
        ...type4("free"),
        ...u32(high),
        ...u32(low),
        ...new Array<number>(extra).fill(0),
      ]);
    // High word set: the size cannot be a real in-budget size.
    expectRejection(withLarge(1, 16), "too-large");
    // Low word above the byte budget.
    expectRejection(withLarge(0, AD_CLIP_MAX_BYTES + 1), "too-large");
    // Smaller than its own 16-byte header.
    expectRejection(withLarge(0, 15), "truncated");
    // Claims more bytes than remain.
    expectRejection(withLarge(0, 64, 8), "truncated");
  });

  test("refuses a normal box whose declared size is below 8 or above the byte budget", () => {
    expectRejection(concat(ftyp(), [...u32(7), ...type4("free")]), "truncated");
    expectRejection(concat(ftyp(), [...u32(AD_CLIP_MAX_BYTES + 1), ...type4("free")]), "too-large");
  });

  test("requires ftyp first, with a payload of at least 8 bytes", () => {
    expectRejection(concat(moov([mvhd(600, 600), videoTrak("avc1")]), ftyp()), "not-mp4");
    expectRejection(concat(box("ftyp", type4("isom"))), "truncated");
  });

  test("accepts a clip whose standard brand is only a compatible brand", () => {
    const clip = concat(ftyp("xxxx", ["yyyy", "mp42"]), moov([mvhd(600, 600), videoTrak("avc1")]));
    expect(validateAdClip(clip).durationSeconds).toBe(1);
  });

  test("refuses malformed mvhd boxes", () => {
    const wrap = (mvhdBox: number[]): Uint8Array =>
      concat(ftyp(), moov([mvhdBox, videoTrak("avc1")]));
    // No payload at all, so no version byte.
    expectRejection(wrap(box("mvhd", [])), "truncated");
    // Version 0 payload shorter than 20 bytes.
    expectRejection(wrap(box("mvhd", [0, 0, 0, 0, 0, 0, 0, 0])), "truncated");
    // Version 1 payload shorter than 32 bytes.
    expectRejection(wrap(box("mvhd", [1, 0, 0, 0, ...new Array<number>(20).fill(0)])), "truncated");
    // Unknown version.
    expectRejection(wrap(box("mvhd", [2, ...new Array<number>(39).fill(0)])), "not-mp4");
  });

  test("reads the high word of a version 1 mvhd duration", () => {
    // duration = 2^32 units at timescale 2^31 -> 2 s, which only parses if the high word counts.
    const body = [
      1,
      0,
      0,
      0,
      ...new Array<number>(16).fill(0),
      ...u32(2 ** 31),
      ...u32(1),
      ...u32(0),
    ];
    const clip = concat(ftyp(), moov([box("mvhd", body), videoTrak("avc1")]));
    expect(validateAdClip(clip)).toMatchObject({ durationSeconds: 2, durationUnits: 2 ** 32 });
  });

  test("ignores non-video tracks and non-trak boxes inside moov, and needs at least one video track", () => {
    const audio = trak([mdia([hdlr("soun")])]);
    const clip = concat(ftyp(), moov([mvhd(600, 600), box("udta", []), audio, videoTrak("avc1")]));
    expect(validateAdClip(clip).durationUnits).toBe(600);
    expectRejection(concat(ftyp(), moov([mvhd(600, 600), audio])), "not-h264");
  });

  test("refuses a video track missing minf, stbl or stsd", () => {
    const wrap = (mdiaChildren: number[][]): Uint8Array =>
      concat(ftyp(), moov([mvhd(600, 600), trak([mdia(mdiaChildren)])]));
    expectRejection(wrap([hdlr("vide")]), "not-mp4");
    expectRejection(wrap([hdlr("vide"), minf([])]), "not-mp4");
    expectRejection(wrap([hdlr("vide"), minf([stbl([])])]), "not-mp4");
  });

  test("refuses malformed stsd and sample entries", () => {
    const wrapStsd = (stsdBox: number[]): Uint8Array =>
      concat(ftyp(), moov([mvhd(600, 600), trak([mdia([hdlr("vide"), minf([stbl([stsdBox])])])])]));
    // stsd payload below 16 bytes.
    expectRejection(wrapStsd(box("stsd", [0, 0, 0, 0])), "truncated");
    // Zero sample entries.
    expectRejection(
      wrapStsd(box("stsd", [0, 0, 0, 0, ...u32(0), 0, 0, 0, 0, 0, 0, 0, 0])),
      "not-h264",
    );
    // Entry count promises one but no room for an entry header.
    expectRejection(wrapStsd(box("stsd", [0, 0, 0, 0, ...u32(1), 0, 0, 0, 0])), "truncated");
    // avc1 entry declared below 86 bytes.
    expectRejection(wrapStsd(stsd(box("avc1", new Array<number>(20).fill(0)))), "truncated");
    // avc1 entry declaring more bytes than the stsd holds.
    const overrun = sampleEntry("avc1", [avcC()]);
    overrun.splice(0, 4, ...u32(overrun.length + 100));
    expectRejection(wrapStsd(stsd(overrun)), "truncated");
  });

  test("refuses hostile Uint8Array subclasses without leaking a non-InvalidAdClipError", () => {
    class BadLength extends Uint8Array {
      override get byteLength(): number {
        return Number.NaN;
      }
    }
    expectRejection(new BadLength(16), "not-mp4");
    class BadBuffer extends Uint8Array {
      override get buffer(): ArrayBuffer {
        return {} as ArrayBuffer;
      }
    }
    expectRejection(new BadBuffer(16), "not-mp4");
  });
});
