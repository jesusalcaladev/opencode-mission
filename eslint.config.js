import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "runs/**", "demos/**", "coverage/**"] },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: false }],
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
];
