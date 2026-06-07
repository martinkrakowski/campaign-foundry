import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// Search cwd upward (CLI runs from the repo root, Nitro from apps/api). First
// value wins, so .env.local takes precedence over .env, and a real shell env
// variable beats both.
for (const dir of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "../..")]) {
  applyEnvFile(resolve(dir, ".env.local"));
  applyEnvFile(resolve(dir, ".env"));
}
