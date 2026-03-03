import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /** No `any` — use proper types */
      "@typescript-eslint/no-explicit-any": "error",
      /** Allow unused vars prefixed with _ */
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      /** Enforce consistent type imports */
      "@typescript-eslint/consistent-type-imports": "warn",
      /** No console.log — use the project logger */
      "no-console": "warn",
    },
  },
  {
    /** Ignore build output and generated files */
    ignores: ["dist/", "drizzle/", "node_modules/"],
  }
);
