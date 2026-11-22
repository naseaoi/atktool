use std::{
    collections::BTreeSet,
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};

use chrono::Utc;
use hidapi::HidApi;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    device::{candidates, list_devices, open_path, NativeDevice},
    models::{DeviceBinding, OverlayState},
    protocol::{is_protocol_failure, read_battery, BatteryReading, ProtocolKind, Transport},
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

fn update_paths(previous: &mut BTreeSet<String>, current: impl Iterator<Item = String>) -> bool {
    let current = current.collect();
    let changed = *previous != current;
    *previous = current;
    changed
}

fn poll_interval(visible: bool, charging: bool, status: &str, percent: Option<u8>) -> Duration {
    if charging || status == "full" {
        Duration::from_secs(if visible { 5 } else { 15 })
    } else if visible {
        POLL_VISIBLE
    } else if percent.is_some_and(|p| p <= 20) {
        POLL_HIDDEN_LOW
    } else if percent.is_some_and(|p| p <= 40) {
        POLL_HIDDEN_MEDIUM
    } else {
        POLL_HIDDEN_DEFAULT
    }
}

fn interval_label(interval: Duration) -> String {
    let seconds = interval.as_secs();
    if seconds >= 60 && seconds % 60 == 0 {
        format!("{} 分钟", seconds / 60)
    } else {
        format!("{seconds} 秒")
    }
}

const FOLLOW_UP_MS: [u64; 3] = [1000, 3000, 6000];
type ChargeState = (bool, String);

struct TopologyRound {
    start: Instant,
    deadline: Instant,
    baseline: Option<ChargeState>,
    first: bool,
}

#[derive(Default)]
struct TopologySchedule(Option<TopologyRound>);

impl TopologySchedule {
    fn event(&mut self, now: Instant, baseline: Option<ChargeState>) {
        let debounce = now + Duration::from_millis(250);
        if let Some(round) = self.0.as_mut().filter(|r| r.first) {
            round.deadline = debounce.min(round.start + Duration::from_secs(1));
        } else {
            self.0 = Some(TopologyRound {
                start: now,
                deadline: debounce,
                baseline,
                first: true,
            });
        }
    }

    fn deadline(&self) -> Option<Instant> {
        self.0.as_ref().map(|round| round.deadline)
    }

    fn take_due(&mut self, now: Instant) -> Option<bool> {
        let round = self.0.as_mut().filter(|r| now >= r.deadline)?;
        let scan = round.first;
        round.first = false;
        if let Some(next) = FOLLOW_UP_MS
            .iter()
            .map(|ms| round.start + Duration::from_millis(*ms))
            .find(|t| *t > now)
        {
            round.deadline = next;
        } else {
            self.0 = None;
        }
        Some(scan)
    }

    fn observed(&mut self, state: ChargeState) {
        if self
            .0
            .as_ref()
            .is_some_and(|r| r.baseline.as_ref().is_some_and(|before| *before != state))
        {
            self.0 = None;
        }
    }
}

enum ServiceCommand {
    TopologyChanged(Instant),
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

