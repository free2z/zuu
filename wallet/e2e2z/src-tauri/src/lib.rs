//! e2e2z — the messaging surface of the three-app split (#904).
//!
//! This process holds device keys and a device credential, never the Zcash
//! seed, and never renders remote content. It registers `tauri-plugin-f2zmsg`
//! and nothing else privileged.
//!
//! The app-crate enrollment trio ZUULI carries — `f2zmsg_enrollment_status`,
//! `f2zmsg_enroll`, `f2zmsg_unenroll` — is deliberately absent. In ZUULI those
//! commands borrow the wallet seed from `tauri-plugin-zcash`'s managed state
//! in-process (docs/e2ee/CLIENT-CONTRACT.md §2.2). Here there is no seed to
//! borrow: enrollment becomes a bridge call into the wallet authority, which
//! issues the `DeviceCredential` (#905). Until that protocol lands there is no
//! honest in-process implementation, so there is no command and no capability
//! entry addressing one.
//!
//! What this crate *does* register is [`device::e2e2z_device_credential_keys`]:
//! the **public** halves of this device's OS-CSPRNG key set, which are what an
//! `issue-device-credential` request carries. It grants nothing, reveals no
//! secret, and is the one piece of enrollment that does not need the seed. See
//! that module for why it is here rather than in the plugin or in the renderer.

pub mod device;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_f2zmsg::init())
        .invoke_handler(tauri::generate_handler![
            device::e2e2z_device_credential_keys
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// The messaging surface must never gain seed authority. A dependency is
    /// the only way one could arrive, and the manifest is the reviewable record
    /// of that, so this asserts against the manifest rather than a symbol.
    #[test]
    fn manifest_links_no_wallet_plugin() {
        let manifest = include_str!("../Cargo.toml");
        assert!(
            !manifest.contains("\ntauri-plugin-zcash ="),
            "e2e2z must not link tauri-plugin-zcash: ongoing messaging never needs the seed"
        );
    }

    /// The enrollment trio must stay absent from this crate's IPC surface.
    ///
    /// `e2e2z_device_credential_keys` is deliberately *not* one of them: it
    /// returns public keys and cannot enroll anything. If a command whose name
    /// starts `f2zmsg_` ever appears here, this app has grown the very surface
    /// #904 split away, so the source is asserted rather than the doc comment.
    #[test]
    fn no_enrollment_command_is_registered() {
        let source = include_str!("lib.rs");
        let handler = source
            .split("invoke_handler(tauri::generate_handler![")
            .nth(1)
            .and_then(|rest| rest.split("])").next())
            .expect("the invoke_handler list");
        assert!(
            !handler.contains("f2zmsg_"),
            "e2e2z must register no f2zmsg_* app-crate command: enrollment needs the seed"
        );
        assert!(handler.contains("e2e2z_device_credential_keys"));
    }
}
