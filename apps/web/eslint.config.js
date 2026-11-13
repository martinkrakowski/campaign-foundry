import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
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
    ignores: ["dist/**", "node_modules/**", ".next/**"],
  },
);
