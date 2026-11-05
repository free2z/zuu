// Test-only IPC controller. No control route is exposed to HTTP clients.
import { createServer } from "node:http";
let handler;
const server = createServer((req, res) => handler(req, res));
server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  process.env.ORIGIN = `http://127.0.0.1:${port}`;
  ({ handler } = await import("../../build/handler.js"));
  process.send?.({ type: "ready", origin: process.env.ORIGIN });
});
process.on("message", (message) => {
  if (message?.type === "policy") {
    process.env.PRIVATE_DISABLED_UI_LOCALES = message.disabled;
    process.send?.({ type: "policy-applied" });
  }
  if (message?.type === "stop") server.close(() => process.exit(0));
});
