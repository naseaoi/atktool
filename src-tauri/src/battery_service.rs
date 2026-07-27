use std::{
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread,
    time::Duration,
};

use chrono::Utc;
use hidapi::HidApi;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    device::{candidates, list_devices, open_path, NativeDevice},
    models::{DeviceBinding, OverlayState},
    protocol::{is_protocol_failure, read_battery, BatteryReading, ProtocolKind},
    state::{save_preferences, AppState},
    system_tray,
};

const POLL_VISIBLE: Duration = Duration::from_secs(10);
const POLL_HIDDEN_DEFAULT: Duration = Duration::from_secs(10 * 60);
const POLL_HIDDEN_MEDIUM: Duration = Duration::from_secs(5 * 60);
const POLL_HIDDEN_LOW: Duration = Duration::from_secs(2 * 60);
const DEVICE_RECONNECT_INTERVAL: Duration = Duration::from_secs(15);
const DEVICE_WATCH_INTERVAL: Duration = Duration::from_secs(2 * 60);
const FAILURE_RESET_LIMIT: u32 = 3;

fn is_placeholder_device_name(name: &str) -> bool {
    let compact = name.split_whitespace().collect::<String>();
    compact.is_empty() || compact.eq_ignore_ascii_case("ATK设备")
}

fn device_list_changed(previous: &[String], current: &[String]) -> bool {
    previous != current
}

enum ServiceCommand {
    Refresh { scan_devices: bool },
    SetBinding(Option<DeviceBinding>),
    SetVisible(bool),
    SetSuspended(bool),
    Stop,
}

pub struct BatteryService {
    sender: Sender<ServiceCommand>,
}

impl BatteryService {
    pub fn start(app: AppHandle, binding: Option<DeviceBinding>, visible: bool) -> Self {
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("atk-hid-runtime".to_owned())
            .spawn(move || worker_loop(app, receiver, binding, visible))
            .expect("failed to start HID runtime");
        Self { sender }
    }

    pub fn refresh(&self, scan_devices: bool) -> Result<(), String> {
        self.sender
            .send(ServiceCommand::Refresh { scan_devices })
            .map_err(|error| error.to_string())
    }

    pub fn set_binding(&self, binding: Option<DeviceBinding>) -> Result<(), String> {
        self.sender
            .send(ServiceCommand::SetBinding(binding))
            .map_err(|error| error.to_string())
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        self.sender
            .send(ServiceCommand::SetVisible(visible))
            .map_err(|error| error.to_string())
    }

    pub fn set_suspended(&self, suspended: bool) -> Result<(), String> {
        self.sender
            .send(ServiceCommand::SetSuspended(suspended))
            .map_err(|error| error.to_string())
    }
}

impl Drop for BatteryService {
    fn drop(&mut self) {
        let _ = self.sender.send(ServiceCommand::Stop);
    }
}

struct Runtime {
    app: AppHandle,
    api: HidApi,
    binding: Option<DeviceBinding>,
    visible: bool,
    suspended: bool,
    protocol: Option<ProtocolKind>,
    failures: u32,
    last_stable: Option<OverlayState>,
    last_paths: Vec<String>,
    next_device_watch: std::time::Instant,
}

impl Runtime {
    fn emit(&self, overlay: OverlayState) {
        self.app
            .state::<AppState>()
            .replace_overlay(overlay.clone());
        let _ = self.app.emit("overlay:state-changed", &overlay);
        let _ = self.app.emit("manager:overlay-state", &overlay);
        let _ = system_tray::update(&self.app);
    }

    fn now() -> Option<String> {
        Some(Utc::now().to_rfc3339())
    }

    fn waiting(&self, message: &str, device_count: usize) -> OverlayState {
        let preferences = self.app.state::<AppState>().preferences();
        OverlayState {
            status: "waiting".to_owned(),
            message: message.to_owned(),
            battery_percent: None,
            battery_text: "--".to_owned(),
            device_name: preferences.display_device_name,
            charging: false,
            charge_status: "idle".to_owned(),
            needs_user_action: true,
            sampled_at: Self::now(),
            protocol_name: String::new(),
            mode: "stable".to_owned(),
            always_on_top: preferences.always_on_top,
            overlay_variant: preferences.overlay_variant,
            granted_devices_count: device_count,
        }
    }

    fn next_poll_interval(&self) -> Duration {
        if self.visible {
            return POLL_VISIBLE;
        }
        let overlay = self.app.state::<AppState>().overlay();
        if overlay.charging || overlay.battery_percent.is_some_and(|percent| percent <= 20) {
            POLL_HIDDEN_LOW
        } else if overlay.battery_percent.is_some_and(|percent| percent <= 40) {
            POLL_HIDDEN_MEDIUM
        } else {
            POLL_HIDDEN_DEFAULT
        }
    }

