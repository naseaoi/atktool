use crate::{
    battery_service::BatteryService,
    models::{OverlayState, Preferences},
    state::AppState,
    system_tray,
};
use std::sync::Mutex;
use tauri::{AppHandle, Listener, Manager};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};

#[derive(Default)]
struct Policy {
    fullscreen: bool,
    manual: Option<bool>,
}

fn attention(s: &OverlayState) -> bool {
    s.status == "connected" && (s.charging || s.battery_percent.is_some_and(|p| p <= 20))
}

impl Policy {
    fn visible(&mut self, p: &Preferences, attention: bool) -> bool {
        if self.manual != Some(attention) || !p.overlay_visible {
            self.manual = None;
        }
        p.overlay_visible
            && (self.manual.is_some()
                || !(p.hide_in_fullscreen && self.fullscreen || p.smart_display && !attention))
    }
}

pub fn manual_show(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut p = state.preferences();
    p.overlay_visible = true;
    let needs = attention(&state.overlay());
    let policy = app.state::<Mutex<Policy>>();
    let mut policy = policy.lock().unwrap();
    if !policy.visible(&p, needs) {
        policy.manual = Some(needs);
    }
}

pub fn apply(app: &AppHandle, force: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let visible = app
        .state::<Mutex<Policy>>()
        .lock()
        .unwrap()
        .visible(&state.preferences(), attention(&state.overlay()));
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    if force || visible != window.is_visible().map_err(|e| e.to_string())? {
        if visible {
            window.show()
        } else {
            window.hide()
        }
        .map_err(|e| e.to_string())?;
        app.state::<BatteryService>().set_visible(visible)?;
        system_tray::update(app)?;
    }
    Ok(())
}

fn schedule(app: &AppHandle) {
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(e) = apply(&handle, false) {
            eprintln!("悬浮窗可见性更新失败：{e}");
        }
    }) {
        eprintln!("悬浮窗可见性调度失败：{e}");
    }
}

pub fn poll(app: &AppHandle) {
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => {
            let active = matches!(
                state,
                QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE
            );
            let policy = app.state::<Mutex<Policy>>();
            let changed =
                std::mem::replace(&mut policy.lock().unwrap().fullscreen, active) != active;
            if changed {
                schedule(app);
            }
        }
        Err(e) => eprintln!("全屏状态查询失败：{e}"),
    }
}

pub fn install(app: &AppHandle) {
    app.manage(Mutex::new(Policy::default()));
    poll(app);
    let handle = app.clone();
    // 直连和官网采集均广播此事件，即使管理页尚未创建。
    app.listen("manager:overlay-state", move |_| schedule(&handle));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_live_low_or_charging_samples_need_attention() {
        let mut s = OverlayState::from_preferences(&Preferences::default());
        s.status = "connected".into();
        for (percent, charging, want) in [
            (None, false, false),
            (Some(20), false, true),
            (Some(21), false, false),
            (None, true, true),
        ] {
            s.battery_percent = percent;
            s.charging = charging;
            assert_eq!(attention(&s), want);
        }
        s.status = "waiting".into();
        assert!(!attention(&s));
    }
    #[test]
    fn manual_reveal_lasts_until_attention_changes() {
        let mut p = Preferences {
            smart_display: true,
            ..Default::default()
        };
        let mut policy = Policy::default();
        assert!(!policy.visible(&p, false));
        assert!(policy.visible(&p, true));
        policy.fullscreen = true;
        assert!(!policy.visible(&p, true));
        policy.manual = Some(false);
        assert!(policy.visible(&p, false));
        assert!(!policy.visible(&p, true));
        policy.fullscreen = false;
        assert!(policy.visible(&p, true));
        p.overlay_visible = false;
        assert!(!policy.visible(&p, true));
    }
}
