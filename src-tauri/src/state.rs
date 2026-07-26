use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use tauri::{AppHandle, Manager};

use crate::models::{
    ChooserDevice, DeviceBinding, OverlayState, Preferences, WindowBounds, WindowPosition,
};

const SETTINGS_FILE: &str = "settings.json";

struct RuntimeState {
    preferences: Preferences,
    overlay: OverlayState,
    chooser_devices: Vec<ChooserDevice>,
}

pub struct AppState {
    inner: Mutex<RuntimeState>,
}

impl AppState {
    pub fn new(preferences: Preferences) -> Self {
        let overlay = OverlayState::from_preferences(&preferences);
        Self {
            inner: Mutex::new(RuntimeState {
                preferences,
                overlay,
                chooser_devices: Vec::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, RuntimeState> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn preferences(&self) -> Preferences {
        self.lock().preferences.clone()
    }

    pub fn overlay(&self) -> OverlayState {
        self.lock().overlay.clone()
    }

    pub fn replace_overlay(&self, overlay: OverlayState) {
        self.lock().overlay = overlay;
    }

    pub fn set_open_at_login(&self, enabled: bool) -> Preferences {
        let mut state = self.lock();
        state.preferences.open_at_login = enabled;
        state.preferences.clone()
    }

    pub fn set_overlay_visible(&self, visible: bool) -> Preferences {
        let mut state = self.lock();
        state.preferences.overlay_visible = visible;
        state.preferences.clone()
    }

    pub fn set_overlay_position(&self, position: WindowPosition) -> Preferences {
        let mut state = self.lock();
        if state.preferences.overlay_variant == "compact" {
            state.preferences.compact_overlay_bounds = Some(position);
        } else {
            state.preferences.overlay_bounds = Some(position);
        }
        state.preferences.clone()
    }

    pub fn set_manager_bounds(&self, bounds: WindowBounds) -> Preferences {
        let mut state = self.lock();
        state.preferences.manager_bounds = Some(bounds);
        state.preferences.clone()
    }

    pub fn set_overlay_variant(&self, overlay_variant: &str) -> (Preferences, OverlayState) {
        let mut state = self.lock();
        let variant = if overlay_variant == "compact" {
            "compact"
        } else {
            "full"
        };
        state.preferences.overlay_variant = variant.to_owned();
        state.overlay.overlay_variant = variant.to_owned();
        (state.preferences.clone(), state.overlay.clone())
    }

    pub fn toggle_pin(&self) -> (Preferences, OverlayState) {
        let mut state = self.lock();
        let always_on_top = !state.preferences.always_on_top;
        state.preferences.always_on_top = always_on_top;
        state.overlay.always_on_top = always_on_top;
        (state.preferences.clone(), state.overlay.clone())
    }

    pub fn bind_device(&self, binding: DeviceBinding, display_name: String) -> Preferences {
        let mut state = self.lock();
        state.preferences.preferred_hid_device = Some(binding);
        state.preferences.display_device_name = display_name.clone();
        state.overlay.device_name = display_name;
        state.preferences.clone()
    }

    pub fn clear_device_binding(&self) -> Preferences {
        let mut state = self.lock();
        state.preferences.preferred_hid_device = None;
        state.preferences.display_device_name.clear();
        state.overlay.device_name.clear();
        state.preferences.clone()
    }

    pub fn set_chooser_devices(&self, devices: Vec<ChooserDevice>) {
        self.lock().chooser_devices = devices;
    }

    pub fn chooser_device(&self, device_id: &str) -> Option<ChooserDevice> {
        self.lock()
            .chooser_devices
            .iter()
            .find(|device| device.device_id == device_id)
            .cloned()
    }

    pub fn clear_chooser_devices(&self) {
        self.lock().chooser_devices.clear();
    }

    pub fn set_hub_sync(&self, enabled: bool) -> Preferences {
        let mut state = self.lock();
        state.preferences.hub_sync = enabled;
        state.preferences.clone()
    }

    pub fn hub_sync(&self) -> bool {
        self.lock().preferences.hub_sync
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join(SETTINGS_FILE))
}

fn legacy_settings_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|directory| directory.join("atktool").join(SETTINGS_FILE))
}

fn normalize_preferences(mut preferences: Preferences) -> Preferences {
    preferences.display_device_name = preferences
        .display_device_name
        .chars()
        .filter(|character| !character.is_control() && *character != '\u{fffd}')
        .take(128)
        .collect::<String>()
        .trim()
        .to_owned();
    preferences.overlay_variant = if preferences.overlay_variant == "compact" {
        "compact".to_owned()
    } else {
        "full".to_owned()
    };
    preferences
}

pub fn load_preferences(app: &AppHandle) -> Preferences {
    settings_path(app)
        .into_iter()
        .chain(legacy_settings_path())
        .find_map(|path| fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .map(normalize_preferences)
        .unwrap_or_default()
}

pub fn save_preferences(app: &AppHandle, preferences: &Preferences) -> Result<(), String> {
    let path = settings_path(app).ok_or_else(|| "无法获取 Tauri 配置目录".to_owned())?;
    let directory = path
        .parent()
        .ok_or_else(|| "Tauri 配置路径无效".to_owned())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(preferences).map_err(|error| error.to_string())?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, format!("{contents}\n")).map_err(|error| error.to_string())?;
    fs::rename(temporary_path, path).map_err(|error| error.to_string())
}
