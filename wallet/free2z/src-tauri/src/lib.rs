//! free2z — the content surface of the three-app split (#904).
//!
//! This process renders third-party content: article embeds, remote images,
//! livestream SDKs, AI output. It therefore registers **no privileged plugin**
//! and **no command of its own**, so there is nothing for a hostile subframe to
//! reach even under the Wry frame-confusion defect (#367): every privileged
//! operation is a scoped, revocable, native-confirmed grant issued by the
//! wallet authority over the cross-surface bridge (#905), never a command in
//! this invoke handler.
//!
//! There is still no `invoke_handler` here, and #918 deliberately did not add
//! one. The ten `oauth_*` commands ZUULI carries were NOT ported: they hand an
//! OAuth authorization code and its PKCE verifier back to the renderer, which
//! is a sign-in credential, and #367 means the frame asking might not be ours.
//! The frontend's native OAuth transport was deleted instead — see
//! `../../src/lib/oauth/transport.ts`.
//!
//! What #918 did add is `tauri-plugin-http`. It registers `plugin:http|fetch`
//! rather than an app command, holds no local authority, and reaches only the
//! URL scope named in `../capabilities/*.json`.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
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

    /// The native HTTP client must stay stateless. `cookies` is in the plugin's
    /// DEFAULT feature set, so re-enabling it is a one-word edit — and it would
    /// install a process-wide cookie jar that every request rides, turning a
    /// scoped network client into an ambient-authority one (#918).
    #[test]
    fn the_native_http_client_carries_no_cookie_jar() {
        let manifest = include_str!("../Cargo.toml");
        let entry = manifest
            .split("\ntauri-plugin-http = ")
            .nth(1)
            .and_then(|rest| rest.split("] }").next())
            .expect("the tauri-plugin-http dependency entry");
        assert!(
            entry.contains("default-features = false"),
            "tauri-plugin-http must opt out of its default features; `cookies` is one of them"
        );
        assert!(
            !entry.contains("\"cookies\""),
            "free2z's HTTP client must carry no cookie jar: it authenticates with a header"
        );
    }

    /// The whole security property of this surface is that there is no command
    /// to reach. `invoke_handler` is the only way one could appear, and it is
    /// one line, so the source is asserted rather than the doc comment.
    #[test]
    fn no_invoke_handler_is_registered() {
        let source = include_str!("lib.rs");
        let builder = source
            .split("pub fn run() {")
            .nth(1)
            .and_then(|rest| rest.split("\n}").next())
            .expect("the run() body");
        assert!(
            !builder.contains("invoke_handler"),
            "free2z must register no command: #367 means a remote subframe could call it"
        );
    }
}
