//! The whole SDK flow — sign in over a loopback redirect, read the balance,
//! show where the user gets 2Z, stream a chat, sign out — against local fakes
//! of the issuer, the account API and the gateway (the same ones the tests
//! use).
//!
//! The app never sells 2Z: it links the user's Free2Z billing page, or only
//! "Manage Free2Z account" in a store build (`docs/free2z/sdk/STORE-COMPLIANCE.md`).
//!
//! ```text
//! cargo run -p f2z-sdk --example full_flow
//! ```
//!
//! Against production, the only change is the configuration:
//! `Config::new("<your client_id>")`, a real `UrlOpener` for the system
//! browser, and a keychain-backed `TokenStore`.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

#[path = "../tests/support/mod.rs"]
mod support;

use std::sync::Arc;

use f2z_sdk::ai::Charge;
use f2z_sdk::oauth::LoopbackSession;
use f2z_sdk::proto::Event;
use f2z_sdk::{Client, MemoryStore, SignInOptions};

/// Google Play, or the App Store outside the US storefront: no payment links
/// in this build. Decide it per build.
const STORE_BUILD: bool = false;

#[tokio::main]
async fn main() -> Result<(), f2z_sdk::Error> {
    let fake = support::Fake::start().await;
    let client = Client::new(fake.config(), Arc::new(MemoryStore::new()))?;

    // 1. Sign in. On desktop: a loopback listener plus the system browser;
    //    here the "browser" is a script that follows the IdP's redirect.
    let session = LoopbackSession::bind(support::loopback_browser()).await?;
    let signed_in = client.sign_in(&session, SignInOptions::default()).await?;
    println!(
        "signed in as {} with scopes [{}] (refresh token kept: {:?})",
        signed_in.subject.as_deref().unwrap_or("?"),
        signed_in.scopes.join(" "),
        signed_in.persistence,
    );

    // 2. The balance.
    let balance = client.balance().await?;
    println!("balance: {} available", balance.available_milli_2z);

    // 3. Where the user gets more 2Z. Apps don't sell 2Z: a web,
    //    direct-download desktop or US-storefront build links the Free2Z
    //    billing page (Zcash first, card second) in the system browser; a
    //    store build shows only "Manage Free2Z account". No return redirect:
    //    re-read the balance when the app comes back to the foreground.
    if STORE_BUILD {
        println!("Manage Free2Z account: {}", client.manage_account_url());
    } else {
        println!("Get 2Z on Free2Z: open {}", client.billing_url());
    }

    // 4. Stream a chat, reading the charge with outcome().
    let mut stream = client.ai().chat(support::chat_request("settled")).await?;
    while let Some(event) = stream.next().await? {
        match event {
            Event::Meta(m) => println!("call {} on {} (hold {})", m.call_id, m.model, m.hold_2z),
            Event::Delta(d) => println!("  > {}", d.text),
            Event::Done(done) => match Charge::from(done.outcome()) {
                Charge::Charged { charged_2z, .. } => println!("charged {charged_2z}"),
                Charge::NothingCharged => println!("nothing charged"),
                other => println!("settling: {other:?}"),
            },
            Event::Error(e) => println!("failed: {} (retryable: {})", e.code, e.retryable()),
            _ => {}
        }
    }

    // 5. Sign out: revoke the refresh token's family, clear the store.
    let revoked = client.sign_out().await?;
    println!("signed out (revoked at the IdP: {revoked})");
    Ok(())
}
