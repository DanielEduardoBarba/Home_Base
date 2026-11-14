use serde::{Deserialize, Serialize};
use std::thread;
use std::time::Duration;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootConfig {
    base_url: String,
    token: String,
}

fn env_first(keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Ok(v) = std::env::var(k) {
            let t = v.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

fn boot_config() -> BootConfig {
    let base_url = env_first(&[
        "HOMEBASE_VISITOR_BASE",
        "HOMEBASE_PRESENCE_BASE",
        "HOMEBASE_URL",
    ])
    .unwrap_or_else(|| "http://127.0.0.1:8080".into())
    .trim_end_matches('/')
    .to_string();
    let token = env_first(&["HOMEBASE_VISITOR_TOKEN", "HOMEBASE_PRESENCE_TOKEN"])
        .unwrap_or_default();
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

/// Exit the process so Home Base can respawn a healthy window next time.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Native HTTP — WebKitGTK often fails browser fetch to localhost ("Load failed").
#[tauri::command]
fn presence_snapshot() -> Result<serde_json::Value, String> {
    let boot = boot_config();
    if boot.token.is_empty() {
        return Err("Missing visitor token".into());
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
        return Err("Missing visitor token".into());
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

fn focus_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_ignore_cursor_events(false);
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.unminimize();
        let _ = w.set_always_on_top(false);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_boot_config,
            show_window,
            quit_app,
            presence_snapshot,
            presence_chat_send
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            focus_main(&handle);
            // Wayland/WebKitGTK: first map often paints but ignores input until a deferred re-focus.
            thread::spawn(move || {
                for ms in [80u64, 250, 600, 1200] {
                    thread::sleep(Duration::from_millis(ms));
                    focus_main(&handle);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Home Visitor");
}
