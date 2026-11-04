import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tsPlugin from "@typescript-eslint/eslint-plugin";
import prettierRules from "eslint-config-prettier";
import compat from "eslint-plugin-compat";
import svelte from "eslint-plugin-svelte";
import tsParser from "@typescript-eslint/parser";
import svelteParser from "svelte-eslint-parser";

import runtimeFloor from "./eslint-rules/runtime-floor.js";

const browserslist = readFileSync(
  fileURLToPath(new URL("./.browserslistrc", import.meta.url)),
  "utf8",
)
  .split("\n")
  .map((line) => line.replace(/#.*$/, "").trim())
  .filter((line) => line.length > 0);

export default [
  {
    name: "free2z/ignores",
    ignores: [
      "node_modules/**",
      ".svelte-kit/**",
      ".svelte-kit-test-*/**",
      ".recorder-*/**",
      "static/_app/**",
      "static/tools/recording/**",
      "build/**",
      "dist/**",
      "playwright-report/**",
      "playwright-report-local-*/**",
      "test-results/**",
      "test-results-local-*/**",
      "coverage/**",
    ],
  },
  {
    name: "free2z/javascript-and-typescript",
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
  },
  ...svelte.configs["flat/base"],
  {
    name: "free2z/svelte-typescript",
    files: ["**/*.svelte"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: {
          js: tsParser,
          ts: tsParser,
          typescript: tsParser,
        },
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
  // Rune modules (`*.svelte.ts`, e.g. mdEditor/markdownTextarea.svelte.ts).
  // `flat/base` hands them to svelte-eslint-parser, which parses TypeScript
  // only when it is told which parser to delegate to.
  {
    name: "free2z/svelte-rune-modules",
    files: ["**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
  // eslint-plugin-compat resolves the nearest browserslist configuration for
  // each filename. Pass the same file explicitly so invoking ESLint from
  // another working directory cannot silently fall back to Browserslist's
  // moving default.
  {
    ...compat.configs["flat/recommended"],
    settings: {
      browsers: browserslist,
      // The plugin does not lint ECMAScript APIs unless this experimental
      // option is enabled. Keep it on so new ES APIs are checked alongside
      // Web APIs; the local runtime-floor rule covers APIs missing from its
      // compatibility metadata.
      lintAllEsApis: true,
    },
  },
  {
    name: "free2z/runtime-floor",
    plugins: {
      "free2z-runtime": {
        rules: {
          "compatibility-floor": runtimeFloor,
        },
      },
    },
    rules: {
      "free2z-runtime/compatibility-floor": "error",
    },
  },
  {
    name: "free2z/server-runtime-floor-exceptions",
    files: [
      "src/lib/server/**",
      "**/*.server.{ts,js}",
      "**/+server.{ts,js}",
      "vite.config.ts",
      "playwright.config.ts",
      "tests/**",
    ],
    rules: {
      "compat/compat": "off",
      "free2z-runtime/compatibility-floor": "off",
    },
  },
  {
    name: "free2z/prettier",
    linterOptions: {
      // Generated API files carry disable directives for rules that are not
      // enabled here; their unused-directive warnings are not actionable.
      reportUnusedDisableDirectives: "off",
    },
    rules: prettierRules.rules,
  },
];
