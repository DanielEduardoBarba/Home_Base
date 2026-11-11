use serde::Serialize;
use tauri::Manager;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootConfig {
    base_url: String,
    token: String,
}

#[tauri::command]
fn get_boot_config() -> BootConfig {
    let base_url = std::env::var("HOMEBASE_PRESENCE_BASE")
        .or_else(|_| std::env::var("HOMEBASE_URL"))
        .unwrap_or_else(|_| "http://127.0.0.1:8080".into())
        .trim_end_matches('/')
        .to_string();
    let token = std::env::var("HOMEBASE_PRESENCE_TOKEN").unwrap_or_default();
    BootConfig { base_url, token }
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.unminimize();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_boot_config, show_window])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Home Base Presence");
}
