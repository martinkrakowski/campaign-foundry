// Deterministic-core lint fragment — the single source of truth for "no ambient
// non-determinism in the domain". Imported by the hexagen-generated per-package
// `eslint.config.js` files (via the manifest's eslint templates), so the rule
// text lives here once instead of being pasted into every bounded context.
//
// Scope: `src/domain/**` in every package (plus whatever `extraFiles` a context
// adds — CampaignOrchestration adds its use cases). Tests are excluded: a fixed
// `new Date("2026-01-01")` fixture in a test is fine and must not trip the ban.
//
// Not banned on purpose: `new Date(value)` with arguments (parsing a supplied
// timestamp is deterministic). The wall-clock reads are the zero-arg forms.

const WALL_CLOCK = "Do not read the wall clock in the deterministic core; take time as an input.";
const RANDOMNESS = "Use SeededRandom (from @campaignfoundry/shared) instead of ambient randomness.";

/**
 * @param {{ extraFiles?: string[], ignores?: string[] }} [options]
 * @returns {import("eslint").Linter.Config[]}
 */
export default function deterministicCore(options = {}) {
  const { extraFiles = [], ignores = [] } = options;
  return [
    {
      files: ["src/domain/**/*.ts", ...extraFiles],
      ignores: ["**/__tests__/**", ...ignores],
      rules: {
        "no-restricted-properties": [
          "error",
          { object: "Math", property: "random", message: RANDOMNESS },
          { object: "crypto", property: "randomUUID", message: RANDOMNESS },
          { object: "crypto", property: "getRandomValues", message: RANDOMNESS },
          { object: "Date", property: "now", message: WALL_CLOCK },
          { object: "performance", property: "now", message: WALL_CLOCK },
        ],
        "no-restricted-syntax": [
          "error",
          // `new Date()` — zero-arg construction reads the clock.
          { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: WALL_CLOCK },
          // `Date()` — the call form always returns the current time as a string.
          { selector: "CallExpression[callee.name='Date']", message: WALL_CLOCK },
          // `globalThis.Date` / `globalThis.Math.random` escape hatches.
          {
            selector: "MemberExpression[object.name='globalThis'][property.name=/^(Date|Math|crypto|performance)$/]",
            message: "Do not reach ambient non-determinism through globalThis in the deterministic core.",
          },
        ],
      },
    },
  ];
}
