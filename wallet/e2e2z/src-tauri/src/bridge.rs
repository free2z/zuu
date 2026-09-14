//! The caller half of the intent bridge's transport: `#926` built everything
//! but the send, which needed the verified App Links `#977` landed.
//!
//! # Why the renderer does not open the link itself
//!
//! It cannot: `@tauri-apps/plugin-opener` is not a dependency here, and adding
//! it means granting `opener:*` in a capability file that
//! `surface-capability-authority.mjs` audits. An app-crate command needs no
//! capability, which is why the other three commands here are app-crate too.
//!
//! # A string is not a URL
//!
//! The renderer hands over hex and this module builds the URL. The hex is
//! validated first because a string carrying `&` or `#` would write extra
//! fragment parameters into a link the authority then parses.
//!
//! The payload travels in the fragment, per `CALLER-AUTHENTICATION.md` §4.1: a
//! link that degrades to the web puts a query component in server logs, and
//! the request carries a handle and this device's public keys.

use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_f2zmsg::error::Error;
use tauri_plugin_f2zmsg::Result;
use tauri_plugin_opener::OpenerExt as _;

/// From the authority's own `tauri.conf.json`. A constant and not an
/// argument: a caller that could name the authority could name an app it owns.
const AUTHORITY_BRIDGE_URL: &str = "https://free2z.com/bridge/zuuli/";

const REQUEST_KEY: &str = "req";

/// Hex characters. A real request is ~2 KB of hex; the bound exists so a
/// runaway payload fails here rather than silently in a platform's URL
/// handling.
const MAX_REQUEST_HEX: usize = 16_384;

/// What the renderer hands over to have it delivered.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchIntentArgs {
    /// The encoded `IntentRequestEnvelope`, lowercase hex.
    pub request: String,
}

/// Hand one request to the operating system, addressed to the authority's
/// verified App Link.
///
/// Resolving means the link was handed over, not that it was answered — the
/// answer arrives as a separate inbound link. A round-trip API here would be a
/// second place deciding what a valid answer is.
///
/// # Errors
///
/// [`Error::internal`] if the payload is not bounded lowercase hex of whole
/// bytes, or if the platform refused to open the link.
#[tauri::command]
pub async fn e2e2z_dispatch_intent<R: Runtime>(
    app: AppHandle<R>,
    args: DispatchIntentArgs,
) -> Result<()> {
    let request = request_hex(&args.request)?;
    app.opener()
        .open_url(
            format!("{AUTHORITY_BRIDGE_URL}#{REQUEST_KEY}={request}"),
            None::<&str>,
        )
        .map_err(|error| {
            Error::internal(format!(
                "the wallet authority link could not be opened: {error}"
            ))
        })
}

/// `value`, once it is provably safe to interpolate into a URL fragment.
fn request_hex(value: &str) -> Result<&str> {
    if value.is_empty() {
        return Err(Error::internal("an intent request cannot be empty"));
    }
    if value.len() > MAX_REQUEST_HEX {
        return Err(Error::internal(
            "the intent request is too long to dispatch",
        ));
    }
    if !value.len().is_multiple_of(2) {
        return Err(Error::internal(
            "the intent request is not whole bytes of hex",
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Error::internal("the intent request is not lowercase hex"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dispatchable_request_is_bounded_lowercase_hex() {
        assert_eq!(request_hex("00ff").ok(), Some("00ff"));
        assert_eq!(
            request_hex(&"ab".repeat(MAX_REQUEST_HEX / 2)).ok(),
            Some("ab".repeat(MAX_REQUEST_HEX / 2).as_str()),
            "the positive control: a bound that refused every real request would prove nothing",
        );
    }

    /// `&` and `#` are the ones that matter: either writes extra parameters
    /// into the link the authority parses.
    #[test]
    fn a_request_that_could_restructure_the_link_is_refused() {
        for refused in [
            "",
            "0",
            "00ff&rid=41414141",
            "00ff#res=41",
            "00FF",
            "00 ff",
            "00ffgg",
            "../../bridge/e2e2z/",
        ] {
            assert!(
                request_hex(refused).is_err(),
                "{refused:?} must never reach a URL",
            );
        }
        assert!(
            request_hex(&"ab".repeat(MAX_REQUEST_HEX)).is_err(),
            "an unbounded payload must fail here rather than in the platform",
        );
    }

    /// Source-pinned: an argument that named the authority would look
    /// ordinary in a diff.
    #[test]
    fn the_authority_is_a_constant_and_not_an_argument() {
        let source = include_str!("bridge.rs");
        let production = source
            .split_once("\nmod tests {")
            .expect("this module must keep its tests in one place")
            .0;
        assert!(
            production.contains(
                "const AUTHORITY_BRIDGE_URL: &str = \"https://free2z.com/bridge/zuuli/\""
            ),
            "the authority's link must stay a verified https constant",
        );
        let args = production
            .split_once("pub struct DispatchIntentArgs {")
            .expect("the argument struct must still exist")
            .1
            .split_once('}')
            .expect("the argument struct must close")
            .0;
        for forbidden in ["url", "authority", "host", "scheme"] {
            assert!(
                !args.to_lowercase().contains(forbidden),
                "the renderer must not be able to name a destination ({forbidden})",
            );
        }
    }
}
