import { PDFDocument, StandardFonts, type PDFPage } from "pdf-lib";

/** Footer stamped on every proof — makes the RGB-only limitation explicit (ProofMetadataEmbedding). */
const PROOF_FOOTER = "Campaign Foundry proof — RGB asset, not colour-managed";
const CROP_MARK_LEN = 16;
const PAGE_MARGIN = 24;
const FOOTER_BAND = 28;

/**
 * Wrap one rendered PNG in a print-proof PDF: the image, crop marks at its four
 * corners, and a footer stating the RGB limitation.
 *
 * **This is the proof's BYTES and nothing else** (PT-4e) — where they go is the
 * exporter's business. It lives beside `safe-path.ts` rather than inside either
 * adapter because it was, until this was extracted, a private method of
 * `FileSystemExporter`: the day there is a second exporter there would have been
 * a second copy of the page geometry, free to drift a pixel, and a proof is
 * something a customer signs off on. Both exporters call this one, so the two
 * backends cannot disagree about what a proof looks like — only about where it
 * is written.
 */
export async function buildPrintProof(image: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const png = await pdf.embedPng(image);

  const page = pdf.addPage([
    png.width + PAGE_MARGIN * 2,
    png.height + PAGE_MARGIN * 2 + FOOTER_BAND,
  ]);
  const imgY = PAGE_MARGIN + FOOTER_BAND;
  page.drawImage(png, { x: PAGE_MARGIN, y: imgY, width: png.width, height: png.height });
  drawCropMarks(page, PAGE_MARGIN, imgY, png.width, png.height);
  page.drawText(PROOF_FOOTER, { x: PAGE_MARGIN, y: PAGE_MARGIN, size: 10, font });

  return pdf.save();
}

/** A short cross at each corner of the placed image, in the page's margins. */
function drawCropMarks(page: PDFPage, x: number, y: number, w: number, h: number): void {
  const corners: ReadonlyArray<readonly [number, number]> = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ];
  for (const [cx, cy] of corners) {
    page.drawLine({
      start: { x: cx - CROP_MARK_LEN, y: cy },
      end: { x: cx + CROP_MARK_LEN, y: cy },
      thickness: 0.5,
    });
    page.drawLine({
      start: { x: cx, y: cy - CROP_MARK_LEN },
      end: { x: cx, y: cy + CROP_MARK_LEN },
      thickness: 0.5,
    });
  }
}
