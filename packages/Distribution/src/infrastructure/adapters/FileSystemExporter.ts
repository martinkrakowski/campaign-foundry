import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PDFDocument, StandardFonts, type PDFPage } from "pdf-lib";
import type { ExportPort } from "@campaignfoundry/CampaignOrchestration";
import { resolveSafe } from "../safe-path.js";

/** Footer stamped on every proof — makes the RGB-only limitation explicit (ProofMetadataEmbedding). */
const PROOF_FOOTER = "Campaign Foundry proof — RGB asset, not colour-managed";
const CROP_MARK_LEN = 16;
const PAGE_MARGIN = 24;
const FOOTER_BAND = 28;

/**
 * FileSystemExporter — ExportPort adapter. Persists rendered creatives and
 * wraps them in print-proof PDFs (crop marks + RGB footer). The use case owns
 * the relative paths; this adapter only resolves them under the output root.
 */
export class FileSystemExporter implements ExportPort {
  constructor(private readonly outputRoot: string) {}

  async saveToDirectory(imageBuffer: Uint8Array, relativePath: string): Promise<void> {
    const target = resolveSafe(this.outputRoot, relativePath, "write");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, imageBuffer);
  }

  async generatePrintProof(imageBuffer: Uint8Array, relativePath: string): Promise<void> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const png = await pdf.embedPng(imageBuffer);

    const page = pdf.addPage([
      png.width + PAGE_MARGIN * 2,
      png.height + PAGE_MARGIN * 2 + FOOTER_BAND,
    ]);
    const imgY = PAGE_MARGIN + FOOTER_BAND;
    page.drawImage(png, { x: PAGE_MARGIN, y: imgY, width: png.width, height: png.height });
    this.drawCropMarks(page, PAGE_MARGIN, imgY, png.width, png.height);
    page.drawText(PROOF_FOOTER, { x: PAGE_MARGIN, y: PAGE_MARGIN, size: 10, font });

    const target = resolveSafe(this.outputRoot, relativePath, "write");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await pdf.save());
  }

  private drawCropMarks(page: PDFPage, x: number, y: number, w: number, h: number): void {
    const corners: ReadonlyArray<readonly [number, number]> = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ];
    for (const [cx, cy] of corners) {
      page.drawLine({ start: { x: cx - CROP_MARK_LEN, y: cy }, end: { x: cx + CROP_MARK_LEN, y: cy }, thickness: 0.5 });
      page.drawLine({ start: { x: cx, y: cy - CROP_MARK_LEN }, end: { x: cx, y: cy + CROP_MARK_LEN }, thickness: 0.5 });
    }
  }
}
