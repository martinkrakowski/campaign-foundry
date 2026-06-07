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
let warned = false;

/**
 * Register the bundled fonts with the canvas engine, once. Searches the cwd
 * upward (the CLI runs from the repo root, Nitro from apps/api) for an
 * assets/fonts directory that actually contains the fonts, mirroring the .env
 * loader — an empty or partial directory is skipped so it can't shadow a real
 * one further up. If none are found, copy still renders via a generic fallback
 * (with one warning) rather than crashing the run.
 */
export function registerBundledFonts(): void {
  if (registered) return;

  for (const dir of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "../..")]) {
    const fontsDir = resolve(dir, "assets/fonts");
    if (!existsSync(fontsDir)) continue;
    let registeredAny = false;
    for (const [file, family] of BUNDLED_FONTS) {
      const path = resolve(fontsDir, file);
      if (existsSync(path) && GlobalFonts.registerFromPath(path, family)) {
        registeredAny = true; // null return = registration failed, so check it
      }
    }
    if (registeredAny) {
      registered = true;
      return; // first directory with real fonts wins
    }
  }

  if (!warned) {
    warned = true;
    console.warn(
      "[fonts] No bundled fonts found under assets/fonts (searched cwd upward); " +
        "headline copy will fall back to a system sans-serif.",
    );
  }
}
