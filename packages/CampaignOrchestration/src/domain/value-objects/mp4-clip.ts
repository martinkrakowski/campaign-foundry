/**
 * Pure, adapter-free H.264 MP4 clip validation (ISO BMFF byte walking).
 *
 * The orchestrator accepts ad-clip bytes from untrusted upload boundaries, so
 * validation is total: every parse either returns a `ValidatedAdClip` with
 * plain numeric fields or throws `InvalidAdClipError` with a stable rejection
 * reason. No `RangeError`, no raw exception, no node builtin, no clock, no
 * randomness — the module is a deterministic function of its input bytes.
 *
 * Bounds discipline:
 * - Every box offset and size is checked against the enclosing `end` and
 *   `AD_CLIP_MAX_BYTES` before any read or descent, so a hostile claimed
 *   length is refused before any allocation or loop.
 * - `AD_CLIP_MAX_BOXES` bounds the total number of box visits across the
 *   whole parse, which is the real cost bound: file size alone is not.
 * - Parsed values are plain numbers; no object is ever assigned from input
 *   keys, so there is nothing to prototype-pollute.
 */

/**
 * Provisional caps for ad clips.
 *
 * 10 MiB and 30 s are *provisional* — flag them in the PR's Challenge section.
 * `AD_CLIP_MAX_BOXES` is not provisional: it is a hard parse-cost cap across
 * the whole walk, independent of file size.
 */
export const AD_CLIP_MAX_BYTES = 10 * 1024 * 1024;
export const AD_CLIP_MAX_DURATION_SECONDS = 30;
export const AD_CLIP_MAX_BOXES = 4096;

/** Why `validateAdClip` refused a byte payload. */
export type AdClipRejectionReason =
  | "not-mp4"
  | "truncated"
  | "not-h264"
  | "too-large"
  | "too-long"
  | "zero-duration";

/** The only error `validateAdClip` ever throws. */
export class InvalidAdClipError extends Error {
  /** The stable machine-readable rejection reason. */
  readonly reason: AdClipRejectionReason;

  constructor(reason: AdClipRejectionReason, message: string) {
    super(message);
    this.name = "InvalidAdClipError";
    this.reason = reason;
  }
}

/** What a validated ad clip looks like — plain numbers only. */
export interface ValidatedAdClip {
  /** The input payload size in bytes. */
  readonly sizeBytes: number;
  /** The `mvhd` duration in seconds. */
  readonly durationSeconds: number;
  /** The `mvhd` timescale (units per second). */
  readonly timescale: number;
  /** The raw `mvhd` duration in timescale units. */
  readonly durationUnits: number;
}

/** MP4 brands an ad clip may claim in `ftyp`. */
const STANDARD_MP4_BRANDS = new Set(["isom", "iso2", "mp41", "mp42", "avc1", "M4V "]);

/** H.264 sample entry types accepted in `stsd`. */
const H264_SAMPLE_ENTRY_TYPES = new Set(["avc1", "avc3"]);

/** Mutable parse state shared by the box-walking helpers. */
interface ParseState {
  boxCount: number;
}

/** A parsed box header. */
interface BoxHeader {
  readonly type: string;
  /** Offset just past the header (8 or 16 bytes into the box). */
  readonly headerEnd: number;
  /** Offset just past the whole box; never past `end`. */
  readonly boxEnd: number;
}

/** ASCII box type from the 4 bytes at `offset + 4`. */
function readBoxType(view: DataView, offset: number): string {
  let type = "";
  for (let i = 0; i < 4; i++) type += String.fromCharCode(view.getUint8(offset + 4 + i));
  return type;
}

/** ASCII 4-byte field at `offset`. */
function readFourCC(view: DataView, offset: number): string {
  let value = "";
  for (let i = 0; i < 4; i++) value += String.fromCharCode(view.getUint8(offset + i));
  return value;
}

