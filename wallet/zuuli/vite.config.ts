import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;
// Where the dev/`tauri dev` proxy forwards /api and /uploadz. Defaults to
// staging (stage.free2z.cash tracks latest main) during development; override
// to point at production or a local backend to test unshipped endpoints, e.g.
//   VITE_F2Z_PROXY=https://free2z.cash npm run tauri dev
//   VITE_F2Z_PROXY=http://localhost:8000 npm run tauri dev
const apiTarget = process.env.VITE_F2Z_PROXY || "https://stage.free2z.cash";

// ZUULI dev server runs on 1423 so it never collides with the zuuallet
// reference wallet (1421). Tauri drives this via beforeDevCommand.
export default defineConfig(async () => ({
  plugins: [react()],
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
}));
