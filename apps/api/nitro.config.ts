import { createRequire } from "node:module";
import { defineNitroConfig } from "nitropack/config";

const require = createRequire(import.meta.url);

// https://nitro.build/config
export default defineNitroConfig({
  srcDir: "server",
  compatibilityDate: "2025-01-01",
  // Tests live in `__tests__/` next to the modules they cover, but Nitro scans
  // `server/` recursively for routes — without this it would bundle the *.test.ts
  // files (and run their top-level Vitest hooks) into the dev/build server.
  ignore: ["**/__tests__/**", "**/*.test.ts"],
  // ffmpeg-static resolves its binary from __dirname at runtime, so the package
  // (and the `ffmpeg` executable beside index.js) must be traced into
  // `.output/server/node_modules`. Without this the production server dies at
  // boot with "Cannot find module 'ffmpeg-static'" — before the warn-only probe
  // in server/plugins/ffmpeg-check.ts can degrade motion gracefully. The entry
  // is given as a resolved file path: a bare specifier stays external in
  // rollup and node-file-trace then looks for `apps/api/ffmpeg-static`.
  // Resolved lazily and optionally: a checkout that has not installed the
  // package (or a platform ffmpeg-static does not ship) must still start —
  // the boot probe then reports motion as unavailable instead of the config
  // load throwing before Nitro even exists.
  externals: { traceInclude: resolveOptional("ffmpeg-static") },
});

function resolveOptional(specifier: string): string[] {
  try {
    return [require.resolve(specifier)];
  } catch {
    console.warn(`[nitro] ${specifier} not installed — motion output will be unavailable`);
    return [];
  }
}
