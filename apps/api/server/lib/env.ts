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
  for (const dir of [process.cwd(), projectRoot()]) {
    applyEnvFile(resolve(dir, ".env.local"));
    applyEnvFile(resolve(dir, ".env"));
  }
  // Mark loaded only after a clean pass — if a read throws, a later call retries
  // rather than being stuck with process.env half-populated.
  loaded = true;
}
