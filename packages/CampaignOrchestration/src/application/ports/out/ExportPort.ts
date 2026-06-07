/**
 * ExportPort — outbound port for persistence. The use case constructs the
 * relative paths (OutputDirectoryConvention); the adapter resolves them against
 * the configured output root and must not infer paths itself. Implemented by
 * Distribution.
 */
export interface ExportPort {
  /** Persist a rendered creative (PNG bytes) at a relative path under the output root. */
  saveToDirectory(imageBuffer: Uint8Array, relativePath: string): Promise<void>;
  /** Wrap a creative in a print-proof PDF and persist it at a relative path. */
  generatePrintProof(imageBuffer: Uint8Array, relativePath: string): Promise<void>;
}
