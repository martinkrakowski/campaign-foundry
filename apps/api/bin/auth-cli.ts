import { main } from "./auth.js";

/**
 * The `yarn auth:bootstrap` entry point, split from `auth.ts` so that module
 * carries no top-level side effect: `auth.ts` stays a plain library a test can
 * `import` freely, and this file's one call is exercised the same way, in the
 * same process, with `main` mocked (`__tests__/auth-cli.test.ts`) — not by
 * spawning a subprocess, which coverage instrumentation cannot see into.
 */
main(process.argv[2]).catch((error: unknown) => {
  console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