/**
 * Reads one box header at `offset`, advancing the shared box-count budget.
 * Every size is bounds-checked against `end` and `AD_CLIP_MAX_BYTES` before
 * the caller descends, so no `getUint*` read can escape the view.
 */
function readBoxHeader(view: DataView, offset: number, end: number, state: ParseState): BoxHeader {
  state.boxCount += 1;
  if (state.boxCount > AD_CLIP_MAX_BOXES) {
    throw new InvalidAdClipError(
      "not-mp4",
      "box-count budget exceeded (> AD_CLIP_MAX_BOXES box visits)",
    );
  }
  if (offset + 8 > end) {
    throw new InvalidAdClipError("truncated", "fewer than 8 bytes remain for a box header");
  }
  const size = view.getUint32(offset, false);
  const type = readBoxType(view, offset);
  if (size === 1) {
    // 64-bit largesize follows; the header is 16 bytes.
    if (offset + 16 > end) {
      throw new InvalidAdClipError("truncated", "largesize box header below 16 bytes");
    }
    const high = view.getUint32(offset + 8, false);
    const low = view.getUint32(offset + 12, false);
    if (high !== 0 || low > AD_CLIP_MAX_BYTES) {
      throw new InvalidAdClipError("too-large", "64-bit box size exceeds AD_CLIP_MAX_BYTES");
    }
    if (low < 16) {
      throw new InvalidAdClipError("truncated", "largesize box smaller than its own header");
    }
    if (offset + low > end) {
      throw new InvalidAdClipError("truncated", "largesize box extends past end of data");
    }
    return { type, headerEnd: offset + 16, boxEnd: offset + low };
  }
  if (size === 0) {
    // Size 0 means "extends to end of data".
    return { type, headerEnd: offset + 8, boxEnd: end };
  }
  if (size < 8) {
    throw new InvalidAdClipError("truncated", `box size ${size} is below the 8-byte minimum`);
  }
  if (size > AD_CLIP_MAX_BYTES) {
    throw new InvalidAdClipError("too-large", "box size exceeds AD_CLIP_MAX_BYTES");
  }
  if (size > end - offset) {
    throw new InvalidAdClipError("truncated", "box size extends past end of data");
  }
  return { type, headerEnd: offset + 8, boxEnd: offset + size };
}

/** Finds the first child box of the given type in `[start, end)`, or undefined. */
function findChildBox(
  view: DataView,
  start: number,
  end: number,
  type: string,
  state: ParseState,
): BoxHeader | undefined {
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(view, offset, end, state);
    if (header.type === type) return header;
    offset = header.boxEnd;
  }
  return undefined;
}

/** Like `findChildBox` but throws `not-mp4` when absent. */
function requireChildBox(
  view: DataView,
  start: number,
  end: number,
  type: string,
  state: ParseState,
  message: string,
): BoxHeader {
  const box = findChildBox(view, start, end, type, state);
  if (box === undefined) throw new InvalidAdClipError("not-mp4", message);
  return box;
}

/** Validates `ftyp` as the first top-level box with a standard MP4 brand. */
function requireFtyp(view: DataView, end: number, state: ParseState): void {
  const ftyp = readBoxHeader(view, 0, end, state);
  if (ftyp.type !== "ftyp") {
    throw new InvalidAdClipError("not-mp4", "first top-level box is not ftyp");
  }
  if (ftyp.boxEnd - ftyp.headerEnd < 8) {
    throw new InvalidAdClipError("truncated", "ftyp payload below 8 bytes");
  }
  if (STANDARD_MP4_BRANDS.has(readFourCC(view, ftyp.headerEnd))) return;
  for (let offset = ftyp.headerEnd + 4; offset + 4 <= ftyp.boxEnd; offset += 4) {
    if (STANDARD_MP4_BRANDS.has(readFourCC(view, offset))) return;
  }
  throw new InvalidAdClipError("not-mp4", "no standard MP4 brand in ftyp");
}

