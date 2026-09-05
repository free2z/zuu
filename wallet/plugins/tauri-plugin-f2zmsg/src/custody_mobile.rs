//! The iOS and Android halves of [`crate::custody`].
//!
//! `keyring` has no mobile backend, and even where it does the policy would be
//! wrong: the accessibility class and the keystore parameters are the *whole*
//! decision here (see [`crate::custody`] §2), and a crate that picks defaults
//! for us cannot express "readable while the screen is locked, never
//! synchronized, never behind a biometric prompt". So mobile custody is a Tauri
//! mobile plugin — `ios/Sources/F2zMsgPlugin.swift` and
//! `android/src/main/java/F2zMsgPlugin.kt` — and this module is the Rust side
//! of that bridge.
//!
//! The service name travels on every call rather than being baked into the
//! native side, for the same reason it is a host-supplied constant at all: one
//! plugin binary serves two applications, and only the host knows which one it
//! is (`crate::custody` §1).
//!
//! # What is not tested here
//!
//! This module is `#[cfg(mobile)]`, so nothing in it compiles or runs in the
//! desktop CI lane, and neither does the Swift or the Kotlin. The parts that
//! *can* be judged without a handset — the namespace rule, the probe, the
//! fail-closed refusal — deliberately live in [`crate::custody`] and in
//! `tests/enrollment_refuses_without_custody.rs` instead. The accessibility
//! class and the keystore backing are claims about a real device and are marked
//! as such in the pull request rather than asserted by a test that could not
//! observe them.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::plugin::{PluginApi, PluginHandle, mobile::PluginInvokeError};
use tauri::{AppHandle, Runtime};
use zeroize::Zeroizing;

use crate::custody::{CustodyError, WrapKeyCustody, WrapKeyNamespace, WrapKeyStore};

/// The Android plugin class, by the identifier its `AndroidManifest` declares.
///
/// Not `cash.free2z.zuuli.*`: this plugin is linked into e2e2z too, and a class
/// namespaced to one app inside a library both apps embed would be a lie in the
/// stack trace of the other.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "cash.free2z.f2zmsg";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_f2zmsg);

/// Register the native plugin and build custody over it.
///
/// # Errors
///
/// Never — a failure to reach the native plugin becomes
/// [`WrapKeyCustody::unavailable`], because `lib.rs`'s `setup` hook must not
/// return `Err` (#753) and because "there is no store" is a state this design
/// already has an answer for: refuse to enroll.
pub fn custody<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
    namespace: WrapKeyNamespace,
) -> WrapKeyCustody {
    #[cfg(target_os = "android")]
    let registered = api.register_android_plugin(PLUGIN_IDENTIFIER, "F2zMsgPlugin");
    #[cfg(target_os = "ios")]
    let registered = api.register_ios_plugin(init_plugin_f2zmsg);

    let handle = match registered {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!(%error, "the native device-custody plugin did not register");
            return WrapKeyCustody::unavailable(format!(
                "the native device-custody plugin did not register: {error}"
            ));
        }
    };

    // Report the backing once, at setup. It changes nothing — a software-backed
    // keystore is still accepted (`crate::custody` §2) — but "hardware-backed"
    // is a claim about a specific handset that this process cannot verify from
    // the outside, so it is logged where a support report can read it rather
    // than assumed anywhere.
    match handle.run_mobile_plugin::<CustodyBacking>(
        "custodyBacking",
        ServiceArgs {
            service: namespace.as_str(),
        },
    ) {
        Ok(backing) => tracing::info!(
            backing = %backing.backing,
            namespace = namespace.as_str(),
            "device wrap-key custody"
        ),
        Err(error) => tracing::warn!(%error, "device wrap-key custody backing is unknown"),
    }

    WrapKeyCustody::with_store(
        namespace.clone(),
        Arc::new(MobileWrapKeyStore {
            handle,
            service: namespace.as_str().to_owned(),
        }),
    )
}

