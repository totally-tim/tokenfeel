// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

// Flat ESLint config (ESLint 10). The ruleset intentionally favors rules
// that catch real bugs (unused vars, floating promises, hook misuse) over
// stylistic preferences — Prettier owns formatting, so ESLint's own
// stylistic rules are disabled via eslint-config-prettier.
export default tseslint.config(
  {
    // Build artifacts, generated data, and vendored output are never linted.
    ignores: ["dist/**", "public/catalog/**", "output/**", "coverage/**", "*.tsbuildinfo", "data/**"]
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Type-aware linting (needed for rules like no-floating-promises)
        // resolved per-file against the nearest tsconfig, instead of a
        // single hard-coded `project` path.
        projectService: {
          // vitest.config.ts isn't included by tsconfig.json's `include`
          // (it's only consumed by the Vitest CLI at runtime), so give it
          // an in-memory default project instead of adding it to the
          // product tsconfig.
          allowDefaultProject: ["vitest.config.ts", "eslint.config.js"]
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },

  // Browser application code.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      // Only the two classic hooks-correctness rules. The plugin's full
      // "recommended" set (v7+) also bundles a dozen React Compiler
      // diagnostics (set-state-in-effect, preserve-manual-memoization, ...)
      // that flag idiomatic, working patterns all over this codebase as if
      // they were bugs — too opinionated for a lint pass on an existing
      // codebase that isn't written for the compiler.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  },

  // Node-run scripts and config files.
  {
    files: ["scripts/**/*.ts", "*.config.ts", "*.config.js"],
    languageOptions: {
      globals: globals.node
    }
  },

  {
    rules: {
      // Real-bug rules worth keeping strict.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Unused vars are a real bug (dead code, leftover imports) but an
      // underscore prefix is the established escape hatch for intentionally
      // unused args/catch bindings.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],

      // This codebase leans on `any` at a few real integration boundaries
      // (zod-parsed JSON, third-party shapes); don't force a rewrite of
      // those as part of introducing the linter.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn"
    }
  },

  // Turn off ESLint stylistic rules that would fight Prettier.
  eslintConfigPrettier
);
