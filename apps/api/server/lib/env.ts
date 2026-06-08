import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";

/** Apply KEY=VALUE lines from a file without overriding vars already in process.env. */
function applyEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

let loaded = false;

/**
 * Load .env.local / .env into process.env (idempotent). Must be **called** — a
 * bare `import "./env.js"` for its side effect gets tree-shaken by Nitro's
 * bundler, which silently left GEMINI_API_KEY unset in the server and fell the
 * pipeline back to the procedural generator (no real Imagen output).
 *
 * Loads from the project root and the cwd (the CLI runs at the repo root, Nitro in
 * apps/api). First value wins, so .env.local beats .env and a real shell env var
 * beats both.
 */
export function loadEnv(): void {
  if (loaded) return;
  // Dedupe: projectRoot() returns cwd when started from the repo root (the CLI),
  // so a plain [cwd, projectRoot()] would read the same .env files twice.
  for (const dir of new Set([process.cwd(), projectRoot()])) {
    applyEnvFile(resolve(dir, ".env.local"));
    applyEnvFile(resolve(dir, ".env"));
  }

  // Announce, once, what image generation will actually do — so a keyless run (or a
  // dev server started before keys were added) is self-evident in the logs instead of
  // silently falling back to procedural gradients.
  const providers: string[] = [];
  // Mirror pipeline.ts's `geminiKey = GEMINI_API_KEY ?? GOOGLE_API_KEY` so this log
  // reflects exactly when Imagen runs — and name whichever key is actually set.
  if (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY) {
    const keyName = process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";
    providers.push(`imagen (${keyName} ✓)`);
  }
  if (process.env.OPENROUTER_API_KEY) providers.push("openrouter (OPENROUTER_API_KEY ✓)");
  if (providers.length > 0) {
    console.log(`[env] image generation: ${providers.join(", ")} — procedural fallback`);
  } else {
    console.warn(
      "[env] image generation: procedural only — no GenAI keys detected. " +
        "Add OPENROUTER_API_KEY or GEMINI_API_KEY to .env.local for real imagery, then restart the dev server.",
    );
  }

  // Mark loaded only after a clean pass — if a read throws, a later call retries
  // rather than being stuck with process.env half-populated.
  loaded = true;
}