    fn retry_interval(&self) -> Duration {
        let maximum = if self.visible { 30 } else { 120 };
        let exponent = self.failures.saturating_sub(1).min(8);
        Duration::from_secs((5u64.saturating_mul(1u64 << exponent)).min(maximum))
    }

    fn remember_binding(&mut self, device: &NativeDevice) {
        let binding = device.binding();
        let state = self.app.state::<AppState>();
        let preferences = state.preferences();
        if self.binding.as_ref() == Some(&binding)
            && !is_placeholder_device_name(&preferences.display_device_name)
        {
            return;
        }
        self.binding = Some(binding.clone());
        let preferences = state.bind_device(binding, device.display_name());
        let _ = save_preferences(&self.app, &preferences);
        let _ = self.app.emit("manager:preferences", preferences);
    }

    fn connected(
        &mut self,
        device: &NativeDevice,
        reading: BatteryReading,
        count: usize,
    ) -> OverlayState {
        self.remember_binding(device);
        self.protocol = Some(reading.protocol);
        self.failures = 0;
        let preferences = self.app.state::<AppState>().preferences();
        let overlay = OverlayState {
            status: "connected".to_owned(),
            message: if self.visible {
                "原生 HID 直连已建立。".to_owned()
            } else {
                format!(
                    "托盘后台采集中，当前为{}分钟级轮询。",
                    self.next_poll_interval().as_secs() / 60
                )
            },
            battery_percent: Some(reading.battery_percent),
            battery_text: format!("{}%", reading.battery_percent),
            device_name: device.display_name(),
            charging: reading.charging,
            charge_status: reading.charge_status.to_owned(),
            needs_user_action: false,
            sampled_at: Self::now(),
            protocol_name: reading.protocol.label().to_owned(),
            mode: "stable".to_owned(),
            always_on_top: preferences.always_on_top,
            overlay_variant: preferences.overlay_variant,
            granted_devices_count: count,
        };
        self.last_stable = Some(overlay.clone());
        overlay
    }

    fn refresh(&mut self, scan_devices: bool) -> Duration {
        if self.suspended {
            return POLL_HIDDEN_DEFAULT;
        }
        if self.binding.is_none() {
            self.protocol = None;
            self.last_stable = None;
            let overlay = self.waiting(
                "还没有绑定设备。请先在设备管理里选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。",
                0,
            );
            self.emit(overlay);
            return POLL_HIDDEN_DEFAULT;
        }
        let devices = match list_devices(&mut self.api) {
            Ok(devices) => devices,
            Err(error) => return self.handle_error(error, false, 0),
        };
        self.last_paths = devices.iter().map(NativeDevice::device_id).collect();
        let count = devices.len();
        let candidates = candidates(&devices, self.binding.as_ref());
        if candidates.is_empty() {
            self.protocol = None;
            let overlay = self.waiting(
                "当前绑定设备未接入，请连接后刷新，或改为更换绑定设备。",
                count,
            );
            self.emit(overlay);
            return DEVICE_RECONNECT_INTERVAL;
        }
        let allow_fallback =
            scan_devices || self.protocol.is_none() || self.failures >= FAILURE_RESET_LIMIT;
        let mut errors = Vec::new();
        for device in &candidates {
            let handle = match open_path(&self.api, &device.path) {
                Ok(handle) => handle,
                Err(error) => {
                    errors.push(error);
                    continue;
                }
            };
            let first_read = read_battery(&handle, self.protocol, allow_fallback, scan_devices);
            let result = match first_read {
                Err(error) if !is_protocol_failure(&error) => {
                    drop(handle);
                    thread::sleep(Duration::from_millis(260));
                    open_path(&self.api, &device.path).and_then(|reopened| {
                        thread::sleep(Duration::from_millis(120));
                        read_battery(&reopened, None, true, scan_devices)
                    })
                }
                result => result,
            };
            match result {
                Ok(reading) => {
                    let overlay = self.connected(device, reading, count);
                    self.emit(overlay);
                    return self.next_poll_interval();
                }
                Err(error) => errors.push(error),
            }
        }
        let message = if errors.is_empty() {
            "读取设备失败".to_owned()
        } else {
            errors.into_iter().take(4).collect::<Vec<_>>().join(" | ")
        };
        self.handle_error(message.clone(), is_protocol_failure(&message), count)
    }

