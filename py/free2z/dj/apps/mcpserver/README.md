# Free2Z hosted MCP

This Django endpoint lets an MCP client read and edit Free2Z content through accounts that a user has explicitly authorized. Add the deployment's canonical URL followed by `/api/mcp` to a client that supports Streamable HTTP and OAuth authorization code with PKCE. The client discovers authorization metadata, opens Free2Z's browser consent screen, and stores its own access and refresh tokens. Users do not install a server or copy browser cookies.

The endpoint is part of the Free2Z Python application. It uses the hash-locked official Python MCP SDK; no Node.js runtime or npm installation is required for hosted access.

## Accounts and permissions

Call `free2z_list_accounts` first. It returns the connection ID, connection owner's username, and authorized accounts with stable grant IDs, current usernames, effective scopes, and availability. Every content tool requires an explicit `account`, either an exact listed username or its grant ID. A browser login cannot change that selection.

To add an account, call `free2z_connect_account` with its exact username. Open the returned consent link, sign in as that account, and approve the requested permissions. Linked accounts persist with the connection across token refreshes. A missing, revoked, renamed, or unauthorized selection fails without choosing another account. Free2Z's connected-apps settings lets account owners review and revoke connections and account grants. Connection owners can choose Add account there to request a ten-minute consent link with selected permissions, without an MCP token in the browser. The named account still signs in and approves; this never changes the acting account for tool calls.

| Permission | Access |
| --- | --- |
| `mcp:read` | Visible pages, owned media metadata, and public profile fields |
| `mcp:write` | Draft creation, permitted page edits, and public profile edits |
| `mcp:publish` | Publish or unpublish pages, edit published pages, and upload public media; also requires the corresponding write or upload permission |
| `mcp:uploads` | Prepare uploads, transfer their exact bytes, and reconcile upload receipts |
| `offline_access` | Let the client refresh its connection without another browser sign-in |

Each action uses the intersection of the connection token's permissions and the selected account grant's permissions. Ordinary Free2Z ownership, membership visibility, validation, throttling, balance requirements, and media limits also apply. An insufficient balance can prevent creation even when the app has permission to create drafts. Profile responses contain only `id`, `username`, `full_name`, `description`, `avatar_image`, and `banner_image`; these scopes do not expose email, balances, or private account settings.

## Tools

The server also exposes the five bounded text-AI tools and four discovery/dispatch tools described below.

| Tools | Purpose |
| --- | --- |
| `free2z_list_accounts`, `free2z_connect_account` | Inspect the connection and authorize additional accounts |
| `free2z_list_pages`, `free2z_get_page` | Browse visible content; use `mine=true` to list the selected account's drafts |
| `free2z_create_draft` | Create an unpublished page with a UUID idempotency key |
| `free2z_update_page` | Edit allowed fields with the page's current ETag |
| `free2z_set_page_published` | Explicitly publish a page or return it to draft |
| `free2z_get_profile`, `free2z_update_profile` | Read or update public profile fields |
| `free2z_list_uploads`, `free2z_get_upload` | Find the selected account's media and image variants |
| `free2z_prepare_upload`, `free2z_get_upload_status` | Transfer a file and recover its media ID after an interrupted response |

Tool input schemas come from the SDK and reject unsupported fields. The hosted surface excludes money transfers, subscription purchases, credential changes, arbitrary API requests, local server filesystem paths, and server-side URL fetching. The optional local stdio package has its own API catalog and configuration; its broader catalog is not the hosted server's permission contract.

## Writing and uploading

Create a draft with a new UUID idempotency key. Reusing that key with the same fields reconciles an interrupted creation; reusing it with different fields is refused. Read the page's ETag before editing and pass it as `if_match`. A stale ETag refuses the edit. Publishing is a separate tool, and editing an already published page also requires publication permission.

For a file, compute its byte length and SHA-256 with the client's file tools. Call `free2z_prepare_upload` with the account, plain filename, MIME type, byte length, digest, and desired access. The default access is private. The result contains a short-lived upload URL and an `X-Free2Z-Upload-Capability` header. Stream the original binary file with HTTP `PUT`, the supplied content type, and its exact content length. Do not place the file or capability in a public page or chat transcript.

The server verifies authorization before and after transfer, verifies the exact length and digest, and uses Free2Z's existing upload validation and storage handling. A successful response includes the media ID, which can be used as a page's `featured_image`. A repeated transfer of the same bytes returns the original receipt; changed bytes are refused. Use `free2z_get_upload_status` to reconcile a lost response without retransferring the file. Completed receipts survive access-token cleanup and are readable with a valid refreshed token for the same connection and selected account.

Capabilities expire within two minutes and no later than their issuing access token. Pending uploads require that original token and grant to remain valid. File limits follow the account's ordinary Free2Z tier. A client needs a file-reading HTTP tool to stream binary uploads; an MCP-only chat interface without that capability can manage content and existing media but cannot transfer a local file.

## Transport and verification

The transport is stateless Streamable HTTP with bounded JSON responses. Both `/api/mcp` and `/api/mcp/` accept `POST`; there is no persistent server session, long-lived SSE connection, or shared active account. Each request creates an isolated SDK server. Protocol negotiation and schemas belong to the official SDK. Interoperability tests exercise its modern `2026-07-28` and legacy `2025-11-25` client modes over real HTTP; client compatibility also depends on its OAuth discovery, registration, refresh, and browser flow.

MCP JSON input is limited to 4 MiB and output to 8 MiB. Binary uploads use their separate prepared endpoint. A missing or invalid bearer token returns an OAuth metadata challenge. Host and browser-origin checks are explicit; cookies never authenticate MCP calls.

The Django bridge runs under WSGI or ASGI without an additional MCP server process. Native tool work runs on the Django request thread inside account and grant authorization locks. Tool errors unwind the action transaction before becoming MCP error results. A timeout or lost response cannot prove whether a mutation committed: read the page, reuse its creation receipt, or inspect upload status before retrying.

Run the protocol-only HTTP tests from `py/free2z` with `python -m dj.apps.mcpserver.test_transport`. Run `pytest dj/apps/mcpserver` with the project's test dependencies and PostgreSQL configuration for real OAuth, selected-account writes, public-page permissions, rollback, upload replay, and token-refresh reconciliation.

## Reviewed operation catalog

The four discovery/dispatch tools (`free2z_search_operations`, `free2z_describe_operation`, `free2z_read`, `free2z_execute`) expose the reviewed native registry. See the [account operation guide](../../../../../docs/free2z/mcp/README.md) and [capability manifest](../../../../../docs/free2z/mcp/capabilities.json).

`registry.py` fixes each method, path and native identity; OpenAPI supplies descriptions, never authority. `dispatch.py` rejects extra body/query fields and enforces paid ceilings and retry keys. Native paid claims, debit and queued work commit together under selected-account lifecycle locks. Same-account concurrent calls serialize; post-commit retry replays the native receipt. All native owner checks, validation and balance rules apply. Broad account/security/financial routes without reviewed delegation are rejected before a native callback.

Separate `mcp:social`, `mcp:account`, `mcp:media`, `mcp:live` and `mcp:spend` consent covers these domains. `mcp:ai` authorizes bounded metered text AI through model/quote/start/status tools. Neither permission silently expands an existing account grant. Publication permission is required conservatively for variant, conversation, personality and series mutations, and dynamically for edits/deletion of public media.

File and export downloads use two-minute, resource-bound capabilities. Their payload contains identifiers, not OAuth credentials. Authorization is rechecked before streaming; storage I/O occurs outside account locks.
