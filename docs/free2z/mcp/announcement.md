# Free2Z MCP: your accounts, your assistant

Free2Z MCP lets an assistant work with the accounts you authorize: find pages, prepare drafts, edit your public profile, upload media and publish content when you ask. MCP is the Model Context Protocol, the interface assistants use to discover and call tools.

On a Free2Z deployment with hosted MCP enabled, add its `/api/mcp` address to your client and authorize access in your browser. Free2Z hosts the server. The [setup guide](https://github.com/free2z/zuu/blob/main/docs/free2z/mcp/README.md) covers deployment availability, client configuration and the capabilities verified with Codex, Claude Code and Grok Build. It also explains the required transport and authorization support for OpenClaw and other interfaces.

One connection can use several accounts. Connect as `foobar`, ask to add `baz`, then sign in as `baz` in the browser and approve that specific delegation. Every action selects its account explicitly; switching the browser's login does not switch the assistant's account. You can grant fewer permissions to a linked account and remove its access independently. In Connected apps, a connection owner can also choose Add account to start the same browser consent flow.

Try a draft:

> Using Free2Z account baz, turn these project notes into a zPage draft. Keep it unpublished, read it back and give me the link.

Uploads use the same authorized connection. A client with file and HTTP tools can transfer an image and attach its media ID to a page; an interface without those tools can use existing media. Choose the audience explicitly: a featured image must be public, even when its page is private.

Draft creation leaves the page unpublished. Publishing is a separate action, and editing public content requires publication permission. Review your client's tool approvals and check [Connected apps](https://free2z.cash/account/apps) to see delegated accounts, recent activity or remove access.

Free2Z's normal balance requirements and upload limits apply to the selected account. The hosted tools support publishing, social activity, account collections and media; metered text AI requires its own permission and an explicit spending ceiling. They do not hold wallet keys, transfer money or change account credentials. Browse the [source](https://github.com/free2z/zuu/tree/main/py/free2z) and [connection guide](https://github.com/free2z/zuu/blob/main/docs/free2z/mcp/README.md), or try it with an unpublished draft.