/**
 * Reads the `mvhd` FullBox inside `moov`, returning duration facts. Refuses
 * unknown versions as `not-mp4`, short payloads as `truncated`, and zero or
 * overflowing durations as `zero-duration` / `too-long`.
 */
function readMvhd(
  view: DataView,
  moov: BoxHeader,
  state: ParseState,
): { timescale: number; duration: number; durationSeconds: number } {
  const mvhd = requireChildBox(
    view,
    moov.headerEnd,
    moov.boxEnd,
    "mvhd",
    state,
    "moov has no mvhd",
  );
  const payloadStart = mvhd.headerEnd;
  const payloadSize = mvhd.boxEnd - payloadStart;
  const version = view.getUint8(payloadStart);
  let timescale: number;
  let duration: number;
  if (version === 0) {
    if (payloadSize < 20) {
      throw new InvalidAdClipError("truncated", "mvhd v0 payload below 20 bytes");
    }
    timescale = view.getUint32(payloadStart + 12, false);
    duration = view.getUint32(payloadStart + 16, false);
  } else if (version === 1) {
    if (payloadSize < 32) {
      throw new InvalidAdClipError("truncated", "mvhd v1 payload below 32 bytes");
    }
    timescale = view.getUint32(payloadStart + 20, false);
    duration =
      view.getUint32(payloadStart + 24, false) * 4294967296 +
      view.getUint32(payloadStart + 28, false);
  } else {
    throw new InvalidAdClipError("not-mp4", `unsupported mvhd version ${version}`);
  }
  if (timescale === 0 || duration === 0) {
    throw new InvalidAdClipError("zero-duration", "mvhd timescale or duration is zero");
  }
  const durationSeconds = duration / timescale;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new InvalidAdClipError("zero-duration", "mvhd duration is not a positive span");
  }
  if (durationSeconds > AD_CLIP_MAX_DURATION_SECONDS) {
    throw new InvalidAdClipError(
      "too-long",
      `clip duration ${durationSeconds}s exceeds AD_CLIP_MAX_DURATION_SECONDS`,
    );
  }
  return { timescale, duration, durationSeconds };
}

/**
 * Checks one `trak`: its `mdia` -> `hdlr` must say `vide`; non-video tracks
 * are ignored. A video track must carry `minf` -> `stbl` -> `stsd` with an
 * `avc1`/`avc3` sample entry that has an `avcC` child. Throws `not-mp4` for
 * missing `mdia`/`hdlr`, `truncated` for short boxes, and `not-h264` for
 * anything that is not H.264.
 */
function checkVideoTrak(view: DataView, trak: BoxHeader, state: ParseState): void {
  const mdia = requireChildBox(
    view,
    trak.headerEnd,
    trak.boxEnd,
    "mdia",
    state,
    "trak has no mdia",
  );
  const hdlr = requireChildBox(
    view,
    mdia.headerEnd,
    mdia.boxEnd,
    "hdlr",
    state,
    "mdia has no hdlr",
  );
  if (hdlr.boxEnd - hdlr.headerEnd + 8 < 20) {
    throw new InvalidAdClipError("truncated", "hdlr box below 20 bytes");
  }
  const handlerType = readFourCC(view, hdlr.headerEnd + 8);
  if (handlerType !== "vide") return;

  const minf = requireChildBox(
    view,
    mdia.headerEnd,
    mdia.boxEnd,
    "minf",
    state,
    "mdia has no minf",
  );
  const stbl = requireChildBox(
    view,
    minf.headerEnd,
    minf.boxEnd,
    "stbl",
    state,
    "minf has no stbl",
  );
  const stsd = requireChildBox(
    view,
    stbl.headerEnd,
    stbl.boxEnd,
    "stsd",
    state,
    "stbl has no stsd",
  );
  if (stsd.boxEnd - stsd.headerEnd + 8 < 16) {
    throw new InvalidAdClipError("truncated", "stsd box below 16 bytes");
  }
  const entryCount = view.getUint32(stsd.headerEnd + 4, false);
  if (entryCount < 1) {
    throw new InvalidAdClipError("not-h264", "stsd has no sample entries");
  }
  const entryStart = stsd.headerEnd + 8;
  if (entryStart + 8 > stsd.boxEnd) {
    throw new InvalidAdClipError("truncated", "stsd has no room for a sample entry header");
  }
  const entrySize = view.getUint32(entryStart, false);
  const entryType = readFourCC(view, entryStart + 4);
  if (!H264_SAMPLE_ENTRY_TYPES.has(entryType)) {
    throw new InvalidAdClipError("not-h264", `sample entry ${entryType} is not H.264`);
  }
  if (entrySize < 86) {
    throw new InvalidAdClipError("truncated", "sample entry box below 86 bytes");
  }
  const entryEnd = entryStart + entrySize;
  if (entryEnd > stsd.boxEnd) {
    throw new InvalidAdClipError("truncated", "sample entry extends past stsd");
  }
  const avcC = findChildBox(view, entryStart + 86, entryEnd, "avcC", state);
  if (avcC === undefined) {
    throw new InvalidAdClipError("not-h264", "H.264 sample entry has no avcC child");
  }
}

