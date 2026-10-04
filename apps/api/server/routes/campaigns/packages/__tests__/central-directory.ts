import { expect } from "vitest";

/** DOS date 1980-01-01 — the earliest value a zip entry may carry. */
const DOS_DATE_1980_01_01 = 0x0021;

/** One entry as the central directory describes it. */
export interface CentralEntry {
  readonly name: string;
  readonly size: number;
  readonly crc: number;
}

/**
 * Walk a store-only zip's central directory and, for each entry, check that the
 * offset it records points at a local header describing the SAME file — signature,
 * UTF-8 flag, store method, DOS date, CRC and size.
 *
 * **Extracted verbatim from `packages.test.ts` (PT-4h2) so both backends are read
 * by the same parser.** The claim under test there and in `packages.s3.test.ts` is
 * that a zip streamed over objects is byte-compatible with one streamed off the
 * output volume, and "compatible" is only checkable by a decoder that knows
 * nothing about either: a copy of this function in the s3 file would let the two
 * drift, and a drift would look like agreement. It asserts as it parses, which is
 * why it takes `expect` from vitest rather than returning a structure a caller
 * checks — the header consistency is the assertion.
 */
export function parseCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = buf.subarray(buf.length - 22);
  expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
  const entries = eocd.readUInt16LE(10);
  const cdSize = eocd.readUInt32LE(12);
  const cdOffset = eocd.readUInt32LE(16);
  const cd = buf.subarray(cdOffset, cdOffset + cdSize);
  const files: CentralEntry[] = [];
  let p = 0;
  for (let i = 0; i < entries; i++) {
    expect(cd.readUInt32LE(p)).toBe(0x02014b50);
    expect(cd.readUInt16LE(p + 8)).toBe(0x0800); // UTF-8 names
    expect(cd.readUInt16LE(p + 10)).toBe(0); // store
    expect(cd.readUInt16LE(p + 14)).toBe(DOS_DATE_1980_01_01);
    const crc = cd.readUInt32LE(p + 16);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    // The local header at the recorded offset must describe the same file.
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(buf.readUInt16LE(localOffset + 6)).toBe(0x0800);
    expect(buf.readUInt16LE(localOffset + 8)).toBe(0);
    expect(buf.readUInt16LE(localOffset + 12)).toBe(DOS_DATE_1980_01_01);
    expect(buf.readUInt32LE(localOffset + 14)).toBe(crc);
    expect(buf.readUInt32LE(localOffset + 22)).toBe(size);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    expect(buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString("utf8")).toBe(
      name,
    );
    files.push({ name, size, crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
