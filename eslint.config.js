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
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "no-throw-literal": "error",
      "no-return-assign": "error",
      "no-useless-concat": "error",
      "no-self-compare": "error",
      "no-console": "off",
    },
  },
];
