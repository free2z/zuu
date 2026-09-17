include!("command_registry.rs");

macro_rules! command_names {
    ($($command:ident),* $(,)?) => {
        &[$(stringify!($command)),*]
    };
}

const COMMANDS: &[&str] = with_f2zmsg_commands!(command_names);

// ADR 0017 §3: `internal-directory.conf` is checked here, at compile time, by
// the same grammar the plugin runs (`src/internal_directory/syntax.rs`). A
// malformed file — half-filled, a `#` inside a value, a confusable character
// in a URL, a cooldown under the floor, a `log_id` from another log — stops
// every crate that links this plugin from building, rather than shipping a
// binary that logs an error and quietly stays on `NoDirectory`.
#[path = "src/internal_directory/log_id.rs"]
mod directory_log_id;
#[path = "src/internal_directory/syntax.rs"]
mod directory_syntax;

fn check_internal_directory() {
    println!("cargo:rerun-if-changed=internal-directory.conf");
    println!("cargo:rerun-if-changed=src/internal_directory/syntax.rs");
    println!("cargo:rerun-if-changed=src/internal_directory/log_id.rs");
    let text = match std::fs::read_to_string("internal-directory.conf") {
        Ok(text) => text,
        Err(error) => {
            println!("cargo::error=internal-directory.conf could not be read: {error}");
            std::process::exit(1);
        }
    };
    if let Err(reason) = directory_syntax::parse(&text, &directory_log_id::log_id) {
        println!("cargo::error=internal-directory.conf is malformed (ADR 0017 §3): {reason}");
        std::process::exit(1);
    }
}

fn main() {
    check_internal_directory();
    // CI changes this value for every attempt so a restored Cargo target cache
    // cannot skip permission and schema generation side effects.
    println!("cargo:rerun-if-env-changed=TAURI_PERMISSION_GENERATION_NONCE");
    println!(
        "cargo:rustc-env=F2ZMSG_BUILD_COMMANDS={}",
        COMMANDS.join(",")
    );
    // The mobile halves of device wrap-key custody (#937). These carry no
    // webview-invokable command and therefore no permission: `run_mobile_plugin`
    // reaches them from Rust, not from the frontend, so nothing in `COMMANDS`
    // describes them and nothing in a capability file authorizes them.
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
