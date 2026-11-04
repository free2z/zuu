import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import {
  CSP_REPORT_PATH,
  REPORT_ONLY_SCRIPT_SRC,
} from "./src/lib/csp-policy.js";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { buildRecorder } from "./scripts/build-recorder.mjs";

/**
 * Browser support baseline — `.browserslistrc` is the single source of truth
 * and carries the rationale for each version floor.
 *
 * browserslist and `build.target` must never disagree: browserslist drives
 * autoprefixer (CSS), `build.target` drives esbuild (JS syntax). Two
 * independently hand-maintained lists WILL drift, and a build that downlevels
 * JS for Safari 14 while emitting CSS only Safari 16.4 understands is worse
 * than having declared nothing. So the esbuild target is *derived* from
 * `.browserslistrc` here rather than written out a second time.
 *
 * The derivation is deliberately dumb and strict: every entry must be a
 * `<browser> >= <version>` floor whose browser has a 1:1 esbuild engine. Any
 * other query form (`defaults`, `> 0.5%`, `last 2 versions`, `not dead`, …)
 * throws at config load, because those resolve against a moving caniuse
 * database — the exact "implicit target nobody chose" this replaces.
 *
 * Chromium forks (Android Chrome, Samsung Internet, Opera, Brave) are covered
 * by the `chrome` floor and are intentionally not listed: esbuild has no
 * separate engine for them, and listing them would only add browserslist
 * entries that could not be honored by the JS target.
 *
 * NB: this only constrains *syntax*. Runtime APIs newer than the baseline
 * (`AbortSignal.any`, `structuredClone`, …) are invisible to every bundler
 * setting; see `.browserslistrc` for what still guards those.
 */
const ESBUILD_ENGINE_BY_BROWSERSLIST_ID: Readonly<Record<string, string>> = {
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  safari: "safari",
  ios_saf: "ios",
};

const BROWSERSLIST_FLOOR_RE = /^([a-z_]+) >= (\d+(?:\.\d+)*)$/;

function esbuildTargetsFromBrowserslist(queries: readonly string[]): string[] {
  if (queries.length === 0) {
    throw new Error(
      ".browserslistrc declares no queries; the build has no browser baseline.",
    );
  }
  return queries.map((query) => {
    const match = BROWSERSLIST_FLOOR_RE.exec(query);
    const engine = match
      ? ESBUILD_ENGINE_BY_BROWSERSLIST_ID[match[1]]
      : undefined;
    if (!match || engine === undefined) {
      throw new Error(
        `Unsupported browserslist query ${JSON.stringify(query)} in .browserslistrc.\n` +
          "vite.config.ts derives build.target from browserslist, so every entry must be a " +
          `"<browser> >= <version>" floor for one of: ${Object.keys(ESBUILD_ENGINE_BY_BROWSERSLIST_ID).join(", ")}.\n` +
          "Widening the baseline means extending ESBUILD_ENGINE_BY_BROWSERSLIST_ID too — " +
          "not silently letting the CSS and JS targets diverge.",
      );
    }
    return `${engine}${match[2]}`;
  });
}

/**
 * Minimal `.browserslistrc` reader: one query per line, `#` comments and blank
 * lines ignored. browserslist's own `[section]` syntax (per-environment
 * queries) is rejected rather than silently mis-parsed — a build target that
 * differs between environments is not a baseline.
 */
function readBrowserslistrc(): string[] {
  const path = fileURLToPath(new URL("./.browserslistrc", import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.startsWith("[")) {
        throw new Error(
          `.browserslistrc environment section ${JSON.stringify(line)} is not supported: ` +
            "the browser baseline must be the same for every build.",
        );
      }
      return line;
    });
}

const buildTarget = esbuildTargetsFromBrowserslist(readBrowserslistrc());