    pub fn topology_changed(&self) -> Result<(), String> {
        self.sender
            .send(ServiceCommand::TopologyChanged(Instant::now()))
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
    protocol: Option<(ProtocolKind, Transport)>,
    topology: TopologySchedule,
    failures: u32,
    last_stable: Option<OverlayState>,
    last_paths: BTreeSet<String>,
    next_device_watch: Instant,
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
        interval: Duration,
    ) -> OverlayState {
        self.remember_binding(device);
        self.topology
            .observed((reading.charging, reading.charge_status.to_owned()));
        self.failures = 0;
        let preferences = self.app.state::<AppState>().preferences();
        let overlay = OverlayState {
            status: "connected".to_owned(),
            message: if self.visible {
                "原生 HID 直连已建立。".to_owned()
            } else {
                format!("托盘后台采集中，每 {} 轮询一次。", interval_label(interval))
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
        let changed = update_paths(
            &mut self.last_paths,
            devices.iter().map(NativeDevice::device_id),
        );
        self.refresh_devices(devices, scan_devices || changed)
    }

    fn refresh_devices(&mut self, devices: Vec<NativeDevice>, scan_devices: bool) -> Duration {
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
                Ok((reading, transport)) => {
                    self.protocol = Some((reading.protocol, transport));
                    let interval = poll_interval(
                        self.visible,
                        reading.charging,
                        reading.charge_status,
                        Some(reading.battery_percent),
                    );
                    let overlay = self.connected(device, reading, count, interval);
                    self.emit(overlay);
                    return interval;
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

    fn watch_devices(&mut self) -> Option<Duration> {
        if self.suspended || self.binding.is_none() {
            return None;
        }
        let devices = list_devices(&mut self.api).ok()?;
        update_paths(
            &mut self.last_paths,
            devices.iter().map(NativeDevice::device_id),
        )
        .then(|| self.refresh_devices(devices, true))
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
        topology: TopologySchedule::default(),
        failures: 0,
        last_stable: None,
        last_paths: Default::default(),
        next_device_watch: Instant::now() + DEVICE_WATCH_INTERVAL,
    };
    let mut next_poll = Instant::now();
    let mut last_topology_read = None;
    loop {
        let now = Instant::now();
        let deadline = next_poll.min(runtime.next_device_watch);
        let deadline = runtime
            .topology
            .deadline()
            .map_or(deadline, |due| deadline.min(due));
        let timeout = deadline.saturating_duration_since(now);
        match receiver.recv_timeout(timeout) {
            Ok(ServiceCommand::Refresh { scan_devices }) => {
                let interval = runtime.refresh(scan_devices);
                next_poll = Instant::now() + interval;
                runtime.next_device_watch = Instant::now() + DEVICE_WATCH_INTERVAL;
                continue;
            }
            Ok(ServiceCommand::TopologyChanged(at)) => {
                if !runtime.suspended
                    && runtime.binding.is_some()
                    && last_topology_read.is_none_or(|read| at > read)
                {
                    let baseline = runtime
                        .last_stable
                        .as_ref()
                        .map(|o| (o.charging, o.charge_status.clone()));
                    runtime.topology.event(at, baseline);
                    // 即将进行的首扫同时覆盖轮询和设备监视，避免先阻塞在普通读取上。
                    if let Some(scan) = runtime.topology.deadline() {
                        next_poll = next_poll.max(scan);
                        runtime.next_device_watch = runtime.next_device_watch.max(scan);
                    }
                }
            }
            Ok(ServiceCommand::SetBinding(binding)) => {
                runtime.topology = TopologySchedule::default();
                runtime.binding = binding;
                runtime.protocol = None;
                runtime.failures = 0;
                runtime.last_stable = None;
                next_poll = Instant::now();
            }
            Ok(ServiceCommand::SetVisible(visible)) => {
                runtime.visible = visible;
                next_poll = if visible {
                    Instant::now()
                } else {
                    let interval = runtime
                        .last_stable
                        .as_ref()
                        .map_or(POLL_HIDDEN_DEFAULT, |o| {
                            poll_interval(false, o.charging, &o.charge_status, o.battery_percent)
                        });
                    Instant::now() + interval
                };
            }
            Ok(ServiceCommand::SetSuspended(suspended)) => {
                runtime.suspended = suspended;
                if suspended {
                    runtime.topology = TopologySchedule::default();
                }
                next_poll = if suspended {
                    Instant::now() + POLL_HIDDEN_DEFAULT
                } else {
                    Instant::now()
                };
                continue;
            }
            Ok(ServiceCommand::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let now = Instant::now();
        if let Some(scan) = runtime.topology.take_due(now) {
            last_topology_read = Some(now);
            let interval = runtime.refresh(scan);
            next_poll = Instant::now() + interval;
            runtime.next_device_watch = Instant::now() + DEVICE_WATCH_INTERVAL;
        } else if now >= next_poll {
            let interval = runtime.refresh(false);
            next_poll = Instant::now() + interval;
            runtime.next_device_watch = Instant::now() + DEVICE_WATCH_INTERVAL;
        } else if now >= runtime.next_device_watch {
            if let Some(interval) = runtime.watch_devices() {
                next_poll = Instant::now() + interval;
            }
            runtime.next_device_watch = Instant::now() + DEVICE_WATCH_INTERVAL;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_legacy_device_name_placeholders() {
        assert!(is_placeholder_device_name("ATK 设备"));
        assert!(is_placeholder_device_name("ATK设备"));
        assert!(is_placeholder_device_name(""));
        assert!(!is_placeholder_device_name("ATK X1 Pro"));
    }

    #[test]
    fn detects_path_changes_independently_of_order() {
        let mut paths = BTreeSet::new();
        assert!(update_paths(
            &mut paths,
            ["receiver", "cable"].into_iter().map(str::to_owned)
        ));
        assert!(!update_paths(
            &mut paths,
            ["cable", "receiver"].into_iter().map(str::to_owned)
        ));
        assert!(update_paths(
            &mut paths,
            ["receiver"].into_iter().map(str::to_owned)
        ));
    }

    #[test]
    fn event_storm_bounds_first_scan_and_coalesces_the_one_second_read() {
        let start = Instant::now();
        let mut plan = TopologySchedule::default();
        for ms in (0..1000).step_by(100) {
            let now = start + Duration::from_millis(ms);
            plan.event(now, None);
            assert_eq!(plan.take_due(now), None);
        }
        let now = start + Duration::from_secs(1);
        assert_eq!(plan.take_due(now), Some(true));
        assert_eq!(plan.take_due(now), None);
        assert_eq!(plan.deadline(), Some(start + Duration::from_secs(3)));
    }

    #[test]
    fn charge_transition_cancels_follow_ups() {
        let start = Instant::now();
        let mut plan = TopologySchedule::default();
        let full = (false, "full".to_owned());
        plan.event(start, Some(full.clone()));
        assert_eq!(
            plan.take_due(start + Duration::from_millis(250)),
            Some(true)
        );
        plan.observed(full);
        assert_eq!(plan.take_due(start + Duration::from_secs(1)), Some(false));
        plan.observed((false, "idle".to_owned()));
        assert_eq!(plan.deadline(), None);
    }

    #[test]
    fn event_during_follow_ups_starts_a_new_round() {
        let start = Instant::now();
        let mut plan = TopologySchedule::default();
        plan.event(start, None);
        plan.take_due(start + Duration::from_millis(250));
        let restart = start + Duration::from_millis(800);
        plan.event(restart, None);
        assert_eq!(plan.take_due(start + Duration::from_secs(1)), None);
        assert_eq!(
            plan.take_due(restart + Duration::from_millis(250)),
            Some(true)
        );
        for seconds in [1, 3, 6] {
            assert_eq!(
                plan.take_due(restart + Duration::from_secs(seconds)),
                Some(false)
            );
        }
        assert_eq!(plan.deadline(), None);
    }

    #[test]
    fn labels_poll_intervals_in_natural_units() {
        assert_eq!(interval_label(Duration::from_secs(15)), "15 秒");
        assert_eq!(interval_label(POLL_HIDDEN_DEFAULT), "10 分钟");
    }

    #[test]
    fn cable_polling_includes_full_without_charging_flag() {
        for (charging, status) in [(true, "charging"), (false, "full")] {
            assert_eq!(
                poll_interval(true, charging, status, Some(100)),
                Duration::from_secs(5)
            );
            assert_eq!(
                poll_interval(false, charging, status, Some(100)),
                Duration::from_secs(15)
            );
        }
        assert_eq!(
            poll_interval(false, false, "idle", Some(20)),
            POLL_HIDDEN_LOW
        );
    }

    #[test]
    fn retries_missing_bound_device_promptly() {
        assert_eq!(DEVICE_RECONNECT_INTERVAL, Duration::from_secs(15));
    }
}
