# Free2Z MCP

Free2Z MCP connects an assistant to accounts you authorize. The hosted server supports pages, social activity, notifications, translations, media storage, saved conversations, publication exports and metered text AI. MCP means Model Context Protocol, the interface clients use to discover and call these tools. Free2Z runs the server; your client connects over HTTPS and asks you to authorize access in your browser.

**Prerequisite:** use a Free2Z deployment with hosted MCP enabled. The examples use `https://free2z.cash/api/mcp`; confirm that your deployment provides this endpoint before connecting. The [optional local stdio server](local-stdio.md) has a separate setup and a separate credential-based API catalog.

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
| `mcp:ai` | Quote text AI, authorize a maximum 2Z charge, queue a provider call and retrieve its receipt |
| `mcp:social` | Read and manage follows, mutes, blocks, comments and reports |
| `mcp:account` | Private account details, notifications, conversations and owner collections |
| `mcp:media` | Download and manage owned media and retrieve publication archives |
| `mcp:live` | Inspect, heartbeat or release the account's existing host session |
| `mcp:spend` | Bounded paid comments, votes and native translations, with their domain permissions |
| `mcp:delete` | Permanently delete content, together with its domain and publication permissions |
| `offline_access` | Refresh authorization without another browser sign-in |

Free2Z's normal balance requirements and upload limits apply to the selected account. Account ownership, membership visibility, validation and throttling also apply. Public profile tools exclude private fields; `auth_user_retrieve` requires separate `mcp:account` consent. Permanent content deletion additionally requires `mcp:delete`; an existing write or publication grant cannot delete content. Transfers, subscriptions, credential changes and arbitrary API requests require additional reviewed delegation; their catalog entries explain the gap. Existing connections and registered clients do not acquire new permissions automatically. A client registered before these permissions existed must register a new OAuth client (usually by removing and adding the server in its client settings), then request the needed scopes and complete fresh browser consent. Refreshing an old token or requesting scopes outside the old registration returns no additional authority. Existing connections continue to support their previously granted operations.

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


## Metered AI

Enable `mcp:ai` through browser consent on the connection and each selected
account. Content permissions alone cannot spend AI credits. The deployment must
support metered AI; `free2z_list_ai_models` reports whether it is enabled.

1. Call `free2z_list_ai_models` with the exact account. Select a provider and
   model from its available, discovered, reviewed-price catalogue.
2. Call `free2z_quote_ai` with the model UUID, prompt and an output-token limit.
   Inspect its per-token USD rates, markup multiplier, reasoning allowance and
   maximum charge in 2Z. Quotes expire after 15 minutes or earlier when a price
   expires. A model or price change requires a new quote.
3. Call `free2z_start_ai` with the quote token, an explicit maximum charge and a
   fresh UUIDv4 idempotency key. The account must cover the quote before the
   provider is called. Retry a lost response with the same quote and key.
4. Poll `free2z_get_ai_request` for the reply, token usage and exact charge.
   Requests are asynchronous. Polling may finalize the already-authorized charge from a retained result, but never calls the provider again or authorizes a new charge. Each account can have at most two live queued or running requests across its connections.
   `free2z_cancel_ai_request` prevents queued dispatch. A running provider call
   cannot be cancelled and settles within the quoted maximum.

Charges round up to **0.001 2Z**. One 2Z represents $0.01 of platform credit,
so the charge increment is $0.00001. The model's quoted markup multiplier
applies to its provider usage cost; for example, `1.5` means cost plus 50%.
Reported usage is priced and capped at the quoted maximum, with unused reserved credits returned. Free2Z absorbs provider usage cost above that maximum; the quote is a spending ceiling, not a guarantee of the provider’s eventual invoice. Where a
provider omits usage, the receipt identifies an estimate. Reasoning and cache
categories follow the selected model's pricing rules. A result awaiting settlement is withheld until its charge commits. Transient
database failures retry settlement using the retained result; an expired hold
produces a no-charge receipt and the answer stays withheld. A provider error can have
billable usage; inspect the receipt before deciding whether to start a new call.
An uncertain outcome is never automatically dispatched again.

A local open-model assistant can use these tools to delegate a difficult prompt
to a supported frontier model and pay from its selected Free2Z account. The end
user needs no login or subscription with that AI provider. Free2Z submits the
prompt using its provider credentials. This does not make prompt content
anonymous: content can identify its author, and the provider receives it under
its API policies. Free2Z links the charge to the selected account and retains
prompt/result content for 24 hours followed by hourly cleanup. Billing and
idempotency metadata persist after content expiry. Provider privacy links are
included in the catalogue.

