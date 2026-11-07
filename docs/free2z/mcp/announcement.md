# Free2Z MCP: use your account from Claude, Codex, or Grok

[Free2Z MCP](https://github.com/free2z/zuu/tree/main/ts/free2z/mcp) connects your
AI assistant to your Free2Z account. Ask it to find pages, prepare a draft,
update an article, organize uploads, or inspect your account. It discovers the
available API operations, reads their requirements, and carries out the actions
you request.

MCP stands for Model Context Protocol, a standard for connecting AI assistants
to tools. The Free2Z server runs on your computer and talks to Free2Z over HTTPS.
It works with local MCP clients including Claude Code, Codex, and Grok Build.
Configure named accounts such as `alice` and `team` in one connection. Tell the
assistant which account to use for each action. The server verifies that the
selected credential belongs to its expected Free2Z username before acting, and
refuses a missing selection, expired credential, or mismatched identity. There
is no shared active account or fallback to another profile.

## What to try

> Using account alice, find my unpublished zPages and show me their titles and links.

> Using account team, turn these project notes into a zPage draft. Keep it unpublished, read it back,
> and give me the draft link.

> Using account alice, upload this diagram as private media and show me its ID and URL.

> Using account alice, read my article, update its title, and preserve the rest of its content.

The tools cover the public Free2Z API: pages, profiles, comments, follows,
subscriptions, translations, and more. Media uploads use your signed-in browser
session. Use the explicit anonymous account for public access; named account
operations use separate saved sessions or API tokens. Replace one profile's
credential after signing in again without restarting or switching other accounts.

Your account's permissions and Free2Z's pricing rules apply. Publishing makes a
page public. Paid operations use the account's balance. The server does not
hold wallet keys or bypass access controls. Tell your assistant which actions
you want it to take and use your client's tool approvals accordingly.

## Get started

You need Node.js 22 or later and a local MCP client:

```sh
git clone https://github.com/free2z/zuu.git
cd zuu/ts/free2z/mcp
npm ci
npm test
node dist/cli.js --check
```

Follow the [setup guide](https://github.com/free2z/zuu/blob/main/docs/free2z/mcp/README.md)
to connect your account and register the server with Claude Code, Codex, or
Grok Build. The guide includes credential storage, upload examples, pagination,
and checks for concurrent edits.

This is a local stdio server, not a hosted MCP URL for the chat websites.
The source is open, the package is MIT licensed, and installation from source
does not require an npm registry release.

Try it with a draft. [Report a reproducible problem or propose an improvement](https://github.com/free2z/zuu/issues).