/**
 * Validates untrusted ad-clip bytes as an H.264 MP4 clip. Throws only
 * `InvalidAdClipError`; returns the plain-number `ValidatedAdClip`.
 */
export function validateAdClip(bytes: Uint8Array): ValidatedAdClip {
  let byteLength: number;
  try {
    if (!(bytes instanceof Uint8Array)) {
      throw new InvalidAdClipError("not-mp4", "input is not a Uint8Array");
    }
    byteLength = bytes.byteLength;
    if (typeof byteLength !== "number" || !Number.isFinite(byteLength)) {
      throw new InvalidAdClipError("not-mp4", "input byteLength is not a finite number");
    }
  } catch (error) {
    if (error instanceof InvalidAdClipError) throw error;
    // null/undefined input, a throwing byteLength getter, a proxy trap, etc.
    throw new InvalidAdClipError("not-mp4", "input is not readable as bytes");
  }
  if (byteLength === 0) {
    throw new InvalidAdClipError("not-mp4", "input is empty");
  }
  if (byteLength > AD_CLIP_MAX_BYTES) {
    throw new InvalidAdClipError("too-large", "input exceeds AD_CLIP_MAX_BYTES");
  }

  const state: ParseState = { boxCount: 0 };
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, byteLength);
    const end = byteLength;
    requireFtyp(view, end, state);

    let moov: BoxHeader | undefined;
    let offset = 0;
    while (offset < end) {
      const header = readBoxHeader(view, offset, end, state);
      if (header.type === "moov") moov = header;
      offset = header.boxEnd;
    }
    if (moov === undefined) throw new InvalidAdClipError("not-mp4", "no moov box");

    const duration = readMvhd(view, moov, state);

    let videoTrackCount = 0;
    let trakOffset = moov.headerEnd;
    while (trakOffset < moov.boxEnd) {
      const trak = readBoxHeader(view, trakOffset, moov.boxEnd, state);
      if (trak.type === "trak") {
        checkVideoTrak(view, trak, state);
        videoTrackCount += 1;
      }
      trakOffset = trak.boxEnd;
    }
    if (videoTrackCount < 1) {
      throw new InvalidAdClipError("not-h264", "no video track");
    }

    return {
      sizeBytes: byteLength,
      durationSeconds: duration.durationSeconds,
      timescale: duration.timescale,
      durationUnits: duration.duration,
    };
  } catch (error) {
    if (error instanceof InvalidAdClipError) throw error;
    // Armor: nothing above should throw a RangeError, and none escapes if it does.
    throw new InvalidAdClipError("not-mp4", "input is not parseable as an MP4 clip");
  }
}
