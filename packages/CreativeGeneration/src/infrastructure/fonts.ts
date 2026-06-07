import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";

/**
 * Bundled, OFL-licensed fonts shipped under <repo>/assets/fonts so campaign copy
 * renders identically on every reviewer's machine — macOS, Windows, Linux — with
 * no system fonts assumed. "Inter" is the sans default; "Lora" a serif option
 * (pick either via MESSAGE_FONT / the NodeCanvasCompositor constructor).
 */
const BUNDLED_FONTS: ReadonlyArray<readonly [file: string, family: string]> = [
  ["Inter-Regular.ttf", "Inter"],
  ["Inter-Bold.ttf", "Inter"],
  ["Lora-Regular.ttf", "Lora"],
  ["Lora-Bold.ttf", "Lora"],
];

let registered = false;

/**
 * Register the bundled fonts with the canvas engine exactly once. Searches the
 * cwd upward (the CLI runs from the repo root, Nitro from apps/api) for the
 * assets/fonts directory, mirroring the .env loader. If it can't be found the
 * call is a no-op, so copy still renders via a generic fallback rather than
 * crashing the run.
 */
export function registerBundledFonts(): void {
  if (registered) return;

  for (const dir of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "../..")]) {
    const fontsDir = resolve(dir, "assets/fonts");
    if (!existsSync(fontsDir)) continue;
    for (const [file, family] of BUNDLED_FONTS) {
      const path = resolve(fontsDir, file);
      if (existsSync(path)) GlobalFonts.registerFromPath(path, family);
    }
    registered = true;
    return; // first matching directory wins
  }
}
