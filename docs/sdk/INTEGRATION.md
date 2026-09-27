# Integrating a tutor app with Free2Z

**Implementation snapshot: 2026-09-27.** An app worker can start the tutor UI,
its native adapter boundary, and mock-driven flows now. Real end-to-end SDK
integration is not ready yet. The API examples below target Rust core
[PR #1071](https://github.com/free2z/zuu/pull/1071), revision
[`27bed9be`](https://github.com/free2z/zuu/commit/27bed9be05902876182f8cdf030acee890499e13),
which has independent approval and is awaiting the required CI gate and merge.
Its 102 local all-target tests and strict lint checks pass; this is reviewed
preview source, not a published release or live-platform acceptance result.

## What can run today

| Surface | Verified implementation status | App work that can proceed |
|---|---|---|
| Rust core | Pending #1071; login, balance, card purchase and AI tests use local HTTP fakes | Build against the preview API in an isolated experiment; use the fake full-flow example |
| Desktop, iOS and Android Tauri integration | Plugin work tracked in [#1072](https://github.com/free2z/zuu/issues/1072) | Define commands, safe DTOs and event/cancellation ownership; implement a mock adapter |
| TypeScript facade and reference app | Tracked in [#1073](https://github.com/free2z/zuu/issues/1073) | Keep the tutor UI behind an app-owned interface that can later use the facade |
| Live metered AI | Deployment and ledger integration are still prerequisites in [#1047](https://github.com/free2z/zuu/issues/1047) | Model streams, failures and settlement in mocks; do not promise live charges or receipts |

The gateway source currently routes `POST /v1/chat`, but its metering/ledger
integration is unfinished. The SDK's models, estimate and call-record APIs
are covered by fakes; this does not prove those routes are wired in a deployed
gateway. This guide does not certify availability of the public issuer,
balance, checkout or AI endpoints. Before a live acceptance test, obtain the
platform's readiness confirmation, an app registration and approved test
accounts. Do not substitute production credentials for missing mocks.

## Installation and source evaluation

The package names in the [SDK contract](./README.md#the-namespace) are the
intended distribution names. On 2026-09-27, the official crates.io metadata
endpoints for `f2z-sdk`, `f2z-ai-proto` and `tauri-plugin-f2z`, and the npm
metadata endpoints for `@free2z/sdk` and `@free2z/tauri-plugin-f2z-api`, each
returned HTTP 404. The Rust workspace currently disables publishing.
The Tauri plugin and TypeScript facade are under implementation; their package
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
f2z-sdk = { git = "https://github.com/free2z/zuu", rev = "27bed9be05902876182f8cdf030acee890499e13" }
```

This is not the supported published-package installation and does not establish
release readiness. The preview requires Rust 1.97.1, the repository's pinned
toolchain. Git dependencies may fetch the repository's submodules; for the
smallest local experiment, check out the public source without recursively
initializing them and run the SDK's own fake example:

```sh
git clone --filter=blob:none https://github.com/free2z/zuu.git zuu-sdk-preview
cd zuu-sdk-preview
git checkout 27bed9be05902876182f8cdf030acee890499e13
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
loopback profile. For iOS and Android, implement `oauth::AuthSession` through
the platform authentication browser and return the complete callback URL to
the core. Prefer claimed HTTPS redirects where supported; register a controlled
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
remote content must not inherit those capabilities. The planned plugin will
supply this integration; the command names below are an app design proposal,
not an existing plugin API.

| Proposed adapter operation | Native responsibility | Safe UI result |
|---|---|---|
| `session` / `signIn` / `signOut` | Own `Client`, authentication session and keychain | Signed-in state, subject, granted scopes, persistence mode, revocation confirmation |
| `balance` | Call `Client::balance` | Available, held, total and debt milli-2Z plus `as_of` |
| `buy2z` / `purchaseStatus` | Create intent, open validated hosted checkout, poll | Intent ID and status; refreshed balance once credited |
| `models` / `estimate` | Call the corresponding AI methods when live support is ready | Capabilities and provisional hold estimate |
| `startChat` / `nextChat` / `cancelChat` | Own stream task and cancel handle, correlate by app operation ID | Text/tool events, call ID, receipt/settlement state and classified errors |

The native bridge under development uses **pull delivery**: `startChat` opens
one operation, `nextChat(operationId)` returns one event (or `null` when exhausted),
and `cancelChat(operationId)` stops delivery. Permit only one outstanding reader
per operation. A replay returns the existing call record rather than new answer
text. These are interface-design names while #1072/#1073 are in progress, not
commands to invoke against an assumed installed package.

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
change to the service's JSON wire format. A future web transport must preserve
integer number lexemes with a lossless parser or reject values outside the
safe range; converting an already-rounded `number` to `bigint` cannot recover
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
The first core implementation is card-first. Zcash and first-party store billing
names in the protocol are not implemented purchase flows for this tutor;
third-party apps do not use Free2Z's Apple/Google IAP rails.

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
| `insufficient_balance`, `account_in_debt`, `cap_exceeded` | Show top-up/debt/cap action; never automatically retry the charge |
| `Error::Unconfirmed { idempotency_key, .. }` | Retain the exact request and key; recover with the same key under the same user |
| `Error::Replayed(record)` | Display the existing call's receipt; no new completion or charge was produced |
| `Error::StreamInterrupted` / `Cancelled` | Preserve partial answer; look up settlement by call ID, or recover the same-key receipt if the ID was not obtained |
| `Event::Error` | Process both failure and `error.outcome()`; a failed answer may still cost credits |
| `Error::Storage` | Re-read native session state and report persistence trouble: failed prior deletion keeps the old session; failed replacement save can leave the new session memory-only. Never claim durable success |
| `Api` / unknown code or event | Switch on stable codes, preserve unknowns conservatively; never parse human messages |

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
bounded read lane and one write lane, so a stuck read cannot block logout's
write and repeated timeouts cannot create unlimited blocking tasks. Pending
writes coalesce to the newest operation; a later logout delete follows an active
save. Re-read native session state after a storage error. Orderly shutdown
should await sign-out when requested. Never expose the raw SDK error's debug
output to the webview as a universal error DTO: map stable classifications and
approved fields explicitly.

## Copyable tutor-worker handoff

Build the tutor UI and a mock implementation of an app-owned native adapter now.
Use the six scopes listed above. Model signed-out, signing-in, signed-in,
memory-only persistence and step-up states. Represent balances as integer
milli-2Z with debt separate; represent purchases by intent ID/status and streams
by operation ID, call ID, text, terminal event and settlement state. Include
mock cases for insufficient balance, partial charged failure, cancellation,
pending settlement, lost-response same-key recovery and account switching.

Own no Free2Z passwords, client secrets or provider keys. Keep credentials in
native code, keep untrusted content outside privileged Tauri capabilities, and
keep the adapter replaceable by #1072/#1073. Real integration starts after the
core merge/CI, plugin and facade implementation, published-package instructions,
and live registration/payment/metering readiness are confirmed. Acceptance then
requires one real registered-user sign-in, authoritative balance read, approved
test purchase through credited, and metered chat whose final receipt reconciles
with the refreshed balance, on each supported platform.
