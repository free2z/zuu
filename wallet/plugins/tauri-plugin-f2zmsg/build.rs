include!("command_registry.rs");

macro_rules! command_names {
    ($($command:ident),* $(,)?) => {
        &[$(stringify!($command)),*]
    };
}

const COMMANDS: &[&str] = with_f2zmsg_commands!(command_names);

fn main() {
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
