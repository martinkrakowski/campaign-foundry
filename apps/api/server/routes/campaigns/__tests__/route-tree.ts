import { readdirSync } from "node:fs";

/**
 * Every static first path segment directly under `dir` — a route file (any
 * HTTP method, e.g. `package.post.ts`, or a bare `result.get.ts`) or a
 * directory — excluding a dynamic segment (`[id]`), `__tests__`, and the
 * index route itself (`index.post.ts` answers `/campaigns`, not a segment
 * under it).
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
    // A route file is named `<segment>.<method>.ts` or bare `<segment>.ts`;
    // the segment is everything before the first `.`.
    const segment = name.split(".")[0];
    if (!segment || segment === "index") continue;
    segments.add(segment);
  }
  return [...segments].sort();
}
