include!("command_registry.rs");
macro_rules! command_names { ($($name:ident),* $(,)?) => { &[$(stringify!($name)),*] }; }
fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_PERMISSION_GENERATION_NONCE");
    tauri_plugin::Builder::new(with_commands!(command_names))
        .android_path("android")
        .ios_path("ios")
        .build();
}
