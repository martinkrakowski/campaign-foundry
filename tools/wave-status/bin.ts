import { pathToFileURL } from "node:url";
import { resolvePort, startServer, type ServerHandle } from "./server.js";
import { WAVE_LOG_ROOT } from "./lib/collect.js";

export interface MainEnv {
  readonly PORT?: string;
  /** Explicit root wins; tests inject a temp dir so collection never walks `/tmp`. */
  readonly root?: string;
  readonly WAVE_LOG_ROOT?: string;
}

export function resolveRoot(env: MainEnv): string {
  return env.root ?? env.WAVE_LOG_ROOT ?? WAVE_LOG_ROOT;
}

export async function main(env: MainEnv): Promise<ServerHandle> {
  const port = resolvePort(env);
  const handle = await startServer({ port, root: resolveRoot(env) });
  console.log(`  wave-status serving ${handle.url} — read-only: it starts, kills and merges nothing.`);
  return handle;
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
