import { defineConfig } from "vite";

export default defineConfig({
  build: { rollupOptions: { input: ["index.html", "callback.html"] } },
  server: { port: 5173, strictPort: true },
});
