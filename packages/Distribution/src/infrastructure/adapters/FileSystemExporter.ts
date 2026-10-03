import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExportPort } from "@campaignfoundry/CampaignOrchestration";
import { buildPrintProof } from "../print-proof.js";
import { resolveSafe } from "../safe-path.js";

/**
 * FileSystemExporter — ExportPort adapter. Persists rendered creatives and
 * wraps them in print-proof PDFs (crop marks + RGB footer). The use case owns
 * the relative paths; this adapter only resolves them under the output root.
 *
 * The proof's bytes come from `buildPrintProof`, which `ObjectExporter` calls
 * too (PT-4e) — so this class is now only about WHERE, and the two exporters
 * cannot differ on what a proof is.
 */
export class FileSystemExporter implements ExportPort {
  constructor(private readonly outputRoot: string) {}

  async saveToDirectory(imageBuffer: Uint8Array, relativePath: string): Promise<void> {
    const target = resolveSafe(this.outputRoot, relativePath, "write");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, imageBuffer);
  }

  async generatePrintProof(imageBuffer: Uint8Array, relativePath: string): Promise<void> {
    // The PDF first, then the path: unchanged from before the extraction, so a
    // path that escapes the root is still refused AFTER an un-embeddable image
    // would have thrown, and not before.
    const pdf = await buildPrintProof(imageBuffer);
    const target = resolveSafe(this.outputRoot, relativePath, "write");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, pdf);
  }

  /** Idempotent: `force` swallows ENOENT, so a slot that never had a clip is a no-op. */
  async remove(relativePath: string): Promise<void> {
    const target = resolveSafe(this.outputRoot, relativePath, "remove");
    await rm(target, { force: true });
  }
}