For deployment operators, `MCP_AI_ENABLED` defaults to false. Apply migrations
and deploy dedicated `mcp-ai` queue workers with the `oidc.invoke_mcp_ai` task
registered before enabling admission. Keep this queue separate from general
background work and bound its worker concurrency. Populate provider discovery and reviewed prices;
unlisted, unpriced or expired-price models must not be offered.

## Discover account operations

Use `free2z_search_operations` with a task such as “notifications”, “translations”, “cloud storage” or “personas”. Set `supported=true` to find executable operations. Read `free2z_describe_operation` for the selected operation's path/query parameters, accepted body fields, permissions and retry requirements. Call `free2z_read` for a reviewed GET or `free2z_execute` for a mutation, always with the exact account. Follow pagination instead of loading the whole API schema into a prompt.

Page queries support native author, tag, language and date filters; use `ordering=-published_at` for latest publications. Text search uses a cached semantic vector when available and PostgreSQL full-text search otherwise. A hosted search does not request a new provider embedding. Native search ordering takes precedence over explicit sorting. Media queries support filename search, MIME-type prefix, access and ordering filters. Inspect each operation for its exact query names.

The [capability manifest](capabilities.json) lists every schema operation, whether it is supported, and each remaining gap's reason and closure path.

| Task | Supported operations |
| --- | --- |
| Catch up | Notifications/unread counts, email notification/visibility preferences, comments/replies, follows, mutes and blocks |
| Find content | Page and creator search, related pages, topic tags and language catalog |
| Translate and publish | Owner quote, purchase, status/jobs, batch purchase, variant read/edit/publish |
| Manage files | Owner media search/details, metadata/audience changes, deletion and private original-file downloads |
| Organize publications | Series, page order, tag suggestions, publication export jobs and ZIP downloads |
| Manage AI content | Saved conversations and forks, visible transcripts, owner personalities; generation uses the separate metered AI tools |
| Manage a broadcast | Stored public meeting discovery and the owner's existing session heartbeat/release |

Comments and replies cost at least 1 2Z; votes cost 1 2Z. Supply `mcp:spend`, the operation's domain permissions, a UUIDv4 `idempotency_key` and `max_charge_tuzis`. The server checks the limit before invoking the native ledger path. Retry an uncertain paid call with the identical key and arguments; changing the intent requires a new authorization. Free follows are distinct from paid subscriptions.

For a Mandarin translation, find the owned page, request `zpage_translation_quote` for the desired language, then pass the quote's price as `expected_price` and its `source_digest` to `zpage_translation_purchase`. Preserve any quoted settlement policy. Poll translation status until the draft is ready; read the variant and use its ETag to publish with `zpage_variants_partial_update`. Batch purchases retain each quoted language/price and must fit the combined ceiling. Native translation pricing, capacity and refund rules apply, separately from metered text-AI token pricing. Variant, conversation, personality and series mutations conservatively require both write and publish permission. Permanent deletion also requires `mcp:delete`. Read a page or variant and supply its single exact current ETag as `if_match` before deletion; wildcard and stale values are refused.

## Download and inspect a file

Search `myuploads_list`, then execute `mcp_prepare_download` with `body.upload_id`. Download the original file using the returned GET URL and private `X-Free2Z-Download-Capability` header. The capability expires within two minutes, is restricted to that original file and checks the issuing credential and account grant again at transfer. The URL alone is not authorized. Completed publication archives use `publication_exports_download` to obtain the equivalent ZIP capability.

A vision-capable agent can search media metadata, download candidate images and inspect them locally. This workflow requires the client's file/HTTP and vision tools; Free2Z does not provide a visual similarity index. Neither binary files nor credentials belong in chat or public logs.

Cloud deployments must configure protected internal offload routes for original media and publication archives. Original-media redirects use `/_internal_mcp_media/` with an exact object generation; publication archives use the native `/_internal_exports/` route. These routes must reject direct public access, strip client credentials, preserve original bytes and use bounded proxy buffers/timeouts. Django authorizes the capability and performs a bounded metadata lookup outside account transactions; the proxy transfers cloud bytes. Local filesystem deployments use a streaming file response.
