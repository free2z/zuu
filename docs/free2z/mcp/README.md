# Free2Z MCP

Free2Z MCP connects an assistant to accounts you authorize. The hosted server supports browsing pages, writing drafts, editing public profiles, managing media and explicitly publishing content. MCP means Model Context Protocol, the interface clients use to discover and call these tools. Free2Z runs the server; your client connects over HTTPS and asks you to authorize access in your browser.

**Prerequisite:** use a Free2Z deployment with hosted MCP enabled. The examples use `https://free2z.cash/api/mcp`; confirm that your deployment provides this endpoint before connecting. The [optional local stdio server](local-stdio.md) has a separate setup and broader API catalog.

## Connect

Add your deployment's `/api/mcp` URL as a **Streamable HTTP** MCP server with OAuth authentication. Open the client's authorization link, sign in to Free2Z, check the displayed username and permissions, and approve. Use **Switch account** if the browser is signed into a different account. Free2Z sign-in stays in the browser; the MCP client receives access and refresh tokens.

### Codex

```sh
codex mcp add free2z --url https://free2z.cash/api/mcp
codex mcp login free2z
```

Complete browser authorization, then start a session with the server enabled. To request just read access, use `codex mcp login free2z --scopes mcp:read,offline_access`. See [Codex's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Claude Code

```sh
claude mcp add --transport http --scope user free2z https://free2z.cash/api/mcp
```

Open `/mcp` in Claude Code and authenticate Free2Z. See [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

### Grok Build

```sh
grok mcp add --transport http free2z https://free2z.cash/api/mcp
grok mcp doctor free2z
```

In Grok Build 1.0.77, open `/mcp`, select Free2Z and press `i` to complete browser authorization. A diagnostic command by itself does not establish an authorized connection. See [Grok Build's MCP documentation](https://docs.x.ai/build/features/mcp-servers).

### OpenClaw and other interfaces

OpenClaw documents Streamable HTTP and browser OAuth:

```sh
openclaw mcp set free2z '{"url":"https://free2z.cash/api/mcp","transport":"streamable-http","auth":"oauth"}'
openclaw mcp login free2z
```

See [OpenClaw's transport and OAuth guide](https://docs.openclaw.ai/cli/mcp/transports). This setup is documented compatibility, not a recorded Free2Z end-to-end test.

An MCP label alone is insufficient: a client needs this HTTP transport, OAuth discovery and authorization-code authentication with PKCE, and a way to complete browser consent. Editors, terminal agents, desktop assistants and custom applications can implement those capabilities. Hosted chat products can impose their own connector, plan or administrator requirements. Developer APIs such as [OpenAI's MCP tools](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) and [xAI's remote MCP tools](https://docs.x.ai/developers/tools/remote-mcp) can accept a bearer token; the integrating application must arrange authorization and token renewal.

### Verification record

These checks use an isolated Free2Z test deployment. They do not certify the production endpoint or every feature of a client.

| Client | Verified behavior |
| --- | --- |
| Codex CLI 0.167.0 | Browser OAuth, account discovery, primary and linked-account draft creation, binary upload and grant revocation |
| Grok Build 1.0.77 | Browser OAuth and `free2z_list_accounts`; discovery of all 13 tools |
| Official Python MCP SDK 2.3.0 | Real HTTP protocol tests for `2026-07-28` and `2025-11-25` |
| Claude Code 2.1.319 | Browser OAuth, account discovery and selected-account public profile reads |
| OpenClaw | Documented Streamable HTTP and OAuth support; Free2Z end-to-end verification is not recorded here |

## Use more than one account

Start by asking the assistant to list your connected Free2Z accounts. Every content tool requires an explicit account username or the stable account-grant ID returned by `free2z_list_accounts`. There is no shared active account.

For example, connect the assistant as `foobar`, then ask:

> Connect Free2Z account baz to this connection so I can prepare drafts for it.

The assistant calls `free2z_connect_account` with the exact username and gives you a browser link. Open it, sign in as `baz`, and review the application, connection owner `foobar`, requested account `baz` and permissions. The page states that `foobar`'s connection will be able to act as `baz`. The accounts can belong to different people; whoever owns `baz` must approve that delegation. A browser signed in as `foobar` cannot approve the request for `baz`.

After approval, ask the assistant to list accounts again and select `baz` explicitly:

> Using Free2Z account baz, turn these notes into a draft. Keep it unpublished, read it back and give me the draft link.

Browser account changes do not change the MCP selection or revoke the existing connection. A missing, unavailable or unauthorized account selection fails without falling back to another account. Each linked account can have fewer permissions than the connection; an action needs both permissions.

## Permissions and removal

| Permission | Allows |
| --- | --- |
| `mcp:read` | Read visible pages, your public profile fields and your media metadata |
| `mcp:write` | Create/edit drafts and update your public profile |
| `mcp:publish` | Publish or unpublish pages, edit public pages and upload public media, together with the corresponding write/upload permission |
| `mcp:uploads` | Prepare file transfers and inspect their receipts |
| `offline_access` | Refresh authorization without another browser sign-in |

Free2Z's normal balance requirements and upload limits apply to the selected account. Account ownership, membership visibility, validation and throttling also apply. Profile access excludes email, balances and private settings. Hosted tools do not transfer money, buy subscriptions, change credentials, delete content permanently, fetch arbitrary URLs or run arbitrary API operations.

Open [Connected apps](https://free2z.cash/account/apps) on your deployment to inspect connections, linked accounts and recent attributed actions. A connection owner can remove one linked account or the whole connection; a linked account owner can remove its individual grant. Removing a direct application's access also revokes every primary connection authorized by that account for that application and their linked access. Removing a client's local configuration is not a substitute for revoking access in Free2Z.

## Drafts, edits and publishing

`free2z_create_draft` creates an unpublished page and accepts a UUID idempotency key. A retry with the same key and fields returns the same creation; conflicting fields are refused. Read a page with `free2z_get_page` before editing and pass its ETag as `if_match` to `free2z_update_page`. A stale ETag refuses an overwrite.

Publishing uses the separate `free2z_set_page_published` tool. Editing a public page also needs publication permission. A connection does not automatically publish anything, but an assistant with the necessary permission can invoke publication tools. State your intended audience and use your client's tool approvals.

The hosted tools also include page listing, public profile reads/updates and upload listing/details. Start with `free2z_list_accounts`; use `mine=true` with `free2z_list_pages` for the selected account's drafts. Follow returned pagination instead of treating one result page as the whole collection.

## Upload a file

Uploads use MCP authorization, independently of browser cookies. The client needs access to the file and an HTTP tool capable of streaming it. An MCP-only chat interface without file-reading and HTTP tools can work with existing media but cannot transfer a local file.

1. Compute the file's exact byte length and SHA-256 digest with the client's file tools.
2. Call `free2z_prepare_upload` with the selected account, filename, MIME type, length, digest and audience. The default audience is private; public media also requires `mcp:publish`.
3. Send the original bytes with HTTP `PUT` to the returned URL using the supplied capability and content-type headers and exact content length. The capability expires within two minutes; use it only for this transfer.
4. Read the returned media ID. If the response is lost, call `free2z_get_upload_status` with the account and upload ID before transferring again. An identical completed transfer returns its receipt without creating another file or charge.

Do not paste upload capabilities into page content or public logs. Account-specific file limits apply. A featured image must be public, even when its zPage is a draft or available only to members; choose that audience explicitly before attaching the returned media ID.

A timeout does not prove a mutation failed. Read the page, reconcile the draft's idempotency key or inspect upload status before retrying. If account-link approval has an uncertain result, check Connected apps before starting another request.
