#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";
import { loadConfig, safeConfig } from "./config.js";
import { operations } from "./catalog.js";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") console.log("0.1.0");
else if (args.length === 1 && args[0] === "--help")
  console.log(`free2z-mcp [--help | --version | --check]
Without arguments, serves Model Context Protocol over stdio.
--check validates configuration and bundled catalog without network requests.
FREE2Z_BASE_URL: HTTPS origin; default https://free2z.cash
Configure exactly one credential source, or omit all for public reads:
  FREE2Z_TOKEN: raw Knox token
  FREE2Z_TOKEN_FILE: private file containing raw Knox token
  FREE2Z_SESSION_FILE: private JSON {"sessionid":"...","csrftoken":"..."}
Optional positive integer limits: FREE2Z_TIMEOUT_MS (120000),
FREE2Z_MAX_RESPONSE_BYTES (8388608), FREE2Z_MAX_UPLOAD_BYTES (104857600).
See https://github.com/free2z/zuu/tree/main/docs/free2z/mcp`);
else {
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
      throw new Error("Unknown argument. Use --help.");
    const config = loadConfig();
    if (args[0] === "--check")
      console.log(
        JSON.stringify({ ...safeConfig(config), operations: operations.size }),
      );
    else await serveStdio(() => createServer(config));
  } catch (e) {
    console.error(
      e instanceof Error ? e.message : "Free2Z MCP failed to start",
    );
    process.exitCode = 1;
  }
}