struct MobileWrapKeyStore<R: Runtime> {
    handle: PluginHandle<R>,
    service: String,
}

impl<R: Runtime> WrapKeyStore for MobileWrapKeyStore<R> {
    fn put(&self, account: &str, value: &str) -> Result<(), CustodyError> {
        self.handle
            .run_mobile_plugin::<()>(
                "storeWrapKey",
                StoreArgs {
                    service: &self.service,
                    account,
                    value,
                },
            )
            .map_err(map_invoke_error)
    }

    fn get(&self, account: &str) -> Result<Zeroizing<String>, CustodyError> {
        self.handle
            .run_mobile_plugin::<WrapKeyValue>(
                "getWrapKey",
                AccountArgs {
                    service: &self.service,
                    account,
                },
            )
            .map(|held| Zeroizing::new(held.value))
            .map_err(map_invoke_error)
    }

    fn delete(&self, account: &str) -> Result<(), CustodyError> {
        self.handle
            .run_mobile_plugin::<()>(
                "deleteWrapKey",
                AccountArgs {
                    service: &self.service,
                    account,
                },
            )
            .map_err(map_invoke_error)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceArgs<'a> {
    service: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountArgs<'a> {
    service: &'a str,
    account: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreArgs<'a> {
    service: &'a str,
    account: &'a str,
    value: &'a str,
}

#[derive(Deserialize)]
struct WrapKeyValue {
    value: String,
}

#[derive(Deserialize)]
struct CustodyBacking {
    /// `strongbox`, `hardware`, `software` on Android; `keychain` on iOS.
    /// Free-form on purpose: it is a log line, not a branch.
    backing: String,
}

/// The native rejection codes, classified.
///
/// The same code vocabulary `tauri-plugin-zcash`'s `map_mobile_error` uses, so
/// the two native plugins reject in one language even though they hold
/// different secrets under different policies. `auth_cancelled` and
/// `auth_failed` are deliberately absent from the native side here — nothing in
/// this custody path prompts — and if one ever arrives it is a native plugin
/// that grew a prompt it must not have, so it is classified as a backend fault
/// rather than quietly retried.
fn map_invoke_error(error: PluginInvokeError) -> CustodyError {
    match error {
        PluginInvokeError::InvokeRejected(response) => match response.code.as_deref() {
            Some("not_found") => CustodyError::NotFound,
            Some("locked") => CustodyError::Locked,
            Some("corrupt") => CustodyError::Corrupt,
            Some("unavailable") => CustodyError::Unavailable,
            _ => CustodyError::Backend(
                response
                    .message
                    .unwrap_or_else(|| "the native custody plugin rejected the request".into()),
            ),
        },
        PluginInvokeError::CannotDeserializeResponse(_) => CustodyError::Corrupt,
        PluginInvokeError::UnreachableWebview => CustodyError::Unavailable,
        #[cfg(target_os = "android")]
        PluginInvokeError::Jni(_) => CustodyError::Unavailable,
        other => CustodyError::Backend(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::plugin::mobile::ErrorResponse;

    fn rejected(code: &str) -> PluginInvokeError {
        PluginInvokeError::InvokeRejected(ErrorResponse {
            code: Some(code.into()),
            message: None,
            data: (),
        })
    }

    #[test]
    fn native_rejection_codes_remain_distinct() {
        assert_eq!(
            map_invoke_error(rejected("not_found")),
            CustodyError::NotFound
        );
        assert_eq!(map_invoke_error(rejected("locked")), CustodyError::Locked);
        assert_eq!(map_invoke_error(rejected("corrupt")), CustodyError::Corrupt);
        assert_eq!(
            map_invoke_error(rejected("unavailable")),
            CustodyError::Unavailable
        );
        // An unrecognized code must not collapse into one of the meanings
        // above — in particular not into `NotFound`, which is the one code
        // that reads as "this device is simply not enrolled yet".
        assert!(matches!(
            map_invoke_error(rejected("auth_cancelled")),
            CustodyError::Backend(_)
        ));
    }
}
