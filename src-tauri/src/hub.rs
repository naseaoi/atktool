use chrono::Utc;
use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::{
    battery_service::BatteryService,
    commands::{emit_overlay, emit_preferences},
    models::OverlayState,
    state::{save_preferences, AppState},
    system_tray,
};

const HUB_URL: &str = "https://hub.atk.pro/";
const HUB_SCRIPT: &str = include_str!("../scripts/hub-observer.js");

fn navigation_allowed(url: &tauri::Url) -> bool {
    url.as_str() == "about:blank"
        || (url.scheme() == "https" && url.host_str() == Some("hub.atk.pro"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubPayload {
    status: String,
    message: String,
    battery_percent: Option<f64>,
    device_name: String,
    charge_status: String,
    granted_devices_count: usize,
}

fn clean_text(value: &str, maximum: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() && *character != '\u{fffd}')
        .take(maximum)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn resume_native(app: &AppHandle) {
    let _ = app.state::<BatteryService>().set_suspended(false);
    let _ = app.state::<BatteryService>().refresh(true);
}

fn emit_loading(app: &AppHandle) -> Result<(), String> {
    let preferences = app.state::<AppState>().preferences();
    let overlay = OverlayState {
        status: "loading".to_owned(),
        message: "同步官网电量页加载中...".to_owned(),
        battery_percent: None,
        battery_text: "--".to_owned(),
        device_name: preferences.display_device_name,
        charging: false,
        charge_status: "idle".to_owned(),
        needs_user_action: true,
        sampled_at: Some(Utc::now().to_rfc3339()),
        protocol_name: "官网同步电量".to_owned(),
        mode: "fallback".to_owned(),
        always_on_top: preferences.always_on_top,
        overlay_variant: preferences.overlay_variant,
        granted_devices_count: 0,
    };
    app.state::<AppState>().replace_overlay(overlay.clone());
    emit_overlay(app, &overlay)
}

fn create_window(app: &AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    let url = HUB_URL
        .parse()
        .map_err(|error| format!("Hub URL 无效：{error}"))?;
    let window = WebviewWindowBuilder::new(app, "hub", WebviewUrl::External(url))
        .title("ATK HUB 同步官网电量")
        .inner_size(1280.0, 860.0)
        .resizable(true)
        .visible(visible)
        .skip_taskbar(!visible)
        .initialization_script(HUB_SCRIPT)
        .on_navigation(navigation_allowed)
        .build()
        .map_err(|error| error.to_string())?;
    let app_handle = app.clone();
    let tracked_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = tracked_window.hide();
            let _ = tracked_window.set_skip_taskbar(true);
        }
        WindowEvent::Destroyed if !app_handle.state::<AppState>().hub_sync() => {
            resume_native(&app_handle);
        }
        _ => {}
    });
    Ok(window)
}

fn enable(app: &AppHandle) -> Result<(), String> {
    app.state::<BatteryService>().set_suspended(true)?;
    let preferences = app.state::<AppState>().set_hub_sync(true);
    save_preferences(app, &preferences)?;
    emit_preferences(app, &preferences)
}

pub fn activate_stable(app: &AppHandle) -> Result<(), String> {
    if !app.state::<AppState>().hub_sync() {
        return Ok(());
    }
    let preferences = app.state::<AppState>().set_hub_sync(false);
    save_preferences(app, &preferences)?;
    emit_preferences(app, &preferences)?;
    if let Some(window) = app.get_webview_window("hub") {
        window.destroy().map_err(|error| error.to_string())?;
    }
    resume_native(app);
    Ok(())
}

pub fn open(app: &AppHandle) -> Result<(), String> {
    enable(app)?;
    let window = match app.get_webview_window("hub") {
        Some(window) => window,
        None => {
            emit_loading(app)?;
            create_window(app, true)?
        }
    };
    window
        .set_skip_taskbar(false)
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub fn restore(app: &AppHandle) -> Result<(), String> {
    if !app.state::<AppState>().hub_sync() {
        return Ok(());
    }
    app.state::<BatteryService>().set_suspended(true)?;
    emit_loading(app)?;
    create_window(app, false)?;
    Ok(())
}

pub fn reload(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("hub") else {
        return restore(app);
    };
    window
        .eval("location.reload()")
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::navigation_allowed;

    #[test]
    fn allows_webview_bootstrap_and_hub_navigation() {
        assert!(navigation_allowed(&"about:blank".parse().unwrap()));
        assert!(navigation_allowed(&"https://hub.atk.pro/".parse().unwrap()));
        assert!(!navigation_allowed(
            &"https://example.com/".parse().unwrap()
        ));
        assert!(!navigation_allowed(&"http://hub.atk.pro/".parse().unwrap()));
    }
}

#[tauri::command]
pub fn update_fallback_state(
    app: AppHandle,
    window: WebviewWindow,
    payload: HubPayload,
) -> Result<(), String> {
    if !app.state::<AppState>().hub_sync()
        || window.label() != "hub"
        || window.url().map_err(|error| error.to_string())?.host_str() != Some("hub.atk.pro")
    {
        return Err("已拒绝非 Hub 窗口的状态回传".to_owned());
    }
    let percent = payload
        .battery_percent
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 100.0)
        .map(|value| value.round() as u8);
    let mut status = match payload.status.as_str() {
        "loading" | "waiting" | "connected" | "error" => payload.status,
        _ => "waiting".to_owned(),
    };
    if status == "connected" && percent.is_none() {
        status = "waiting".to_owned();
    }
    let mut charge_status = match payload.charge_status.as_str() {
        "charging" | "full" => payload.charge_status,
        _ => "idle".to_owned(),
    };
    if charge_status == "full" && percent != Some(100) {
        charge_status = "idle".to_owned();
    }
    let preferences = app.state::<AppState>().preferences();
    let overlay = OverlayState {
        status: status.clone(),
        message: clean_text(&payload.message, 240),
        battery_percent: percent,
        battery_text: percent
            .map(|value| format!("{value}%"))
            .unwrap_or_else(|| "--".to_owned()),
        device_name: clean_text(&payload.device_name, 80),
        charging: charge_status == "charging",
        charge_status,
        needs_user_action: status != "connected",
        sampled_at: Some(Utc::now().to_rfc3339()),
        protocol_name: "官网同步电量".to_owned(),
        mode: "fallback".to_owned(),
        always_on_top: preferences.always_on_top,
        overlay_variant: preferences.overlay_variant,
        granted_devices_count: payload.granted_devices_count.min(32),
    };
    app.state::<AppState>().replace_overlay(overlay.clone());
    emit_overlay(&app, &overlay)?;
    system_tray::update(&app)
}
