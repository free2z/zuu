//! The transport for the cross-app intent bridge (`#905`), which `#461` gated
//! and `#977` unblocked.
//!
//! ```text
//!   https://free2z.com/bridge/zuuli/#req=<hex>     (OS-resolved App Link)
//!     ▼
//!   inbound_request      host, path prefix and fragment, nothing else
//!     ▼
//!   receive_intent       every guard, the dialog, the wallet
//!     ▼
//!   IntentOutcome        answer + the registry's reply URL for that caller
//!     ▼
//!   https://free2z.com/bridge/e2e2z/#res=<hex>&rid=<hex>
//! ```
//!
//! # Why a verified App Link, and what it still does not buy
//!
//! `CALLER-AUTHENTICATION.md` §4 rests the response half on one property: only
//! the app whose package or team owns the association receives the link. Any
//! app can register `zuuli://`, so answering over a custom scheme would hand a
//! `DeviceCredential` to whoever registered it — `#367` at the OS layer.
//!
//! It buys nothing about the *sender*: neither platform attests a caller over
//! an App Link, so every request is `CallerTrust::Claimed` and the dialog says
//! "Identity: NOT CONFIRMED". The attested path is `startActivityForResult`
//! (§6), a different transport.
//!
//! # The payload is in the fragment
//!
//! §4.1 makes it a rule for this work: a link degrades to the web — stale
//! association, app absent, "open in Safari" — and a query component then
//! reaches server logs, history and `Referer`. Both directions use the
//! fragment; a request carries a handle and device keys, which deserve the
//! same treatment as the credential coming back.
//!
//! Hex rather than base64url because `hex` is already a dependency here and
//! base64 is not, and a new dependency in the app holding the seed costs more
//! than the 2x encoding does.
//!
//! # What is NOT here
//!
//! **No IPC surface.** Registered from `lib.rs`'s `setup`, never a
//! `#[tauri::command]`: a renderer that could hand the authority bytes is the
//! deputy `#367` is about. OAuth and checkout returns are received in
//! TypeScript because neither carries authority.
//!
//! **No interpretation.** The fragment is split, hex-decoded and handed on.
//! Re-parsing outside `admit` is the "four checks out of five" the gate exists
//! to prevent, so even the reply address is resolved there and returned here.
//!
//! **No answer to an unaddressable refusal.** A request `admit` rejects has no
//! correlator to echo and no registered caller to echo it to, so nothing is
//! sent at all.

use f2z_intent::CallerAttestation;
use tauri::{AppHandle, Runtime};
use tauri_plugin_deep_link::DeepLinkExt as _;
use tauri_plugin_opener::OpenerExt as _;
use url::Url;

use crate::intent::{self, IntentOutcome};

/// Not `free2z.cash`: that host permanently redirects, and neither platform
/// follows a redirect for an association document, so `#977` serves both
/// documents from here.
const ASSOCIATION_HOST: &str = "free2z.com";

/// This app's claimed prefix, from `tauri.conf.json`.
const INBOUND_PATH_PREFIX: &str = "/bridge/zuuli/";

const REQUEST_KEY: &str = "req";
const RESPONSE_KEY: &str = "res";
const CORRELATOR_KEY: &str = "rid";

/// Start listening for inbound intents.
///
/// Each delivery is spawned because the plugin's callback is synchronous and
/// [`intent::receive_intent`] is not. Concurrent deliveries are safe: the
/// gate's replay ledger is the one serialization point and holds its own lock.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            // OAuth and checkout returns reach their own TypeScript listener.
            let Some(request) = inbound_request(&url) else {
                continue;
            };
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                deliver(&app, request).await;
            });
        }
    });
}

/// The request bytes carried by `url`, if it is an inbound bridge link.
///
/// All four conditions are load-bearing: a custom scheme authenticates nobody,
/// the association is bound to one host, the prefix is what this app claimed,
/// and §4.1 forbids the query component.
fn inbound_request(url: &Url) -> Option<Vec<u8>> {
    if url.scheme() != "https" {
        return None;
    }
    if url.host_str() != Some(ASSOCIATION_HOST) {
        return None;
    }
    if !url.path().starts_with(INBOUND_PATH_PREFIX) {
        return None;
    }
    hex::decode(fragment_value(url.fragment()?, REQUEST_KEY)?).ok()
}

/// The value of `key` in a `a=1&b=2` fragment.
///
/// Not `Url::query_pairs`: that reads the query, which is where §4.1 says the
/// payload must never be.
fn fragment_value<'a>(fragment: &'a str, key: &str) -> Option<&'a str> {
    fragment.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
}

/// Answer one inbound request, and send the answer where the gate addressed it.
async fn deliver<R: Runtime>(app: &AppHandle<R>, request: Vec<u8>) {
    // `CallerAttestation::None`: an App Link carries no attestation on either
    // platform. `CALLER-AUTHENTICATION.md` §5 says so and
    // `ios_gets_a_registered_caller_but_never_an_attested_one` pins it — the
    // dialog tells the human "Identity: NOT CONFIRMED" rather than the wallet
    // pretending otherwise.
    match intent::receive_intent(app, &request, CallerAttestation::None).await {
        Ok(outcome) => send_answer(app, &outcome),
        Err(error) => {
            // Unaddressable by construction: nothing was parsed, so there is
            // no correlator to echo and no registered caller to echo it to.
            tracing::warn!("intent bridge refused a request it cannot answer: {error}");
        }
    }
}

