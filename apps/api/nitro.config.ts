import { defineNitroConfig } from "nitropack/config";

// https://nitro.build/config
export default defineNitroConfig({
  srcDir: "server",
  compatibilityDate: "2025-01-01",
  // Tests live in `__tests__/` next to the modules they cover, but Nitro scans
  // `server/` recursively for routes — without this it would bundle the *.test.ts
  // files (and run their top-level Vitest hooks) into the dev/build server.
  ignore: ["**/__tests__/**", "**/*.test.ts"],
});
