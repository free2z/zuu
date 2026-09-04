//! free2z — the content surface of the three-app split (#904).
//!
//! This process renders third-party content: article embeds, remote images,
//! livestream SDKs, AI output. It therefore registers **no privileged plugin**
//! and **no command of its own**, so there is nothing for a hostile subframe to
//! reach even under the Wry frame-confusion defect (#367): every privileged
//! operation is a scoped, revocable, native-confirmed grant issued by the
//! wallet authority over the cross-surface bridge (#905), never a command in
//! this invoke handler.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// The content surface must never gain a privileged plugin. A dependency is
    /// the only way one could arrive, and the manifest is the reviewable record
    /// of that, so this asserts against the manifest rather than a symbol.
    #[test]
    fn manifest_links_no_privileged_plugin() {
        let manifest = include_str!("../Cargo.toml");
        for forbidden in ["tauri-plugin-zcash", "tauri-plugin-f2zmsg"] {
            assert!(
                !manifest.contains(&format!("\n{forbidden} =")),
                "free2z must not link {forbidden}: it renders third-party content"
            );
        }
    }
}
