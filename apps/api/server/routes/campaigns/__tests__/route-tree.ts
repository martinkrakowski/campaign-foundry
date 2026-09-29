import { readdirSync } from "node:fs";

/**
 * Every static first path segment directly under `dir` — a `.ts` route file
 * (any HTTP method, e.g. `package.post.ts`, or a bare `result.get.ts`) or a
 * directory — excluding a dynamic segment (`[id]`), `__tests__`, the index
 * route itself (`index.post.ts` answers `/campaigns`, not a segment under
 * it), any non-`.ts` file, and any `*.test.ts` file. The last two mirror
 * `apps/api/nitro.config.ts`'s own `ignore: ["**\/__tests__/**", "**\/*.test.ts"]`
 * (D181 fix round 2, qodo) — a `.test.ts` file dropped directly under
 * `routes/campaigns/` (not `__tests__/`) is not a route Nitro ever serves,
 * so it must not demand a reserved campaign id either.
 *
 * Shared by `route-tree.test.ts`'s real-tree assertion and its fixture-tree
 * negative test (HX1/D181), so both exercise the same derivation.
 */
export function staticRouteSegments(dir: string): string[] {
  const segments = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === "__tests__" || name.startsWith("[")) continue;
    if (entry.isDirectory()) {
      segments.add(name);
      continue;
    }
    // Route files only (D181 fix round 2 nit) — a non-`.ts` file here (a
    // build artifact, a stray `.map`, `.DS_Store`) is not a route and must
    // not be read as one.
    if (!name.endsWith(".ts")) continue;
    // Nitro itself never registers a `*.test.ts` file as a route
    // (nitro.config.ts's `ignore`) — neither does this derivation.
    if (name.endsWith(".test.ts")) continue;
    // A route file is named `<segment>.<method>.ts` or bare `<segment>.ts`;
    // the segment is everything before the first `.`.
    const segment = name.split(".")[0];
    if (!segment || segment === "index") continue;
    segments.add(segment);
  }
  return [...segments].sort();
}
