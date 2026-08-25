include!("command_registry.rs");

macro_rules! command_names {
    ($($command:ident),* $(,)?) => {
        &[$(stringify!($command)),*]
    };
}

const COMMANDS: &[&str] = with_zcash_commands!(command_names);

fn main() {
    // CI changes this value for every attempt so a restored Cargo target cache
    // cannot skip permission and schema generation side effects.
    println!("cargo:rerun-if-env-changed=TAURI_PERMISSION_GENERATION_NONCE");
    println!(
        "cargo:rustc-env=ZCASH_BUILD_COMMANDS={}",
        COMMANDS.join(",")
    );
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
