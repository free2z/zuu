# Integrating a tutor app with Free2Z

**Implementation snapshot: 2026-09-28 UTC.** The reviewed Rust core is merged, and
reviewed native/TypeScript source previews can be used for real SDK integration.
Start with [the pinned source-preview installation and Tauri adapter guide](./SOURCE-PREVIEW.md).
Registry publication and live end-to-end acceptance are still pending; building
the real SDK does not establish availability of every service or payment rail.

The Rust examples below target merged core
[`534d2a58`](https://github.com/free2z/zuu/commit/534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860),
which includes the reviewed grant API alongside login, balance, purchase and
AI operations. Local fake-service regressions and native builds are not live
service acceptance evidence.

## What can run today

| Surface | Verified implementation status | App work that can proceed |
|---|---|---|
| Rust core | Merged core and grant API; account and AI regression tests use local HTTP fakes | Build against the preview API in an isolated experiment; use the fake full-flow example |
| Desktop, iOS and Android Tauri integration | Reviewed source preview [#1081](https://github.com/free2z/zuu/pull/1081) | Register the real native plugin and local capabilities using the source-preview guide |
| TypeScript facade and reference app | Merged facade plus reviewed grant API [#1106](https://github.com/free2z/zuu/pull/1106); reference app remains under #1073 | Use Client + NativeTransport through an app-owned adapter; retain mocks for unavailable services |
| Live metered AI | Deployment and ledger integration are still prerequisites in [#1047](https://github.com/free2z/zuu/issues/1047) | Model streams, failures and settlement in mocks; do not promise live charges or receipts |

The gateway source implements authenticated models/estimate, durable streamed and nonstreamed
paid text chat and scoped receipts with the PostgreSQL function adapter. Restricted
PostgreSQL tests cover settlement recovery and revocation after admission. This
is implementation evidence, not proof that a particular deployment, provider
configuration or registered application has passed live acceptance. This guide does not certify availability of the public issuer,
balance, checkout or AI endpoints. Before a live acceptance test, obtain the
platform's readiness confirmation, an app registration and approved test
accounts. Do not substitute production credentials for missing mocks.

## Installation and source evaluation

The package names in the [SDK contract](./README.md#the-namespace) are the
intended distribution names. On 2026-09-27, the official crates.io metadata
endpoints for `f2z-sdk`, `f2z-ai-proto` and `tauri-plugin-f2z`, and the npm
metadata endpoints for `@free2z/sdk` and `@free2z/tauri-plugin-f2z-api`, each
returned HTTP 404. The Rust workspace currently disables publishing.
The Tauri plugin and TypeScript facade have reviewed source previews; their package
interfaces are not released yet. Do not add an invented npm version or assume
an in-progress plugin command is a supported release API. Supported third-party integration will use published
packages when the release is announced. The intended commands below are
**not available yet**; run them only after the platform announces and verifies
an actual release:

```text
cargo add f2z-sdk
cargo add tauri-plugin-f2z
npm install @free2z/sdk @free2z/tauri-plugin-f2z-api
```

Plugin registration, capabilities and mobile setup still require the released
plugin's own installation instructions; adding dependencies alone is insufficient.

For **pre-release source experimentation only**, Cargo can identify the public
preview by commit, without a private repository or a path into this workspace:

```toml
[dependencies]
f2z-sdk = { git = "https://github.com/free2z/zuu", rev = "534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860" }
```

This is not the supported published-package installation and does not establish
release readiness. The preview requires Rust 1.97.1, the repository's pinned
toolchain. Git dependencies may fetch the repository's submodules; for the
smallest local experiment, check out the public source without recursively
initializing them and run the SDK's own fake example:

```sh
git clone --filter=blob:none https://github.com/free2z/zuu.git zuu-sdk-preview
cd zuu-sdk-preview
git checkout 534d2a58c5baa6fa67ccd8a0d5ab1e18adb5b860
cd rs
cargo +1.97.1 run --locked -p f2z-sdk --example full_flow
cargo +1.97.1 test --locked -p f2z-sdk --all-targets
```

`full_flow` starts local fakes of the issuer, account API and gateway. It needs
no real account, payment or provider key, and performs no real purchase. Its
checkout URL is illustrative. Passing it proves the client flow against those
fakes, not a live platform deployment.

## Registration and the native boundary

Register a **public native client**; a Tauri app cannot protect a client secret.
Request `openid profile offline_access balance:read purchase:create ai:invoke`
(the Rust core's defaults). Read the granted scopes after sign-in: the user can
decline permissions. Do not enable purchase or AI actions merely because the
app asked for them. `client_id` is public configuration.

Desktop uses a registered `http://127.0.0.1:<port>/callback` redirect, with a
random listener port and the registration's exact path. `localhost` is not the
loopback profile. For iOS and Android, use the native plugin's platform authentication browser
adapter and configure its registered mobile redirects; a custom Rust host can
implement `oauth::AuthSession` directly. Prefer claimed HTTPS redirects where supported; register a controlled
reverse-DNS scheme as the fallback. See [redirect rules](./spec/oidc.md#3-redirect-uris).
The core validates state, issuer and tokens; the adapter must not synthesize a
successful callback or use an embedded webview for login.

Keep one long-lived `Client` in native app state. Its clones share one session
and one refresh lock. Keep that client on one living Tokio runtime; after
shutting the runtime down, create a new client rather than moving pending work
to another runtime. Do not construct a client per command or two clients
against the same stored refresh-token family. Use an OS keychain `TokenStore`;
`KeyringStore::new` accepts an explicitly constructed platform credential store.
The core does not install a process-global keyring backend. The plugin must
choose and test the backend separately on desktop, iOS and Android. If it
falls back to `MemoryStore`, expose `Persistence::MemoryOnly` to the UI so the
user knows a restart requires sign-in.

In a Tauri 2 app, **access and refresh tokens stay in Rust**. Do not expose
`Client::access_token`, serialized session blobs, OAuth callback URLs or
arbitrary authenticated HTTP requests as JavaScript commands. Grant the tutor
window only the commands it needs; untrusted lesson HTML, external windows and
remote content must not inherit those capabilities. The reviewed native plugin
supplies this boundary; use its exported guest API through `NativeTransport`,
rather than reimplementing authentication or invoking guessed command names.

| Native guest operation | Native responsibility | Safe UI result |
|---|---|---|
| `session` / `signIn` / `signOut` | Own `Client`, authentication session and keychain | Signed-in state, subject, granted scopes, persistence mode, revocation confirmation |
| `balance` | Call `Client::balance` | Available, held, total and debt milli-2Z plus `as_of` |
| `createPurchase` / `purchase` / `waitForPurchase` | Create intent, open validated hosted checkout, poll | Intent ID and status; refreshed balance once credited |
| `models` / `estimate` | Call the corresponding AI methods when live support is ready | Capabilities and provisional hold estimate |
| `startChat` / `nextChat` / `cancelChat` | Own stream task and cancel handle, correlate by app operation ID | Text/tool events, call ID, receipt/settlement state and classified errors |

The reviewed native bridge uses **pull delivery**: `startChat` opens
one operation, `nextChat(operationId)` returns one event (or `null` when exhausted),
and `cancelChat(operationId)` stops delivery. Permit only one outstanding reader
per operation. A replay returns the existing call record rather than new answer
text. The source-preview guide installs the exact guest and facade packages
that expose these methods; registry installation remains pending.

Generate and retain both an operation ID and an idempotency key **before** the
opening invoke. Cancellation can happen while opening or waiting for refresh,
before the core returns a `CancelHandle`; the adapter must own that opening
operation too. Bound native event buffering and remove operation entries on
completion, error, window close and sign-out. Associate each operation with the
signed-in subject and session generation; discard late UI events from a replaced
session. Keep the exact request and key when restart recovery is required.

## Rust API examples

The following helpers compile together against the preview. They are native
adapter building blocks, not a complete Tauri plugin. Supply a real platform
opener and a tested keychain store; the UI transport and persistence of operation
keys belong to the app.

```rust
use std::sync::Arc;
use std::time::Duration;
use f2z_sdk::{Client, Config, Error, SignInOptions, TokenStore};
use f2z_sdk::ai::{CancelHandle, Charge, ChatOptions};
use f2z_sdk::oauth::{LoopbackSession, SignedIn, UrlOpener};
use f2z_sdk::proto::{ChatRequest, Event, Whole2z};
use f2z_sdk::proto::balance::Balance;
use f2z_sdk::proto::chat::{ContentPart, Message, Role};
use f2z_sdk::purchase::{Platform, PollOptions, PurchaseIntent, PurchaseRequest};

pub fn make_client(client_id: &str, store: Arc<dyn TokenStore>) -> Result<Client, Error> {
    Client::new(Config::new(client_id), store)
}

pub async fn desktop_sign_in<O: UrlOpener>(
    client: &Client,
    opener: O,
) -> Result<SignedIn, Error> {
    let session = LoopbackSession::bind(opener).await?;
    client.sign_in(&session, SignInOptions::default()).await
}

pub async fn read_balance(client: &Client) -> Result<Balance, Error> {
    client.balance().await
}

// Keep the same key AND return URL when retrying this intent creation.
// Open the checkout only after the user chooses to purchase.
pub async fn create_card_checkout(
    client: &Client,
    platform: Platform,
    return_url: &str,
    operation_key: &str,
    opener: &dyn UrlOpener,
) -> Result<PurchaseIntent, Error> {
    let request = PurchaseRequest::card(Whole2z::new(500), platform, return_url)
        .with_idempotency_key(operation_key);
    let intent = client.create_purchase(&request).await?;
    let checkout = intent.checkout_url()
        .ok_or_else(|| Error::Protocol("missing HTTPS checkout URL".into()))?;
    opener.open(checkout).map_err(Error::Browser)?;
    Ok(intent)
}

pub async fn poll_purchase(client: &Client, id: &str) -> Result<PurchaseIntent, Error> {
    client.wait_for_purchase(id, PollOptions::max_wait(Duration::from_secs(60))).await
}

pub fn tutor_request(model: &str, prompt: &str) -> ChatRequest {
    ChatRequest {
        model: model.into(),
        messages: vec![Message {
            role: Role::User,
            content: vec![ContentPart::Text { text: prompt.into() }],
            tool_calls: vec![],
            tool_call_id: None,
        }],
        tools: vec![],
        max_output_tokens: Some(400),
        // true: refuse up front instead of running a shorter call (below).
        max_output_tokens_strict: true,
        stream: true,
        metadata: Default::default(),
        fallback: vec![],
    }
}

pub async fn stream_tutor(
    client: &Client,
    request: ChatRequest,
    operation_key: &str,
    on_open: impl FnOnce(CancelHandle),
    mut on_event: impl FnMut(Event),
) -> Result<Option<Charge>, Error> {
    // Disable new-call automatic retries so this app-owned key identifies one
    // logical billable attempt. Same-key transport recovery remains enabled.
    let options = ChatOptions::default()
        .with_idempotency_key(operation_key)
        .with_max_retries(0);
    let mut stream = client.ai().chat_with(request, options).await?;
    on_open(stream.cancel_handle());
    let mut charge = None;
    while let Some(event) = stream.next().await? {
        match &event {
            Event::Done(done) => charge = Some(Charge::from(done.outcome())),
            Event::Error(error) => charge = Some(Charge::from(error.outcome())),
            _ => {}
        }
        on_event(event);
    }
    // A terminal error is an Event::Error for this streaming API; it is not
    // converted into an Err here. The UI must process that event and charge.
    Ok(charge)
}
```

Pass a currently advertised model ID, not an example model string. An estimate
is a provisional hold, not a maximum charge. The gateway may extend holds; the
user's account balance and consented cap are the spending bounds. Treat model
output as untrusted text and validate any proposed tool invocation in the tutor.
The gateway does not execute tools on the app's behalf.

### Output that must not be truncated: `max_output_tokens_strict`

By default `max_output_tokens` is a ceiling the gateway may **lower**: to the
model's own `max_output_tokens`, to the context window left after the input,
and — the one that surprises apps — to what the user's balance and this app's
remaining budget can afford. A lowered call runs, ends with
`finish_reason: "length"`, and **is charged**. If your app throws a
length-truncated answer away (a lesson that must be whole, a JSON document that
must parse), the user paid for nothing.

Set `max_output_tokens_strict: true` (Rust `ChatRequest`, TS `ChatRequest`,
Tauri guest `ChatRequest`) together with `max_output_tokens`. The gateway then
either runs the call with exactly that output limit or refuses it **before any
hold, charge or provider request**, with the code you already handle:

| Would have been lowered by | Strict refusal | `details` |
|---|---|---|
| balance | `402 insufficient_balance` | `reason: "max_output_tokens_strict"`, `max_output_tokens`, `required_2z` (the hold the full output needs), `available_milli_2z`, `min_charge_2z` |
| this app's budget (cap) | `403 cap_exceeded` | as above, plus `cap_remaining_milli_2z` |
| context window | `400 context_length_exceeded` | `reason`, `max_output_tokens`, `input_tokens_estimate`, `context_window` |
| model ceiling | `400 invalid_request` | `field: "max_output_tokens"`, `reason`, `model_max_output_tokens` |

`max_output_tokens_strict` without `max_output_tokens` is
`400 invalid_request` (`field: "max_output_tokens"`, `reason: "required"`).
The default (`false`) is never sent on the wire, so a request that does not set
it is byte-identical to one made before the field existed, and its
idempotency fingerprint is unchanged. A gateway older than the field refuses it
as an unknown field (`400 invalid_request`) rather than silently clamping.

To tell the user *before* they press Generate, call `estimate` with the same
request **without** the flag: `max_output_tokens` in the answer is the
post-clamp limit the call would run with right now. If it is lower than you ask
for, show "top up or raise this app's budget" instead of starting the call.
An estimate is a snapshot — balance and budget can change before the call — so
keep the flag on the call itself; the estimate is for the UI, the flag is the
guarantee. (An estimate **with** the flag answers with the same refusal the
call would.)

```ts
const request: ChatRequest = { model, messages, max_output_tokens: 1800n };
const estimate = await client.estimate(request);
if (estimate.max_output_tokens < request.max_output_tokens!) {
  // Would be truncated: offer a purchase / budget change instead of calling.
}
const stream = await client.chat(
  { ...request, max_output_tokens_strict: true },
  { idempotencyKey, operationId },
);
// insufficient_balance / cap_exceeded here cost nothing and ran nothing.
```

A strict call can still end with `length` if the model itself uses every
token you allowed — that is your limit, not the gateway's, and is charged
like any other completed call.

### Balance precision and purchase completion

Show `available_milli_2z`; show a nonzero `debt_milli_2z` separately.
`balance_milli_2z` includes the held portion. Re-read the authoritative balance
after credited purchases, finalized calls and app foregrounding. Do not add
purchase quantities locally or subtract `done` hints as if they were a ledger.
Other devices and calls can change the balance concurrently.

The service uses JSON integer amounts. Although the metering specification
requires a JavaScript-safe bound, the current Rust amount types accept `u64`
and ordinary account responses do not yet establish that bound. Therefore
serialize native-to-JavaScript amount DTOs as **decimal strings**, and use
JavaScript `bigint` internally. This is an app bridge representation, not a
change to the service's JSON wire format. The reviewed TypeScript FetchTransport
preserves integer number lexemes with a lossless parser; a custom transport must
preserve them or reject unsafe values. Converting an already-rounded `number`
to `bigint` cannot recover
its original value. Keep `_2z` and `_milli_2z` names distinct. Format 41,500
milli-2Z as 41.500 2Z only at the display boundary.

For desktop purchases, `purchase::ReturnListener::bind("/purchase-done")`
provides a loopback `return_url`; keep the listener alive through checkout.
Mobile must use an app-registered return URL supported by the purchase contract
and the platform browser. The redirect is a wake-up hint, **not evidence of
credit**. Poll even if the browser is closed without a callback.

`wait_for_purchase` returns the last observed intent when its wait budget ends;
that intent may still be `created`, `pending` or `paid`. Only `credited` means
credits reached the account. Retain the intent ID, continue polling on resume,
and handle expiration, failure, refunds, disputes and unknown statuses.
The reviewed native/facade preview can create card or Zcash intents; this does
not certify a live payment rail for the tutor. The plugin uses its registered
HTTPS purchase-return URL. Third-party apps do not use Free2Z's first-party
Apple/Google IAP rails.

### Cancellation, receipts and errors

“Stop” ends delivery. Generation and settlement can continue, so never show
“cancelled = free.” Keep the call ID from `meta` (or `ChatStream::call_id`) and
resolve the receipt using `ai().call` or `wait_for_call`. A wait may return a
nonterminal record: keep showing “settling.” `Charge::NotFinal` is not zero;
for a final charge with a shortfall, distinguish the priced whole-2Z amount
from `collected_milli_2z` actually taken.

| Result | Application action |
|---|---|
| `Error::SignedOut` | Clear signed-in UI and request login; do not continue spending |
| `Error::StepUpRequired(challenge)` | Sign in with `SignInOptions::step_up(&challenge)` and retry the intended operation once, bound to the same account |
| `insufficient_balance` | Offer a purchase or the Billing link on [Free2Z connected apps](https://free2z.cash/account/apps); re-read balance after confirmed credit |
| `cap_exceeded` | Direct the user to [manage this app's budget in Free2Z](https://free2z.cash/account/apps), or wait for its reset period. Topping up account balance does not raise this budget |
| `account_in_debt` | Show debt separately and direct the user to Free2Z account management; do not automatically retry a charge |
| `rate_limited`, `concurrency_limit`, `unavailable` | Honor `Retry-After` and explain temporary capacity/availability, not a need to buy credits or raise a budget |
| `Error::Unconfirmed { idempotency_key, .. }` | Retain the exact request and key; recover with the same key under the same user |
| `Error::Replayed(record)` | Display the existing call's receipt; no new completion or charge was produced |
| `Error::StreamInterrupted` / `Cancelled` | Preserve partial answer; look up settlement by call ID, or recover the same-key receipt if the ID was not obtained |
| `Event::Error` | Process both failure and `error.outcome()`; a failed answer may still cost credits |
| `Error::Storage` | Re-read native session state and report persistence trouble: failed prior deletion keeps the old session; failed replacement save can leave the new session memory-only. Never claim durable success |
| `Api` / unknown code or event | Switch on stable codes, preserve unknowns conservatively; never parse human messages |

Optional app budgets belong to the Free2Z user. The developer may suggest a
budget for a new grant but cannot raise the user's consent. Use `client.grant()`
(or Rust `Client::grant`) for the original limit/period and explicit enforcement;
remaining balance or an estimate cannot prove that policy. Re-read grant and
balance after account management. See [the concrete budget recovery flow](./SOURCE-PREVIEW.md#user-owned-budgets-and-recovery).

Same-key recovery must use the identical request body, same app and same user.
For purchases this includes the original return URL: allocating a new loopback
port and changing that URL during recovery changes the body. Persist the key,
intent/call ID and required request data deliberately if restart recovery is
needed; do not log prompts, completions, tokens or callback URLs. Scope recovery
records to the account and clear or quarantine them on account changes.

The chat idempotency window is 24 hours. Do not automatically re-send an old key
after that window: it can become a new billable call. A recovered receipt has no
answer text because the gateway does not retain completions. Generating another
answer is an explicit new operation with a new key. Defaults may automatically
retry eligible uncharged failures with a new key; the example disables that
behavior so the app owns the retry decision.

`sign_out().await` clears local state and returns whether server revocation was
confirmed. `false` does not promise server revocation. Cancellation-independent
cleanup tasks still require the native runtime to remain alive. Keychain waits
are bounded by `Config::request_timeout`, but an OS call can finish later:
`Error::Storage` does not confirm persistence or deletion. Each client has one
bounded read lane and one write lane, so logout can start its delete while a
read is pending and repeated timeouts cannot create unlimited blocking tasks.
The credential backend may itself serialize or block calls; a delete that times
out remains unconfirmed. Pending
writes coalesce to the newest operation; a later logout delete follows an active
save. Re-read native session state after a storage error. Orderly shutdown
should await sign-out when requested. Never expose the raw SDK error's debug
output to the webview as a universal error DTO: map stable classifications and
approved fields explicitly.

## Copyable tutor-worker handoff

Build the tutor UI behind an app-owned adapter using the real pinned
`Client(new NativeTransport(nativeBridge))` preview, with a mock implementation
for deterministic tests and service flows not yet confirmed live.
Use the six scopes listed above. Model signed-out, signing-in, signed-in,
memory-only persistence and step-up states. Represent balances as integer
milli-2Z with debt separate; represent purchases by intent ID/status and streams
by operation ID, call ID, text, terminal event and settlement state. Include
mock cases for insufficient balance, partial charged failure, cancellation,
pending settlement, lost-response same-key recovery and account switching.

Own no Free2Z passwords, client secrets or provider keys. Keep credentials in
native code, keep untrusted content outside privileged Tauri capabilities, and
keep package versions pinned through the preview merge/release process. Source
integration can begin now; live acceptance requires confirmed client registration,
payment and metering readiness. Acceptance then
requires one real registered-user sign-in, authoritative balance read, approved
test purchase through credited, and metered chat whose final receipt reconciles
with the refreshed balance, on each supported platform.
