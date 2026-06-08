import * as h3 from "h3";

// Nitro auto-imports these h3 utilities as globals in route handlers. Vitest runs
// the route modules outside Nitro, so expose the same names on globalThis before
// any route file is imported.
const AUTO_IMPORTS = [
  "defineEventHandler",
  "readBody",
  "getQuery",
  "setResponseStatus",
  "getRouterParam",
  "setHeader",
  "sendStream",
] as const;

const target = globalThis as unknown as Record<string, unknown>;
const source = h3 as unknown as Record<string, unknown>;
for (const name of AUTO_IMPORTS) target[name] = source[name];
