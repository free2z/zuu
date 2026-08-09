#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_zcash::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// TEMPORARY — deliberate clippy violations, to prove the new gate can fail and
// not merely pass. Reverted in the very next commit on this branch.
// `clippy::useless_format` + `clippy::let_and_return`.
pub fn clippy_gate_smoke_test() -> String {
    let s = format!("{}", "the gate must be able to fail");
    s
}
