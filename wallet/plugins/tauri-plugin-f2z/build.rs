include!("command_registry.rs");
macro_rules! names { ($($name:ident),* $(,)?) => { &[$(stringify!($name)),*] }; }
fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_PERMISSION_GENERATION_NONCE");
    tauri_plugin::Builder::new(with_commands!(names))
        .android_path("android")
        .ios_path("ios")
        .build();
}