/// Open the reply link carrying one answer.
fn send_answer<R: Runtime>(app: &AppHandle<R>, outcome: &IntentOutcome) {
    let url = reply_url(outcome);
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        // The caller is left waiting on a request that will expire on its own
        // deadline. That is the failure mode to prefer: every alternative
        // retries authority over a channel whose delivery already failed once.
        tracing::warn!("intent bridge could not deliver an answer: {error}");
    }
}

/// `<reply_to>#res=<hex>&rid=<hex>`.
///
/// Both values are hex of bytes the gate produced, so neither can carry a
/// fragment delimiter and neither needs escaping — a property this function
/// relies on and `a_reply_url_carries_only_hex_in_its_fragment` pins.
fn reply_url(outcome: &IntentOutcome) -> String {
    format!(
        "{}#{RESPONSE_KEY}={}&{CORRELATOR_KEY}={}",
        outcome.reply_to,
        hex::encode(&outcome.response),
        hex::encode(outcome.request_id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("a test URL must parse")
    }

    /// The positive control.
    #[test]
    fn an_inbound_bridge_link_yields_its_request_bytes() {
        assert_eq!(
            inbound_request(&url("https://free2z.com/bridge/zuuli/#req=0001020304")),
            Some(vec![0x00, 0x01, 0x02, 0x03, 0x04]),
        );
    }

    /// Each condition refused on its own; one catch-all would test one.
    #[test]
    fn only_a_verified_bridge_link_is_accepted() {
        for refused in [
            // Any app can register a custom scheme.
            "zuuli://bridge/zuuli/#req=00",
            "http://free2z.com/bridge/zuuli/#req=00",
            // A lookalike host owns no association of ours.
            "https://free2z.cash/bridge/zuuli/#req=00",
            "https://evil.example/bridge/zuuli/#req=00",
            // Another app's claimed prefix, and this app's own OAuth path.
            "https://free2z.com/bridge/e2e2z/#req=00",
            "https://free2z.com/oauth/callback#req=00",
            // §4.1: never the query component.
            "https://free2z.com/bridge/zuuli/?req=00",
            // Present but unusable.
            "https://free2z.com/bridge/zuuli/#req=nothex",
            "https://free2z.com/bridge/zuuli/#rid=00",
            "https://free2z.com/bridge/zuuli/",
        ] {
            assert_eq!(
                inbound_request(&url(refused)),
                None,
                "{refused} must not reach the intent authority",
            );
        }
    }

    #[test]
    fn a_fragment_value_is_read_by_name_and_not_by_position() {
        assert_eq!(fragment_value("res=ab&rid=cd", "rid"), Some("cd"));
        assert_eq!(fragment_value("rid=cd&res=ab", "rid"), Some("cd"));
        assert_eq!(fragment_value("res=ab", "rid"), None);
        assert_eq!(fragment_value("ridcd", "rid"), None);
        assert_eq!(
            fragment_value("rid=cd", "ri"),
            None,
            "a prefix of a key is not that key",
        );
    }

    #[test]
    fn a_reply_url_carries_only_hex_in_its_fragment() {
        let built = reply_url(&IntentOutcome {
            response: vec![0xDE, 0xAD],
            reply_to: "https://free2z.com/bridge/e2e2z/",
            request_id: [0x07; 32],
        });
        assert_eq!(
            built,
            format!(
                "https://free2z.com/bridge/e2e2z/#res=dead&rid={}",
                "07".repeat(32)
            ),
        );

        let parsed = url(&built);
        assert_eq!(parsed.scheme(), "https");
        assert_eq!(
            parsed.query(),
            None,
            "§4.1: a response payload must never reach the query component",
        );
        let fragment = parsed
            .fragment()
            .expect("the answer travels in the fragment");
        assert_eq!(fragment_value(fragment, RESPONSE_KEY), Some("dead"));
        assert_eq!(
            fragment_value(fragment, CORRELATOR_KEY),
            Some("07".repeat(32).as_str()),
        );
    }

    /// A transport that picked its own destination is the confused deputy.
    #[test]
    fn the_destination_comes_from_the_outcome_and_is_not_chosen_here() {
        let built = reply_url(&IntentOutcome {
            response: vec![0x01],
            reply_to: "https://free2z.com/bridge/free2z/",
            request_id: [0x00; 32],
        });
        assert!(
            built.starts_with("https://free2z.com/bridge/free2z/#"),
            "the answer must go where the registry said: {built}",
        );
    }

    /// Source-asserted, the way `intent.rs` pins its delegation order.
    #[test]
    fn the_transport_never_parses_what_it_carries() {
        let source = include_str!("bridge.rs");
        let production = source
            .split_once("\nmod tests {")
            .expect("this module must keep its tests in one place")
            .0;
        // Code only: the docs above name these to say they are not reached.
        let code = production
            .lines()
            .filter(|line| {
                let trimmed = line.trim_start();
                !trimmed.starts_with("//!") && !trimmed.starts_with("///")
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.contains("intent::receive_intent(app, &request, CallerAttestation::None)"),
            "the transport must hand the bytes on unread",
        );
        for forbidden in [
            "decode_request",
            "decode_canonical",
            "IntentGate",
            "claimed_caller",
        ] {
            assert!(
                !code.contains(forbidden),
                "{forbidden} would be a second reading of a request the gate already read",
            );
        }
    }
}
