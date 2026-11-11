use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootConfig {
    base_url: String,
    token: String,
}

fn boot_config() -> BootConfig {
    let base_url = std::env::var("HOMEBASE_PRESENCE_BASE")
        .or_else(|_| std::env::var("HOMEBASE_URL"))
        .unwrap_or_else(|_| "http://127.0.0.1:8080".into())
        .trim_end_matches('/')
        .to_string();
    let token = std::env::var("HOMEBASE_PRESENCE_TOKEN").unwrap_or_default();
    BootConfig { base_url, token }
}

#[tauri::command]
fn get_boot_config() -> BootConfig {
    boot_config()
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.unminimize();
    }
}

/// Native HTTP — WebKitGTK often fails browser fetch to localhost ("Load failed").
#[tauri::command]
fn presence_snapshot() -> Result<serde_json::Value, String> {
    let boot = boot_config();
    if boot.token.is_empty() {
        return Err("Missing presence token".into());
    }
    let url = format!(
        "{}/api/presence/ui?k={}",
        boot.base_url,
        urlencoding::encode(&boot.token)
    );
    let body = ureq::get(&url)
        .call()
        .map_err(|e| format!("Home Base unreachable ({e})"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| format!("Bad response: {e}"))
}

#[tauri::command]
fn presence_chat_send(text: String) -> Result<serde_json::Value, String> {
    let boot = boot_config();
    if boot.token.is_empty() {
        return Err("Missing presence token".into());
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Empty message".into());
    }
    let url = format!(
        "{}/api/presence/ui/chat?k={}",
        boot.base_url,
        urlencoding::encode(&boot.token)
    );
    let body = ureq::post(&url)
        .set("Content-Type", "application/json")
        .send_json(serde_json::json!({ "text": trimmed }))
        .map_err(|e| format!("Chat failed ({e})"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| format!("Bad response: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_boot_config,
            show_window,
            presence_snapshot,
            presence_chat_send
        ])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                // Normal stacking — do not force above every other window.
                let _ = w.set_always_on_top(false);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Home Base Presence");
}
