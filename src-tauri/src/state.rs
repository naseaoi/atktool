use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use tauri::{AppHandle, Manager};

use tauri_plugin_notification::NotificationExt;

use crate::battery_trend::{estimate_minutes, should_notify};
use crate::models::{
    BatterySnapshot, ChooserDevice, DeviceBinding, OverlayState, Preferences, WindowBounds,
    WindowPosition,
};

pub const OVERLAY_SIZES: [&str; 3] = ["small", "medium", "large"];
pub const OVERLAY_OPACITY_MIN: u8 = 40;

const SETTINGS_FILE: &str = "settings.json";

struct RuntimeState {
    preferences: Preferences,
    overlay: OverlayState,
    chooser_devices: Vec<ChooserDevice>,
    charge_anchor: Option<BatterySnapshot>,
    battery_dirty: bool,
}

impl RuntimeState {
    fn reset_battery(&mut self) {
        self.preferences.last_battery = None;
        self.preferences.discharge_anchor = None;
        self.preferences.low_battery_alerted = [false; 2];
        self.charge_anchor = None;
        self.overlay.view.estimate_minutes = None;
        fill_view(&self.preferences, &mut self.overlay);
    }

    fn apply_sample(&mut self, overlay: &mut OverlayState) -> bool {
        overlay.view.estimate_minutes = None;
        if overlay.status != "connected" {
            return false;
        }
        let (Some(percent), Some(sampled_at)) = (overlay.battery_percent, &overlay.sampled_at)
        else {
            return false;
        };
        let sample = BatterySnapshot {
            percent,
            sampled_at: sampled_at.clone(),
        };
        let prefs = &mut self.preferences;
        let previous = prefs.last_battery.as_ref().map(|last| last.percent);
        let old_anchor = prefs.discharge_anchor.clone();
        let old_alerted = prefs.low_battery_alerted;
        let charging = overlay.charging || overlay.charge_status == "charging";
        let full = overlay.charge_status == "full";
        overlay.view.estimate_minutes = estimate_minutes(
            &mut prefs.discharge_anchor,
            &mut self.charge_anchor,
            &sample,
            charging,
            full,
        );
        let notify = should_notify(
            &mut prefs.low_battery_alerted,
            percent,
            charging || full,
            prefs.low_battery_notify,
        );
        self.battery_dirty |= previous != Some(percent)
            || old_anchor != prefs.discharge_anchor
            || old_alerted != prefs.low_battery_alerted;
        prefs.last_battery = Some(sample);
        notify
    }
}

pub struct AppState {
    inner: Mutex<RuntimeState>,
}