// Dev proxy to backend so /api requests hit Django instead of SvelteKit. The
// browser harness overrides this with its mock API; keeping the default makes
// ordinary local development continue to use Django on port 8000.
const devApiProxyTarget =
  process.env.VITE_API_PROXY_TARGET || "http://localhost:8000";

// Each Node test process owns its generated environment modules. Remove only
// this invocation's directory after all Vite servers and tests have exited.
const testOutput = process.env.NODE_TEST_CONTEXT
  ? fileURLToPath(new URL(`.svelte-kit-test-${process.pid}`, import.meta.url))
  : undefined;
if (testOutput)
  process.once("exit", () =>
    rmSync(testOutput, { recursive: true, force: true }),
  );

export default defineConfig({
  cacheDir: testOutput ? `${testOutput}/vite-cache` : undefined,
  resolve: {
    alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) },
  },
  plugins: [
    tailwindcss(),
    sveltekit({
      // Parallel Node tests supply distinct backend environments. Kit writes
      // generated env modules to disk, so each process needs its own directory.
      outDir: testOutput ?? ".svelte-kit",
      preprocess: vitePreprocess(),
      adapter: adapter(),
      version: {
        name:
          process.env.PUBLIC_BUILD_SHA?.trim() ||
          process.env.COMMIT_SHA?.trim() ||
          "dev",
      },
      csp: {
        mode: "auto",
        reportOnly: {
          "script-src": REPORT_ONLY_SCRIPT_SRC,
          "report-uri": [CSP_REPORT_PATH],
        },
      },
    }),
    {
      name: "standalone-recorder-development-assets",
      async configureServer() {
        await buildRecorder("static");
      },
    },
  ],
  // Fixtures import components outside the route graph. Scan their dependency
  // graph before serving pages so a cold browser run cannot discover a second
  // Svelte bundle and reload halfway through mounting a fixture. Vite merges
  // these entries with SvelteKit's application route entries.
  optimizeDeps: {
    entries: ["tests/browser/*fixture.svelte"],
    include: [
      "@lucide/svelte",
      "@lucide/svelte/icons/arrow-right",
      "bits-ui",
      "embla-carousel-svelte",
      "embla-carousel",
    ],
  },
  build: {
    // @sveltejs/kit's Vite plugin returns `build.target: 'node18.13'` for the
    // SSR pass and `undefined` for the client pass. Vite's mergeConfig skips
    // undefined and CONCATENATES arrays, so the resolved targets are:
    //
    //   client — exactly this list
    //   server — this list ∪ ['node18.13']
    //
    // esbuild treats a target list as a conjunction (output must satisfy every
    // engine), so the SSR bundle is compiled at worst slightly more
    // conservatively than before. Verified: SSR output is byte-identical
    // (3,389,456 B) with and without this setting — Node 18 and the browser
    // floors below agree on every syntax feature this app and its deps emit.
    target: buildTarget,
  },
  ssr: {
    external: ["@resvg/resvg-js"],
  },
  server: {
    hmr: process.env.NODE_TEST_CONTEXT ? false : undefined,
    // Browser regression fixtures are imported through Vite at runtime. Keep
    // the app and test module trees available to the dev server without
    // changing the production bundle or exposing them through SvelteKit
    // routes.
    fs: {
      allow: [fileURLToPath(new URL("./", import.meta.url))],
    },
    proxy: {
      "/api": {
        target: devApiProxyTarget,
        changeOrigin: true,
        secure: false,
      },
      "/uploads": {
        target: devApiProxyTarget,
        changeOrigin: true,
        secure: false,
      },
      // Optional: serve backend media/static during dev if needed
      "/media": {
        target: devApiProxyTarget,
        changeOrigin: true,
        secure: false,
      },
      "/static": {
        target: devApiProxyTarget,
        changeOrigin: true,
        secure: false,
      },
      "/ws": {
        target: devApiProxyTarget
          .replace(/^http:/, "ws:")
          .replace(/^https:/, "wss:"),
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
});
