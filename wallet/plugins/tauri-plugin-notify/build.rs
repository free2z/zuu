include!("command_registry.rs");
macro_rules! command_names { ($($command:ident),* $(,)?) => { &[$(stringify!($command)),*] }; }
fn main() {
    tauri_plugin::Builder::new(with_notify_commands!(command_names))
        .android_path("android")
        .ios_path("ios")
        .build();
    for key in [
        "F2Z_NOTIFY_ACCEPTANCE",
        "F2Z_NOTIFY_ORIGIN",
        "F2Z_NOTIFY_PUBLIC_KEY",
        "F2Z_NOTIFY_INVITATION",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
}
