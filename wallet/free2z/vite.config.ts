import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localDraftEvaluation = process.env.VITE_LOCAL_DRAFT_EVALUATION === "1";
const workerCsp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://raw.githubusercontent.com https://cas-bridge.xethub.hf.co https://us.aws.cdn.hf.co";
const localDraftAssets: Plugin = {
  name: "free2z-local-draft-evaluation",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.includes("inference.worker")) response.setHeader("Content-Security-Policy", workerCsp);
      next();
    });
  },
  configurePreviewServer(server: import("vite").PreviewServer) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.includes("inference.worker")) response.setHeader("Content-Security-Policy", workerCsp);
      next();
    });
  },
  generateBundle() {
    if (localDraftEvaluation) {
      this.emitFile({ type: "asset", fileName: "webllm.LICENSE.txt", source: readFileSync(path.resolve(__dirname, "node_modules/@mlc-ai/web-llm/LICENSE")) });
    }
  },
};

const host = process.env.TAURI_DEV_HOST;
// Where the dev/`tauri dev` proxy forwards /api and /uploadz. Defaults to
// staging (stage.free2z.cash tracks latest main) during development; override
// to point at production or a local backend to test unshipped endpoints, e.g.
//   VITE_F2Z_PROXY=https://free2z.cash npm run tauri dev
const apiTarget = process.env.VITE_F2Z_PROXY || "https://stage.free2z.cash";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// #906 shipped this surface with no Vite configuration at all, because the
// placeholder screen needed none and `wallet/zuuli/scripts/project-boundary.mjs`
// runs a real production Rollup build of every project that ships one. The
// content extraction (#904 phase 1) changes that: the Markdown pipeline this
// app exists to render cannot build on Vite's defaults.
//
//   * `worker.format` defaults to "iife", and the Mermaid worker dynamically
//     imports `mermaid` — Rollup refuses to code-split an IIFE, so the build
//     fails outright rather than degrading.
//   * `mathjax-full` (via rehype-mathjax) reads its version through
//     `eval('require')(...)` unless a global `PACKAGE_VERSION` exists, which
//     throws "require is not defined" the first time an article renders math.
//
// So the config is now load-bearing, and the boundary audit builds this project
// for real. `.github/workflows/zuuli.yml` installs this project's dependencies
// in the protected `frontend` job for exactly that reason.
export default defineConfig({
  build: { rollupOptions: { input: { main: path.resolve(__dirname, "index.html"),
    ...(localDraftEvaluation ? { localDraft: path.resolve(__dirname, "local-draft.html") } : {}),
  } } },
  plugins: [react(), localDraftAssets],
  test: {
    // Workers must not inherit a contributor's locale or timezone. LC_ALL is
    // pinned with LANG because it takes precedence on POSIX systems.
    env: {
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "UTC",
    },
  },
  define: {
    PACKAGE_VERSION: JSON.stringify("3.2.1"),
  },
  optimizeDeps: {
    // Pre-bundle the worker's cold dependencies before tests/dev navigation;
    // otherwise Vite discovers them on the first diagram and reloads the app
    // while the disposable worker is still rendering.
    include: ["linkedom/worker", "mermaid"],
    exclude: ["@mlc-ai/web-llm"],
    esbuildOptions: {
      define: {
        PACKAGE_VERSION: JSON.stringify("3.2.1"),
      },
    },
  },
  // Mermaid is intentionally code-split inside a dedicated module Worker so
  // creator-controlled parsing/layout never shares the app UI thread.
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    // 1421 is zuuallet, 1423 is ZUULI. This surface owns 1425.
    port: 1425,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1426 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    // Dev/`tauri dev` proxy to the real free2z API. Requests stay same-origin
    // (localhost:1425) so the browser/webview never triggers CORS; Node does
    // the cross-origin call. Production `tauri build` uses tauri-plugin-http
    // against the absolute API_BASE instead.
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        secure: true,
      },
      "/uploadz": {
        target: apiTarget,
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