impl AppState {
    pub fn new(preferences: Preferences) -> Self {
        let mut overlay = OverlayState::from_preferences(&preferences);
        fill_view(&preferences, &mut overlay);
        Self {
            inner: Mutex::new(RuntimeState {
                preferences,
                overlay,
                chooser_devices: Vec::new(),
                charge_anchor: None,
                battery_dirty: false,
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

    /// 写入新采样结果并补齐派生字段；调用方应广播返回值而不是传入值。
    pub fn replace_overlay(&self, app: &AppHandle, mut overlay: OverlayState) -> OverlayState {
        let mut state = self.lock();
        let notify = state.apply_sample(&mut overlay);
        fill_view(&state.preferences, &mut overlay);
        state.overlay = overlay.clone();
        if state.battery_dirty {
            match write_preferences(app, &state.preferences) {
                Ok(()) => state.battery_dirty = false,
                Err(error) => eprintln!("电量配置保存失败：{error}"),
            }
        }
        drop(state);
        if notify {
            let name = if overlay.device_name.is_empty() {
                "鼠标"
            } else {
                &overlay.device_name
            };
            let mut body = format!("{name} 剩余 {}", overlay.battery_text);
            if let Some(minutes) = overlay.view.estimate_minutes {
                if minutes < 60 {
                    body.push_str(&format!("，约 {minutes} 分钟"));
                } else {
                    body.push_str(&format!("，约 {} 小时", (minutes + 30) / 60));
                }
            }
            if let Err(error) = app
                .notification()
                .builder()
                .title("鼠标电量低")
                .body(body)
                .show()
            {
                eprintln!("低电量通知发送失败：{error}");
            }
        }
        overlay
    }

    /// 偏好变化后重算派生字段，返回需要广播的悬浮窗状态。
    pub fn refresh_overlay_view(&self) -> OverlayState {
        let mut state = self.lock();
        let RuntimeState {
            preferences,
            overlay,
            ..
        } = &mut *state;
        fill_view(preferences, overlay);
        overlay.clone()
    }

    pub fn edit_preferences(
        &self,
        app: &AppHandle,
        edit: impl FnOnce(&mut Preferences),
    ) -> Result<Preferences, String> {
        let mut state = self.lock();
        let mut next = state.preferences.clone();
        edit(&mut next);
        write_preferences(app, &next)?;
        state.preferences = next.clone();
        Ok(next)
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
        if state.preferences.preferred_hid_device.as_ref() != Some(&binding) {
            state.reset_battery();
        }
        state.preferences.preferred_hid_device = Some(binding);
        state.preferences.display_device_name = display_name.clone();
        state.overlay.device_name = display_name;
        state.preferences.clone()
    }

    pub fn clear_device_binding(&self) -> Preferences {
        let mut state = self.lock();
        state.reset_battery();
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

fn fill_view(preferences: &Preferences, overlay: &mut OverlayState) {
    let view = &mut overlay.view;
    view.overlay_size = preferences.overlay_size.clone();
    view.overlay_opacity = preferences.overlay_opacity;
    view.position_locked = preferences.position_locked;
    view.last_battery_percent = preferences.last_battery.as_ref().map(|last| last.percent);
    view.last_sampled_at = preferences
        .last_battery
        .as_ref()
        .map(|last| last.sampled_at.clone());
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
    if !OVERLAY_SIZES.contains(&preferences.overlay_size.as_str()) {
        preferences.overlay_size = "medium".to_owned();
    }
    preferences.overlay_opacity = preferences.overlay_opacity.clamp(OVERLAY_OPACITY_MIN, 100);
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
    // 采样线程和窗口命令共用临时文件；持锁写最新配置，避免旧快照覆盖新设置。
    if let Some(state) = app.try_state::<AppState>() {
        return write_preferences(app, &state.lock().preferences);
    }
    write_preferences(app, preferences)
}

fn write_preferences(app: &AppHandle, preferences: &Preferences) -> Result<(), String> {
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

#[cfg(test)]
mod battery_tests {
    use super::*;
    use chrono::DateTime;

    fn sample(percent: u8, minute: i64) -> OverlayState {
        let mut overlay = OverlayState::from_preferences(&Preferences::default());
        overlay.status = "connected".to_owned();
        overlay.battery_percent = Some(percent);
        overlay.sampled_at = Some(
            DateTime::from_timestamp(minute * 60, 0)
                .unwrap()
                .to_rfc3339(),
        );
        overlay
    }

    #[test]
    fn steady_percent_keeps_latest_time_without_requesting_another_save() {
        let app = AppState::new(serde_json::from_str("{}").unwrap());
        let mut state = app.lock();
        assert!(state.apply_sample(&mut sample(19, 0)));
        assert!(state.battery_dirty);
        state.battery_dirty = false;
        let mut same = sample(19, 10);
        assert!(!state.apply_sample(&mut same));
        assert!(!state.battery_dirty);
        assert_eq!(
            state.preferences.last_battery.as_ref().unwrap().sampled_at,
            same.sampled_at.unwrap()
        );
        let mut charging = sample(19, 15);
        charging.charge_status = "charging".to_owned();
        assert!(!state.apply_sample(&mut charging));
        assert!(state.battery_dirty);
        assert_eq!(state.preferences.discharge_anchor, None);
    }

    #[test]
    fn restart_restores_discharge_and_alerts_but_rebinding_forgets_them() {
        let app = AppState::new(Preferences::default());
        assert!(app.lock().apply_sample(&mut sample(19, 0)));
        let json = serde_json::to_string(&app.preferences()).unwrap();
        let restarted = AppState::new(serde_json::from_str(&json).unwrap());
        let mut overlay = sample(16, 30);
        assert!(!restarted.lock().apply_sample(&mut overlay));
        assert_eq!(overlay.view.estimate_minutes, Some(160));
        overlay.status = "waiting".to_owned();
        assert!(!restarted.lock().apply_sample(&mut overlay));
        assert_eq!(overlay.view.estimate_minutes, None);
        let rebound = restarted.bind_device(DeviceBinding::default(), "新鼠标".to_owned());
        assert_eq!(rebound.discharge_anchor, None);
        assert_eq!(rebound.last_battery, None);
        assert!(restarted.lock().apply_sample(&mut sample(16, 40)));
        assert_eq!(restarted.clear_device_binding().discharge_anchor, None);
    }
}
