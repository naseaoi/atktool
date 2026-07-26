mod battery_service;
mod commands;
mod device;
mod hub;
mod hub_permissions;
mod models;
mod protocol;
mod state;
mod system_tray;
mod tray_text;
mod window_manager;
mod windows_integration;

use battery_service::BatteryService;
use state::{load_preferences, AppState};
use tauri::Manager;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = window_manager::show_overlay(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            let _ = hub_permissions::import_edge_hid_grants(app.handle());
            let mut preferences = load_preferences(app.handle());
            let autostart_result = if preferences.open_at_login {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
            if autostart_result.is_ok() {
                preferences.open_at_login = app
                    .autolaunch()
                    .is_enabled()
                    .unwrap_or(preferences.open_at_login);
            }
            let binding = preferences.preferred_hid_device.clone();
            let visible = preferences.overlay_visible;
            app.manage(AppState::new(preferences.clone()));
            let _ = state::save_preferences(app.handle(), &preferences);
            app.manage(BatteryService::start(
                app.handle().clone(),
                binding,
                visible,
            ));
            app.manage(windows_integration::WindowsIntegration::start(
                app.handle().clone(),
            )?);

            system_tray::create(app.handle())?;
            if preferences.overlay_visible {
                window_manager::show_overlay(app.handle())?;
            }
            let _ = hub::restore(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_preferences,
            commands::get_overlay_state,
            commands::set_open_at_login,
            commands::set_overlay_variant,
            commands::toggle_pin,
            commands::toggle_variant,
            commands::request_refresh,
            commands::fit_manager_height,
            commands::fit_overlay_height,
            commands::hide_overlay,
            commands::activate_stable_source,
            commands::begin_hid_selection,
            commands::pick_hid_device,
            commands::cancel_hid_selection,
            commands::clear_device_binding,
            commands::open_fallback,
            hub::update_fallback_state,
        ])
        .build(tauri::generate_context!())
        .expect("Tauri runtime failed");

    app.run(|app, event| match event {
        tauri::RunEvent::Resumed => {
            let _ = commands::refresh_active_source(app);
        }
        tauri::RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        _ => {}
    });
}
