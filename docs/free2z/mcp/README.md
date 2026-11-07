# Free2Z MCP

Free2Z MCP lets an AI assistant use your Free2Z account through the
[Model Context Protocol](https://modelcontextprotocol.io/). It runs on your
computer and connects to Free2Z over HTTPS. Claude Code, Codex, Grok Build, and
other MCP clients with local stdio support can start it as a subprocess.

The assistant can discover API operations, inspect their inputs, read pages and
account data, and perform authorized writes. This includes zPage drafts and
publishing, profiles, comments, follows, subscriptions, translations, and media.
Free2Z applies the same ownership, authentication, balance, and access rules as
for other clients. A configured credential grants the assistant that account's
authority; it is not a separate restricted API account.

This package provides a local stdio server. It does not provide a hosted MCP URL
for the Claude website, ChatGPT website, or xAI's remote MCP API.

## Install from source

Use Node.js 22 or later, npm, Git, and an MCP client. No Django server, database,
or Git submodules are needed to connect to `https://free2z.cash`.

```sh
git clone https://github.com/free2z/zuu.git
cd zuu/ts/free2z/mcp
npm ci
npm run build
npm test
node dist/cli.js --check
```

`--check` validates configuration and the operation catalog without contacting
Free2Z. To install a standalone package outside the checkout:

```sh
npm pack
npm install --global ./free2z-mcp-0.2.0.tgz
free2z-mcp --check
```

Use the resulting `free2z-mcp` executable instead of `node .../dist/cli.js` in the
client commands below. A global install may require configuring npm's prefix to
a directory you own. The source installation does not require global writes.
The package name is `@free2z/mcp`; these instructions install a local tarball and
do not assume an npm registry release.

Keep this checkout at a stable location. Use the absolute path to its built
entry point in your MCP client configuration. Updating the checkout requires
running `npm ci` and `npm run build` again.

## Connect your accounts

Public API reads work without credentials. For your own drafts, account data,
and writes, configure a Free2Z session or Knox token. Store credentials outside
this repository and out of chat messages.

### Named accounts

Use `FREE2Z_ACCOUNTS_FILE` to make multiple accounts available in one MCP
connection. Save a private JSON registry outside the checkout:

```json
{
  "accounts": {
    "alice": {
      "username": "alice",
      "session_file": "/absolute/private/alice-session.json"
    },
    "team": {
      "username": "example-team",
      "token_file": "/absolute/private/team-token.txt"
    }
  }
}
```

Aliases such as `alice` and `team` are local names you choose; `username` is the
exact Free2Z username expected for that credential. Preserve characters such as
an internal `@`; do not add an extra display-prefix `@`. Each profile
requires exactly one absolute `session_file` or `token_file` path. Use letters,
digits, underscores, or hyphens for aliases, up to 64 characters. `anonymous`,
`__proto__`, `constructor`, and `prototype` are reserved. Registry fields other
than those shown are rejected. Protect the registry and every credential file
with mode `0600` on macOS/Linux or an account-restricted ACL on Windows. Each
file must be a regular file of at most 64 KiB.

Configure `FREE2Z_ACCOUNTS_FILE` with the registry's absolute path. Do not also
set `FREE2Z_SESSION_FILE`, `FREE2Z_TOKEN_FILE`, or `FREE2Z_TOKEN`.
`free2z_list_accounts` lists aliases, configured usernames, and authentication
modes without reading credentials or making network requests. Its username
values describe the configuration; they do not prove a session is signed in.

Every `free2z_read` and `free2z_execute` call must supply `account` in this mode.
Before sending the requested operation, the server reads the selected credential
and calls `auth_user_retrieve`. The returned username must match exactly.
Expired credentials, a different account, unknown aliases, and omitted account
selection stop the request; the server never falls back to another account.
Successful calls include `account` and `verified_username` beside the API response.

The reserved `account: "anonymous"` sends no credentials and skips the identity
check. The API decides which anonymous operations are permitted. There is no
shared active account: selecting one profile does not change another call.
All profiles use the same configured Free2Z origin.

The registry and selected credential file reload for every call. Replace a file
atomically after reauthentication, keeping its private permissions; no server
restart is needed. An in-flight call keeps the same credential snapshot for its
identity check and requested operation. Rotation affects subsequent calls only.
The server does not renew expired sessions or tokens for you.

### Single-account compatibility

Without `FREE2Z_ACCOUNTS_FILE`, configure one of the three legacy credential
variables or omit them all for anonymous access. Calls without `account` keep
using that startup credential; no expected-username check is configured in this
mode. Explicit `account: "anonymous"` strips the credential for that call.
Other aliases require a registry. Restart the server after changing legacy
credential files. To migrate, create the registry, replace the legacy credential
environment variable with `FREE2Z_ACCOUNTS_FILE`, restart once, then include an
account alias in each read or execute call.

### Browser session, including media uploads

Sign in at [Free2Z](https://free2z.cash). Open your browser's developer tools,
then its Application or Storage panel and the cookies for `https://free2z.cash`.
Copy the values of `sessionid` and `csrftoken`. `sessionid` is HttpOnly, so
`document.cookie` cannot read it. If the CSRF cookie is absent, open the page
editor or perform an ordinary authenticated action in the website and inspect
cookies again.

Save the two values to a private JSON file. This optional Python 3 helper for
macOS and Linux prompts without echoing them or putting them in shell history:

```sh
python3 - <<'PY'
import getpass
import json
import os
from pathlib import Path

path = Path.home() / ".config/free2z/session.json"
path.parent.mkdir(parents=True, exist_ok=True)
values = {
    "sessionid": getpass.getpass("Free2Z sessionid: "),
    "csrftoken": getpass.getpass("Free2Z csrftoken: "),
}
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.fchmod(fd, 0o600)
with os.fdopen(fd, "w") as file:
    json.dump(values, file)
print(f"Saved {path}")
PY
```

On Windows, create the same JSON object with `sessionid` and `csrftoken` and
restrict the file's access to your own operating-system account. The server
checks POSIX file permissions on macOS and Linux; it does not check Windows ACLs.

For a named account, put this absolute filename in its `session_file` field.
Capture each account's cookies in its own signed-in browser session and verify
the registry's expected username. For a legacy single account, set
`FREE2Z_SESSION_FILE` instead. Sign-in renewal or sign-out can invalidate a saved
session; replace it after reauthentication. Named profiles reload on the next
call; legacy mode requires a restart.

### Knox token for API operations

Free2Z accepts `Authorization: Token <key>`. Supply the raw key through
a profile's `token_file`, or legacy `FREE2Z_TOKEN_FILE`/`FREE2Z_TOKEN`, without the `Token ` prefix. A token covers
token-authenticated API operations; legacy media-upload routes require a browser
session.

To obtain a token, sign in through the website and exchange that authenticated
session with `POST /api/token/login/`. The request must include the session cookie
and a matching `X-CSRFToken` header. The response contains `token` and `expiry`.
This is an authenticated exchange, not a username/password login endpoint.
Free2Z defaults to a ten-hour token lifetime and at most five active tokens per
account. Observe the returned expiry and replace expired tokens.

For example, in the developer console on `https://free2z.cash`, inspect this
snippet before running it. It copies the token to the clipboard without logging
it; `copy` is the browser developer console's helper:

```js
const csrf = document.cookie.match(/(?:^|; )csrftoken=([^;]*)/)?.[1];
if (!csrf) throw new Error("Open the page editor to initialize the CSRF cookie.");
const response = await fetch("/api/token/login/", {
  method: "POST",
  credentials: "same-origin",
  headers: { "X-CSRFToken": decodeURIComponent(csrf) }
});
if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
const result = await response.json();
if (typeof result.token !== "string") throw new Error("Missing token");
copy(result.token);
console.info("Token copied. Expires:", result.expiry);
```

Paste the key into a private text file with permissions `0600`, then clear the
clipboard. Revoking the token through `token_logout_create` ends that token's
access. Removing an MCP configuration only disconnects the client; it does not
revoke credentials at Free2Z.

## Configure an MCP client

Replace `/absolute/path/to/zuu` and `/absolute/path/to/accounts.json` below with
your paths. Use a Node executable available to the client; a desktop application
may need its absolute path. The examples use a named-account registry. Use a
session-backed profile for media uploads.

### Claude Code

```sh
claude mcp add --scope user \
  --env FREE2Z_ACCOUNTS_FILE=/absolute/path/to/accounts.json \
  --transport stdio free2z -- node /absolute/path/to/zuu/ts/free2z/mcp/dist/cli.js
claude mcp get free2z
```

Open `/mcp` in Claude Code to inspect the connection. See
[Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

### Codex

```sh
codex mcp add free2z \
  --env FREE2Z_ACCOUNTS_FILE=/absolute/path/to/accounts.json \
  -- node /absolute/path/to/zuu/ts/free2z/mcp/dist/cli.js
codex mcp get free2z
```

Start a new Codex session to load the server. See the
[Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Grok Build

```sh
grok mcp add --scope user \
  --env FREE2Z_ACCOUNTS_FILE=/absolute/path/to/accounts.json \
  free2z -- node /absolute/path/to/zuu/ts/free2z/mcp/dist/cli.js
grok mcp doctor free2z
```

Use `/mcps` in Grok Build to inspect or refresh the connection. This configuration
is for the installed Grok Build client. See
[Grok Build's MCP documentation](https://docs.x.ai/build/features/mcp-servers).

## Use Free2Z through your assistant

Start with a read:

> List my configured Free2Z accounts, then use account alice to show its zPage
> drafts. Include each page's title and URL.

A writing task can name the desired publication state:

> Using Free2Z account alice, create an unpublished zPage titled “My project notes” with the following
> Markdown. Read it back and show me the draft URL.

Publication, donations, subscription changes, paid AI requests, and deletion are
real actions. Tell the assistant what you intend, and use your client's approval
settings to control tool calls.

The server exposes a small tool set over the bundled Free2Z API schema:

| Tool | Purpose |
| --- | --- |
| `free2z_list_accounts` | List local aliases and expected identities; no network or credential disclosure |
| `free2z_search_operations` | Find operations by name, path, description, or tag |
| `free2z_describe_operation` | Inspect an operation's parameters, request body, and response contract |
| `free2z_read` | Invoke a read operation |
| `free2z_execute` | Invoke an operation that can change state |

Discover and describe an operation before calling it. The schema is bundled with
the package, so discovery does not send requests to Free2Z. For example, invoke these tools with the following arguments:

```json
{"query":"zpage", "method":"GET", "limit":10}
```

```json
{"operation_id":"zpage_list"}
```

```json
{"account":"alice", "operation_id":"zpage_list", "query":{"mine":true,"page":1}}
```

These are arguments for `free2z_search_operations`,
`free2z_describe_operation`, and `free2z_read`, respectively. Search results have
`offset`/`limit` pagination, separate from the API's own list pagination.
`free2z_read` permits GET operations. `free2z_execute` accepts both GET and
mutation operations. Both accept `operation_id`, an `account` alias (required in profile mode), and optional `path`, `query`, `headers`,
`body`, `content_type`, and `files`; the described operation determines which
are meaningful. Known query parameters are validated against the schema.
Additional query parameters can contain strings, numbers, booleans, or arrays
of these values for filters that the API supports but its schema omits.
`zpage_list` discovery includes `search` and `username` filters. Successful HTTP calls return an envelope with `operation_id`,
`status`, `ok`, `headers`, and `data`. Profile calls also return `account` and
`verified_username` outside the untrusted API `data`; anonymous calls return a
null verified username. Response header names are lowercase:
read `headers.etag` for concurrency control and
`headers["idempotency-key-honored"]` before relying on safe create retries.
`data` contains the API response body. The running server only calls the configured Free2Z origin; it does not accept arbitrary destination
URLs from a tool argument.

### zPage writes and pagination

Use `zpage_list` with `mine=true` to see your drafts. Owner reads without that
parameter use the public representation. `zpage_retrieve` takes an `id` that is
the page's `free2zaddr` UUID or vanity slug, not a database row number.

To create a draft, describe `zpage_create`, then supply `title`, Markdown
`content`, `tags` (an array, empty if unused), `source_language`, and
`is_published: false`. Keep a unique UUIDv4
`Idempotency-Key` for that creation. Generate a new key for each new page; keep it
unchanged for retries of that page:

```json
{
  "account": "alice",
  "operation_id": "zpage_create",
  "headers": {"Idempotency-Key": "NEW_UUIDV4_FOR_THIS_PAGE"},
  "body": {
    "title": "My project notes",
    "content": "# Project notes\n\nA first draft.",
    "source_language": "en",
    "tags": [],
    "is_published": false
  }
}
```

Send this to `free2z_execute` after replacing the key placeholder. A successful
keyed replay returns the same page; changing the body while reusing the key returns `409`. After a timeout,
retry only when the server's `Idempotency-Key-Honored` response header has
established support, using the same body and key.

Before editing, read the page and retain its `ETag`. Send that value as
`If-Match` to `zpage_partial_update`. A `412` means the page changed: reread and
reconcile the edit. Omitting `If-Match` permits one editor to overwrite another.
For example, after retrieving the page, invoke `free2z_execute` with your
actual page UUID and its complete, quoted ETag:

```json
{
  "account": "alice",
  "operation_id": "zpage_partial_update",
  "path": {"id": "PAGE_UUID"},
  "headers": {"If-Match": "\"ETAG_FROM_READ\""},
  "body": {"title": "Revised project notes", "is_published": false}
}
```

Read back the result with `mine=true` to verify both content and publication state.

List responses are paginated. Follow the operation's `page`, `page_size`, or
cursor contract and inspect `next`; a single `results` array is not the whole
collection. `zpage_list` supports `pagination=cursor` with its returned cursor.
Preserve filters when continuing. Use owner-list `published_count` and
`draft_count` for whole-queryset totals rather than counting one page.

### Media

The catalog adds `uploads_single_public` and `uploads_batch` for Free2Z's
session-authenticated upload routes. The single-file route accepts a `file`
field; the batch route accepts repeated `files` and a JSON-encoded `body` array
with one metadata object per file, in the same order. For a private single file,
invoke `free2z_execute`:

```json
{
  "account": "alice",
  "operation_id": "uploads_single_public",
  "content_type": "multipart/form-data",
  "body": {"title": "Project diagram", "access": "private"},
  "files": {"file": {"path": "/absolute/path/to/diagram.png"}}
}
```

File paths refer to the machine running the MCP server. Each file descriptor can
also supply `filename` and `content_type`; a repeated multipart field accepts an
array of descriptors. The server reads those local files and sends their bytes.
Despite the single-file route's name, its `access` field selects the audience.
Keep `access` explicit: `private`, `members`, and `public` have different audiences. Use the returned
media ID for a zPage's `featured_image`, and the returned URL for inline content.
A featured image must be publicly accessible even on a subscriber-only page.

`myuploads_list`, `myuploads_partial_update`, and `myuploads_destroy` manage
existing uploads. `myuploads_create` does not receive bytes and always returns
`400`; it is not an upload endpoint. Read `uploads_limit` for the
account's current upload limit rather than assuming a file-size allowance.

## Errors and authority

Account verification failures are tool errors without executing the requested
operation. Check the selected profile's expected username and replace expired
credentials; the listing tool itself does not verify them. After verification,
API failures are tool errors, with the HTTP status and available server detail.
A `401` or `403` can indicate missing, expired, or revoked credentials, a required
recent login, or insufficient permission. Signing in again does not grant access
to another account's data. `402` indicates a balance or purchase requirement;
`409` and `412` describe state conflicts; `429` indicates throttling.

A network timeout does not prove a write failed. Inspect current state before
retrying; reuse an idempotency key only where that operation documents support.
Do not repeat payments or creates blindly. Keep API decimal values, including
balances and monetary amounts, as strings to preserve their exact precision.

The MCP server does not hold a Zcash seed, sign wallet transactions, decrypt
E2E2Z messages, or bypass Free2Z permissions. Schema operations that depend on an
external callback, a session-specific security ceremony, or a separately deployed
service can require additional steps. Read their descriptions and API responses.
Browser sign-in and checkout, WebSockets, and client-side encrypted messaging are
outside this interface. Confidential OAuth client authentication is also outside
its account-authentication modes: client-credentials exchanges and authenticated
introspection require a separate OAuth client integration. AI event streams are buffered into a single response,
subject to the request timeout and response-size cap. Returned credentials are
redacted, so token acquisition belongs in the browser or a separate local setup
step, not in an assistant tool response.

## Configuration and limits

| Variable | Meaning / default |
| --- | --- |
| `FREE2Z_BASE_URL` | Free2Z origin, default `https://free2z.cash`; HTTPS required except HTTP loopback for development |
| `FREE2Z_ACCOUNTS_FILE` | Absolute path to a private named-account registry; exclusive with legacy credential variables |
| `FREE2Z_SESSION_FILE` | Absolute path to private JSON containing `sessionid` and `csrftoken` |
| `FREE2Z_TOKEN_FILE` | Absolute path to a private file containing a raw Knox token |
| `FREE2Z_TOKEN` | Raw Knox token supplied by the process environment |
| `FREE2Z_TIMEOUT_MS` | Request timeout; default `120000` milliseconds |
| `FREE2Z_MAX_RESPONSE_BYTES` | Response limit; default `8388608` bytes (8 MiB) |
| `FREE2Z_MAX_UPLOAD_BYTES` | Local upload limit; default `104857600` bytes (100 MiB) |

Choose one credential variable, or none for anonymous access. Origin and limits
are read at startup. Named-account registry and selected credential files reload
per call; legacy credential files are read at startup. `--check` validates the
registry structure and permissions without contacting Free2Z or opening its
credential files. Verify a profile by making an explicit authenticated read.
The upload cap is an additional local bound; Free2Z can impose a lower
account-specific limit. Requests do not follow redirects. The configured
origin cannot contain a username, password, path, query, or fragment.
Credentials are redacted from tool output; keep the private files protected.

## Develop and verify

The authoritative API schema is
[`py/free2z/dj/free2z/openapi/f2z.yaml`](../../../py/free2z/dj/free2z/openapi/f2z.yaml).
The package and its tests live in
[`ts/free2z/mcp`](../../../ts/free2z/mcp/).

After changing the authoritative schema, run `npm run schema:update` in the
MCP package and commit its bundled schema. `npm run schema:check` detects drift.
Run the package's build and tests before changing client configuration. A live
smoke test should initialize MCP, list tools, discover an operation, and read a
public page. To test account access, read `auth_user_retrieve` and your own draft
list. Use an explicitly chosen disposable draft for write testing and verify its
state after each mutation.

The [announcement source](announcement.md) is a zPage-ready introduction.
