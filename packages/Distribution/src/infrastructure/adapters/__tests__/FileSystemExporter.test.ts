import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { FileSystemExporter } from "../FileSystemExporter.js";

/** A small valid PNG for both saving and PDF embedding. */
const png = (): Uint8Array => {
  const c = createCanvas(8, 8);
  const g = c.getContext("2d");
  g.fillStyle = "#1473E6";
  g.fillRect(0, 0, 8, 8);
  return c.toBuffer("image/png");
};

describe("FileSystemExporter", () => {
  let root: string;
  let exporter: FileSystemExporter;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cf-export-"));
    exporter = new FileSystemExporter(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("saveToDirectory writes the bytes, creating nested directories", async () => {
    const bytes = png();
    await exporter.saveToDirectory(bytes, "hydra-bottle/1x1.png");
    const written = readFileSync(resolve(root, "hydra-bottle/1x1.png"));
    expect(Buffer.from(bytes).equals(written)).toBe(true);
  });

  test("generatePrintProof writes a valid PDF", async () => {
    await exporter.generatePrintProof(png(), "proofs/hydra-bottle.pdf");
    const pdf = readFileSync(resolve(root, "proofs/hydra-bottle.pdf"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(100);
  });

  test("saveToDirectory refuses a path that escapes the output root", async () => {
    await expect(exporter.saveToDirectory(png(), "../escape.png")).rejects.toThrow(
      /Refusing to write outside the output root/,
    );
  });

  test("generatePrintProof refuses a path that escapes the output root", async () => {
    await expect(exporter.generatePrintProof(png(), "../../escape.pdf")).rejects.toThrow(
      /Refusing to write outside the output root/,
    );
  });
});
