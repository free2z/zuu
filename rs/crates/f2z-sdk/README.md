# f2z-sdk

The Free2Z Rust SDK core: OpenID Connect sign-in, 2Z balances, card/Zcash
purchase intents, and micro-metered AI. MIT licensed; no Tauri dependency.

**Pre-release source preview.** The core is independently reviewed and merged,
but this crate is not published. `publish = false` remains in force. Production
OAuth/payment/gateway acceptance and native OS integration are separate release
requirements. Start with the public
[integration guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/INTEGRATION.md).

## Constructing a client

The current release is `0.2.0`, Git tag `sdk-v0.2.0`; it is not available on
crates.io yet, so pin the tag. The preview requires the repository's Rust 1.97.1 toolchain.

```rust
use std::sync::Arc;
use f2z_sdk::{Client, Config, Error, TokenStore};

pub fn client(client_id: &str, store: Arc<dyn TokenStore>) -> Result<Client, Error> {
    Client::new(Config::new(client_id), store)
}
```

Register a public OAuth client. The default scopes are `openid profile
offline_access balance:read purchase:create ai:invoke`. Read the granted scopes
after sign-in; requesting a scope does not prove the user granted it.

Supply a `TokenStore`. `MemoryStore` is explicit in-memory persistence.
The default `keyring` feature supplies `KeyringStore` over a caller-provided
`keyring_core::CredentialStore`; it does **not** install an OS backend or change
process-global keyring defaults. Select/test the platform backend in the host.
For Tauri, use the native plugin; bearer and refresh tokens must stay in Rust.

Desktop sign-in uses `oauth::LoopbackSession` and a real `UrlOpener` for the
system browser. Mobile hosts implement `oauth::AuthSession` with their platform
browser callback flow. See the integration guide's compiling helpers for login,
balances, purchases, streaming and receipt recovery.

## Lifetime and recovery

Keep a client on **one living Tokio runtime** and complete sign-out/cleanup
before shutting that runtime down. Token-store calls run in bounded independent
read and write lanes. A pending read does not occupy the write executor, but an
OS credential backend can serialize or block both calls. Storage timeouts mean
durability is unconfirmed; a blocking backend operation may finish later.

Refresh is single-flight and detached from the waiting API call. Same-token
recovery has a 30-second first-attempt ceiling and a 55-second total budget;
shorter configured request timeouts still apply. See `Config` and `Error`
rustdoc for cancellation and storage uncertainty.

Amounts are integer unit types: `proto::Milli2z` for balances, `proto::Whole2z`
for charges/holds/purchase quantities. Never round them through JavaScript
Number. Native DTOs should use decimal strings and JavaScript BigInt.

Persist an idempotency key and request before starting a chat or purchase.
`ChatOptions::with_idempotency_key` and
`PurchaseRequest::with_idempotency_key` retain caller ownership. For a UI that
owns retries, use `ChatOptions::with_max_retries(0)` so a definitive retryable
failure cannot generate a new billable key behind the UI's back. Same-key
receipt recovery is distinct from a new user-requested call.

Cancelling a stream stops delivery, not necessarily generation or charging.
`ai::Charge::Pending` is unknown, never zero. Retain the known call ID and
reconcile through `ai().call()`/`wait_for_call()`. A broken success response
keeps its operation key in the error. A browser checkout return does not prove
payment: poll the purchase and refresh the balance.

## Source verification

From the repository's `rs` directory:

```text
cargo +1.97.1 test --locked -p f2z-sdk --all-targets
cargo +1.97.1 test --locked -p f2z-sdk --doc
cargo +1.97.1 run --locked -p f2z-sdk --example full_flow
```

The full-flow example uses only local fakes and does not make a real purchase.
Repository-only fake examples/tests are excluded from the library tarball;
public rustdoc and this README accompany it. Packaging/consumer verification is
specified in the [release guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/RELEASING.md).

`client.grant().await?` reads the current bearer-bound original spending limit,
period, enforcement status and server revocation stamps. It requires `ai:invoke`
and returns `proto::grant::Grant`. This is a fresh snapshot, not a frozen budget:
cap changes need not increment server grant generation. Reject unenforced or
inappropriate policy before relying on it; never infer consent from an estimate's
remaining allowance. See [the grant contract](../../../docs/free2z/sdk/spec/grant.md).