    fn handle_error(&mut self, error: String, protocol_failure: bool, count: usize) -> Duration {
        self.failures = self.failures.saturating_add(1);
        if self.failures >= FAILURE_RESET_LIMIT {
            self.protocol = None;
        }
        if !protocol_failure {
            if let Some(mut stable) = self.last_stable.clone() {
                stable.message = format!(
                    "本次轮询读取失败，已沿用上次成功结果（{} 次）。正在自动重试...",
                    self.failures
                );
                stable.granted_devices_count = count;
                self.emit(stable);
                return self.retry_interval();
            }
        }
        let preferences = self.app.state::<AppState>().preferences();
        let overlay = OverlayState {
            status: if protocol_failure {
                "unsupported"
            } else {
                "error"
            }
            .to_owned(),
            message: if protocol_failure {
                format!("直连协议暂未完全适配：{error}。可手动刷新或更换绑定设备。")
            } else {
                format!("原生 HID 读取异常：{error}。正在自动重试...")
            },
            battery_percent: None,
            battery_text: "--".to_owned(),
            device_name: preferences.display_device_name.clone(),
            charging: false,
            charge_status: "idle".to_owned(),
            needs_user_action: false,
            sampled_at: Self::now(),
            protocol_name: if protocol_failure {
                "待补充协议适配".to_owned()
            } else {
                String::new()
            },
            mode: "stable".to_owned(),
            always_on_top: preferences.always_on_top,
            overlay_variant: preferences.overlay_variant,
            granted_devices_count: count,
        };
        self.emit(overlay);
        if protocol_failure {
            POLL_HIDDEN_DEFAULT
        } else {
            self.retry_interval()
        }
    }

    fn devices_changed(&mut self) -> bool {
        let now = std::time::Instant::now();
        if now < self.next_device_watch {
            return false;
        }
        self.next_device_watch = now + DEVICE_WATCH_INTERVAL;
        if self.binding.is_none() {
            return false;
        }
        let Ok(devices) = list_devices(&mut self.api) else {
            return false;
        };
        let paths: Vec<_> = devices.iter().map(NativeDevice::device_id).collect();
        let changed = device_list_changed(&self.last_paths, &paths);
        self.last_paths = paths;
        changed
    }
}

fn worker_loop(
    app: AppHandle,
    receiver: Receiver<ServiceCommand>,
    binding: Option<DeviceBinding>,
    visible: bool,
) {
    let api = match HidApi::new() {
        Ok(api) => api,
        Err(error) => {
            let mut overlay = app.state::<AppState>().overlay();
            overlay.status = "error".to_owned();
            overlay.message = format!("HID 初始化失败：{error}");
            app.state::<AppState>().replace_overlay(overlay.clone());
            let _ = app.emit("overlay:state-changed", &overlay);
            let _ = app.emit("manager:overlay-state", &overlay);
            return;
        }
    };
    let mut runtime = Runtime {
        app,
        api,
        binding,
        visible,
        suspended: false,
        protocol: None,
        failures: 0,
        last_stable: None,
        last_paths: Vec::new(),
        next_device_watch: std::time::Instant::now() + DEVICE_WATCH_INTERVAL,
    };
    let mut next_poll = std::time::Instant::now();
    loop {
        let now = std::time::Instant::now();
        let deadline = next_poll.min(runtime.next_device_watch);
        let timeout = deadline.saturating_duration_since(now);
        match receiver.recv_timeout(timeout) {
            Ok(ServiceCommand::Refresh { scan_devices }) => {
                let interval = runtime.refresh(scan_devices);
                next_poll = std::time::Instant::now() + interval;
            }
            Ok(ServiceCommand::SetBinding(binding)) => {
                runtime.binding = binding;
                runtime.protocol = None;
                runtime.failures = 0;
                runtime.last_stable = None;
                next_poll = std::time::Instant::now();
            }
            Ok(ServiceCommand::SetVisible(visible)) => {
                runtime.visible = visible;
                next_poll = if visible {
                    std::time::Instant::now()
                } else {
                    std::time::Instant::now() + runtime.next_poll_interval()
                };
            }
            Ok(ServiceCommand::SetSuspended(suspended)) => {
                runtime.suspended = suspended;
                next_poll = if suspended {
                    std::time::Instant::now() + POLL_HIDDEN_DEFAULT
                } else {
                    std::time::Instant::now()
                };
            }
            Ok(ServiceCommand::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                let now = std::time::Instant::now();
                let changed = now >= runtime.next_device_watch && runtime.devices_changed();
                if changed || now >= next_poll {
                    let interval = runtime.refresh(changed);
                    next_poll = std::time::Instant::now() + interval;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{device_list_changed, is_placeholder_device_name, DEVICE_RECONNECT_INTERVAL};
    use std::time::Duration;

    #[test]
    fn recognizes_legacy_device_name_placeholders() {
        assert!(is_placeholder_device_name("ATK 设备"));
        assert!(is_placeholder_device_name("ATK设备"));
        assert!(is_placeholder_device_name(""));
        assert!(!is_placeholder_device_name("ATK X1 Pro"));
    }

    #[test]
    fn detects_first_device_after_empty_startup_scan() {
        assert!(device_list_changed(&[], &["receiver".to_owned()]));
        assert!(!device_list_changed(
            &["receiver".to_owned()],
            &["receiver".to_owned()]
        ));
    }

    #[test]
    fn retries_missing_bound_device_promptly() {
        assert_eq!(DEVICE_RECONNECT_INTERVAL, Duration::from_secs(15));
    }
}
