import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const webSrc = fileURLToPath(new URL("./apps/web/src", import.meta.url));

// Root Vitest config for the monorepo. Two projects:
//   - "node": every backend/domain package + the API app, default node env.
//   - "web":  the Next.js UI under happy-dom with the React plugin.
// Coverage is a global concern (configured here) and aggregates across both.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts"],
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
        },
        test: {
          name: "web",
          environment: "happy-dom",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["./apps/web/vitest.setup.ts"],
        },
      },
    ],
    coverage: {
      // istanbul (not v8): the v8 provider's rolldown remapper can't parse
      // TS-in-.tsx (`import type`, `interface`) and drops those files; istanbul
      // instruments through Vite's transform, so plugin-react handles the UI.
      provider: "istanbul",
      reporter: ["text", "lcov"],
      // The 100% gate is added in the final phase (see TEST_COVERAGE_PLAN.md §5) so
      // intermediate commits stay green; until then `test:cov` only reports.
      include: [
        "packages/*/src/**/*.{ts,tsx}",
        "apps/api/server/**/*.ts",
        "apps/api/bin/**/*.ts",
        "apps/web/src/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/__tests__/**",
        "**/index.ts", // generated barrels: pure re-exports, no logic
        "**/*.config.{ts,mts,js,mjs}",
        "**/*.d.ts",
        "apps/web/src/app/**/layout.tsx", // root html/body shell, no logic
      ],
    },
  },
});
