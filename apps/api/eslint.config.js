import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat config for the API app — mirrors the package configs
// (packages/*/eslint.config.js). The `lint` script targets the `server` dir.
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        // `const { key: _dropped, ...rest } = obj` is how this codebase omits a key;
        // that binding is deliberately unused. Exempting rest siblings lets the idiom
        // stand without a per-site suppression comment.
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    ignores: [".nitro/**", ".output/**", "dist/**", "node_modules/**"],
  },
);
