import { Readable } from "node:stream";
import { crc32 } from "node:zlib";

/** One file in the archive: sizes and CRC come from a first pass over the bytes. */
export interface ZipEntry {
  readonly name: string;
  readonly size: number;
  readonly crc: number;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const VERSION = 20;
/** General-purpose flag bit 11: file names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
/** DOS time 00:00:00. */
const DOS_TIME = 0;
/** DOS date 1980-01-01 — the earliest valid value (year 0 since 1980, month 1, day 1). */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/**
 * Measure a byte stream: total size and CRC-32 (node:zlib — no extra dependency),
 * one chunk at a time. This is the first pass; the bytes are re-read when streamed.
 */
export async function measure(chunks: AsyncIterable<Uint8Array>): Promise<{ size: number; crc: number }> {
  let size = 0;
  let crc = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    crc = crc32(chunk, crc);
  }
  return { size, crc: crc >>> 0 };
}

export function localHeader(entry: ZipEntry): Buffer {
  const name = Buffer.from(entry.name, "utf8");
  return Buffer.concat([
    u32(LOCAL_SIGNATURE),
    u16(VERSION),
    u16(FLAG_UTF8),
    u16(METHOD_STORE),
    u16(DOS_TIME),
    u16(DOS_DATE),
    u32(entry.crc),
    u32(entry.size),
    u32(entry.size),
    u16(name.length),
    u16(0),
    name,
  ]);
}

export function centralHeader(entry: ZipEntry, localOffset: number): Buffer {
  const name = Buffer.from(entry.name, "utf8");
  return Buffer.concat([
    u32(CENTRAL_SIGNATURE),
    u16(VERSION),
    u16(VERSION),
    u16(FLAG_UTF8),
    u16(METHOD_STORE),
    u16(DOS_TIME),
    u16(DOS_DATE),
    u32(entry.crc),
    u32(entry.size),
    u32(entry.size),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(localOffset),
    name,
  ]);
}

export function endOfCentralDirectory(count: number, directorySize: number, directoryOffset: number): Buffer {
  return Buffer.concat([
    u32(EOCD_SIGNATURE),
    u16(0),
    u16(0),
    u16(count),
    u16(count),
    u32(directorySize),
    u32(directoryOffset),
    u16(0),
  ]);
}

/**
 * Store-only (no compression) zip as a stream: each local header followed by the
 * file's bytes from `open`, then the central directory and EOCD. Nothing is
 * buffered beyond one chunk at a time; `entries` carry the sizes/CRCs so the
 * local headers can be emitted before the bytes.
 */
export function storeZipStream<E extends ZipEntry>(
  entries: readonly E[],
  open: (entry: E) => Readable,
): Readable {
  async function* chunks(): AsyncGenerator<Buffer> {
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const local = localHeader(entry);
      yield local;
      for await (const chunk of open(entry)) yield chunk as Buffer;
      centrals.push(centralHeader(entry, offset));
      offset += local.length + entry.size;
    }
    const directory = Buffer.concat(centrals);
    yield directory;
    yield endOfCentralDirectory(entries.length, directory.length, offset);
  }
  return Readable.from(chunks());
}
