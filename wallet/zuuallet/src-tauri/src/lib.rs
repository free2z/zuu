#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // The shared wallet engine owns the native payment prompt; renderer
        // capabilities do not receive direct dialog authority.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_zcash::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
