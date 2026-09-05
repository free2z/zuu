import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBuildIdentity } from "./scripts/build-identity.mjs";

const host = process.env.TAURI_DEV_HOST;
// Where the dev/`tauri dev` proxy forwards /api and /uploadz. Defaults to
// staging (stage.free2z.cash tracks latest main) during development; override
// to point at production or a local backend to test unshipped endpoints, e.g.
//   VITE_F2Z_PROXY=https://free2z.cash npm run tauri dev
//   VITE_F2Z_PROXY=http://localhost:8000 npm run tauri dev
const apiTarget = process.env.VITE_F2Z_PROXY || "https://stage.free2z.cash";

// ZUULI dev server runs on 1423 so it never collides with the zuuallet
// reference wallet (1421). Tauri drives this via beforeDevCommand.
export default defineConfig(async () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const buildIdentity = loadBuildIdentity({ root });
  return {
  plugins: [react()],
  test: {
    // Workers must not inherit a contributor's locale or timezone. LC_ALL is
    // pinned with LANG because it takes precedence on POSIX systems.
    env: {
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "UTC",
    },
  },
  // The `PACKAGE_VERSION` define (mathjax-full, via rehype-mathjax), the
  // `linkedom/worker` + `mermaid` pre-bundle and the ES worker format all
  // existed for the Markdown/Mermaid renderer, which #904 phase 4 removed from
  // this app. `wallet/free2z` carries them now.
  define: {
    __ZUULI_BUILD_INFO__: JSON.stringify(buildIdentity),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1423,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1424 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    // Dev/`tauri dev` proxy to the real free2z API. Requests stay same-origin
    // (localhost:1423) so the browser/webview never triggers CORS; Node does
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
  };
});
