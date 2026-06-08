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
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/api/server/**/*.test.ts",
            "apps/api/bin/**/*.test.ts",
          ],
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
      provider: "v8",
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
