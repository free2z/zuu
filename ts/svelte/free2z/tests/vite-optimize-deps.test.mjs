import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A bare package that only a `.svelte` file imports dynamically is invisible to
// Vite's dependency scan. The dev server then discovers it the first time it
// transforms that component, re-bundles, and FULL-RELOADS every open page. In
// the browser suite that reload landed mid-test (typed editor text vanished,
// the composer remounted) and failed the first attempt of a spec in most CI
// shards. Each such package must be pre-bundled through optimizeDeps.include.

const root = fileURLToPath(new URL("../", import.meta.url));

function svelteFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return svelteFiles(path);
    return entry.name.endsWith(".svelte") ? [path] : [];
  });
}

function dynamicBareImports(source) {
  const found = new Set();
  // Type positions (`typeof import("x")`) are erased by TypeScript and never
  // reach import analysis.
  const pattern = /(?<!typeof\s)\bimport\(\s*["']([^"'./$][^"']*)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) found.add(match[1]);
  return found;
}

function optimizeDepsInclude() {
  const config = readFileSync(join(root, "vite.config.ts"), "utf8");
  const block = config.match(
    /optimizeDeps:\s*\{[\s\S]*?include:\s*\[([\s\S]*?)\]/,
  );
  assert.ok(block, "vite.config.ts must declare optimizeDeps.include");
  return new Set(
    [...block[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]),
  );
}

test("the scanner pattern finds runtime imports and ignores type-only ones", () => {
  assert.deepEqual(
    [
      ...dynamicBareImports(
        'let m: typeof import("types-only").default; await import("runtime-dep"); import("./local.js"); import("$lib/x");',
      ),
    ],
    ["runtime-dep"],
  );
});

test("every package a Svelte component imports dynamically is pre-bundled", () => {
  const include = optimizeDepsInclude();
  const missing = [];
  for (const dir of ["src", "tests/browser"]) {
    for (const file of svelteFiles(join(root, dir))) {
      for (const specifier of dynamicBareImports(readFileSync(file, "utf8"))) {
        // vite-plugin-svelte owns the svelte runtime's optimization.
        if (specifier === "svelte" || specifier.startsWith("svelte/")) continue;
        if (!include.has(specifier))
          missing.push(`${relative(root, file)}: import("${specifier}")`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    "add these packages to optimizeDeps.include in vite.config.ts",
  );
  // The regression this guards: MarkdownContent.svelte loads mermaid lazily.
  assert.ok(include.has("mermaid"));
});
