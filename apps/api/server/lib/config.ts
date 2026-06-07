import { resolve } from "node:path";

/** Absolute directory creatives are written to. Override with OUTPUT_DIR; defaults to ./output. */
export function outputRoot(): string {
  return resolve(process.env.OUTPUT_DIR ?? "output");
}
