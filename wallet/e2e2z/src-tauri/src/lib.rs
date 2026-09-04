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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_f2zmsg::init())
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
}
