# Free2Z MCP

A local Model Context Protocol server that lets compatible assistants discover and call the Free2Z API using your account permissions. It includes the public API schema and session-authenticated file uploads. Configure named profiles with `FREE2Z_ACCOUNTS_FILE`, list them with `free2z_list_accounts`, and pass an explicit `account` to each read or execute call. The server verifies the configured username before acting and reloads selected credentials per call. Legacy single-account configuration is also supported.

Requires Node.js 22 or newer. From this directory:

```sh
npm ci
npm test
npm pack
```

Install the resulting `free2z-mcp-0.2.0.tgz` with `npm install -g /absolute/path/to/free2z-mcp-0.2.0.tgz`. Run `free2z-mcp --help` for environment configuration or `free2z-mcp --check` to validate configuration without network access. With no arguments the command serves MCP over standard input/output.

Read the [setup and usage guide](https://github.com/free2z/zuu/tree/main/docs/free2z/mcp) for Claude, Codex, other MCP clients, credential setup, uploads, examples, and limitations. Tokens and sessions retain their Free2Z expiry and account permissions. The execution tool can publish, delete, and spend account credit when the API permits; review actions in your MCP host.

Development: `npm run schema:update` refreshes the bundled schema from the public application source; `npm run schema:check` detects drift. `npm run format:check` checks formatting. Tests use an isolated local HTTP fixture and the official MCP client; they do not mutate a live Free2Z account.
