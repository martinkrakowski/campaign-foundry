import { pathToFileURL } from "node:url";
import { resolvePort, startServer, type ServerHandle } from "./server.js";
import { LEGACY_WAVE_LOG_ROOT, WAVE_LOG_ROOT } from "./lib/collect.js";

export interface MainEnv {
  readonly PORT?: string;
  /** Explicit root wins; tests inject a temp dir so collection never walks the durable root. */
  readonly root?: string;
  readonly WAVE_LOG_ROOT?: string;
}

export function resolveRoot(env: MainEnv): string {
  return env.root ?? env.WAVE_LOG_ROOT ?? WAVE_LOG_ROOT;
}

export function resolveLegacyRoots(env: MainEnv): readonly string[] | undefined {
  if (env.root !== undefined) {
    return [];
  }
  return [LEGACY_WAVE_LOG_ROOT];
}

/**
 * `yarn wave:status --push` is a one-shot push of the collected status, not a
 * server: the read-only page has nothing to add to a snapshot on its way out.
 * The flag is read here rather than parsed, because bin.ts must not import
 * cli.ts — cli.ts imports bin.ts for `resolveRoot`, and a static import back
 * would close a cycle.
 */
export function pushRequested(argv: readonly string[]): boolean {
  return argv.includes("--push");
}

export async function main(env: MainEnv): Promise<ServerHandle> {
  const port = resolvePort(env);
  const handle = await startServer({
    port,
    root: resolveRoot(env),
    legacyRoots: resolveLegacyRoots(env),
  });
  console.log(
    `  wave-status serving ${handle.url} — read-only: it starts, kills and merges nothing.`,
  );
  return handle;
}

/* istanbul ignore next -- CLI entry guard; main() and pushRequested() are covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (pushRequested(argv)) {
    const { runFromProcess } = await import("./cli.js");
    runFromProcess(argv);
  } else {
    main(process.env).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
