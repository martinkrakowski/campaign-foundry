import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const webSrc = fileURLToPath(new URL("./apps/web/src", import.meta.url));

// Root Vitest config for the monorepo. Four projects:
//   - "node": every backend/domain package + the API app, default node env.
//   - "api":  the Nitro API server, driven as real Request → Response.
//   - "web":  the Next.js UI under happy-dom with the React plugin.
//   - "tools": the dev tools under tools/ (outside the workspaces, inside the
//              gate — D102), plain node env.
// Coverage is a global concern (configured here) and aggregates across all of them.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["packages/ui/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "api",
          environment: "node",
          include: ["apps/api/server/**/*.test.ts", "apps/api/bin/**/*.test.ts"],
          // Provide Nitro's auto-imported h3 globals (defineEventHandler, …) so route
          // modules load and can be driven as real Request → Response in tests.
          setupFiles: ["./apps/api/vitest.setup.ts"],
        },
      },
      {
        extends: true,
        plugins: [react()],
        resolve: {
          alias: { "@": webSrc },
          dedupe: ["react", "react-dom"],
          // SG2 — resolve the BROWSER half of a package's `exports` map, which is
          // what the browser build ships and therefore the only build these tests
          // should be measuring. Vitest runs a project in Vite's SSR environment,
          // so without this the `node` condition wins.
          //
          // It went unnoticed until a dependency shipped genuinely different
          // builds. `react-resizable-panels` is one: its node build is the
          // server-render half — every layout effect is stripped, so `Panel`
          // never registers with its group. Panels then render at their
          // `defaultSize` and NOTHING else works: no `aria-valuenow`, no keydown
          // listener on the handle, no bounds. A keyboard-resize test would have
          // been measuring a component that cannot resize, and it would have
          // "passed" the moment it asserted anything weaker than a moved split.
          conditions: ["browser"],
        },
        test: {
          name: "web",
          environment: "happy-dom",
          include: ["apps/web/src/**/*.test.{ts,tsx}", "packages/ui/src/**/*.test.{ts,tsx}"],
          setupFiles: ["./apps/web/vitest.setup.ts"],
          // 15000ms, web project only. Vitest's 5000ms default was never calibrated
          // for this 182-test React integration suite (a full editor shell per test).
          // The tests were made faster first: §33 (X30, 4540ce0b) cut a full commit
          // per gesture (click 3→2, keystroke 4→3); §34 (X32, deb6e5a9) dropped a
          // re-blur of an already-touched field from 5 commits to 3; §36 (X34,
          // 8bbca3e9 + 218b2d3d) stopped fillValidDraft typing character by
          // character (setup commits 70→30, −57%; file 30.5s→27.4s) and the four
          // historically failing tests then passed on a loaded runner. What remained
          // on VE3b1's head a2981a77 was same-SHA pass/fail (PR 9m23s vs push 9m37s)
          // with one test over 5000ms in one run and not the other — per-moment
          // variance on a shared runner, not a slower machine and not a regression.
          // Owner approved this calibration on 2026-09-16. A slowdown is still
          // never answered by raising this number: the next person who finds a test
          // near the limit should look for the cost, as X30/X32/X34 did.
          testTimeout: 15000,
        },
      },
      {
        extends: true,
        test: {
          name: "tools",
          environment: "node",
          include: ["tools/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      // istanbul (not v8): the v8 provider's rolldown remapper can't parse
      // TS-in-.tsx (`import type`, `interface`) and drops those files; istanbul
      // instruments through Vite's transform, so plugin-react handles the UI.
      provider: "istanbul",
      reporter: ["text", "lcov"],
      // The repo is fully tested — enforce 100% so coverage can never regress.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
      include: [
        "packages/*/src/**/*.{ts,tsx}",
        "packages/ui/src/**/*.{ts,tsx}",
        "apps/api/server/**/*.ts",
        "apps/api/bin/**/*.ts",
        "apps/web/src/**/*.{ts,tsx}",
        "tools/**/*.ts",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/__tests__/**",
        // Only the package barrels, and only because they are machine-written: every
        // one carries `@generated by @hexagen/sync` and is regenerated as pure
        // re-exports, so it cannot acquire logic without the generator changing. The
        // blanket `**/index.ts` this replaces also excused three hand-written files
        // that do carry logic — the section order and titles, the API port registry
        // and the root route handler — so the 100% gate above was not looking at
        // them. Narrow the pattern, never widen it: that is how the last one went stale.
        "packages/*/src/**/index.ts",
        "**/*.config.{ts,mts,js,mjs}",
        "**/*.d.ts",
        "apps/web/src/app/layout.tsx", // root html/body shell; uses next/font (build-time only)
      ],
    },
  },
});
