use std::{ffi::c_void, ptr, sync::Mutex, thread, time::Duration};

use crate::{state::AppState, system_tray};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use windows::{
    core::{w, HSTRING},
    Win32::{
        Networking::WinHttp::*,
        UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    },
};

const REPOSITORY: &str = "https://github.com/naseaoi/atktool";
const LATEST: &str = "https://github.com/naseaoi/atktool/releases/latest";
const MAX_BODY: usize = 1024 * 1024;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    current_version: String,
    latest_version: Option<String>,
    release_url: Option<String>,
    checking: bool,
    checked_at: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: Option<String>,
}

fn version(tag: &str) -> Option<[u64; 3]> {
    let mut parts = tag.strip_prefix('v').unwrap_or(tag).split('.');
    let mut numbers = [0; 3];
    for n in &mut numbers {
        let part = parts.next()?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *n = part.parse().ok()?;
    }
    parts.next().is_none().then_some(numbers)
}

fn release_url(value: Option<&str>) -> String {
    let prefix = format!("{REPOSITORY}/releases/");
    value
        .filter(|v| v.starts_with(&prefix))
        .and_then(|v| tauri::Url::parse(v).ok())
        .filter(|u| u.as_str().starts_with(&prefix))
        .map(|u| u.to_string())
        .unwrap_or_else(|| LATEST.to_owned())
}

fn newer_release(body: &[u8], current: &str) -> Result<Option<(String, String)>, String> {
    let release: Release = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let latest = version(&release.tag_name).ok_or("发布标签不是三段数字版本号")?;
    let installed = version(current).ok_or("当前版本不是三段数字版本号")?;
    Ok((latest > installed).then(|| {
        (
            format!("{}.{}.{}", latest[0], latest[1], latest[2]),
            release_url(release.html_url.as_deref()),
        )
    }))
}

struct Handle(*mut c_void);

impl Handle {
    fn new(raw: *mut c_void) -> windows::core::Result<Self> {
        if raw.is_null() {
            Err(windows::core::Error::from_win32())
        } else {
            Ok(Self(raw))
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

fn fetch(current: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    unsafe {
        let session = Handle::new(WinHttpOpen(
            &HSTRING::from(format!("atktool/{current}")),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            None,
            None,
            0,
        ))?;
        WinHttpSetTimeouts(session.0, 10000, 10000, 10000, 10000)?;
        let server = Handle::new(WinHttpConnect(session.0, w!("api.github.com"), 443, 0))?;
        let request = Handle::new(WinHttpOpenRequest(
            server.0,
            w!("GET"),
            w!("/repos/naseaoi/atktool/releases/latest"),
            None,
            None,
            ptr::null(),
            WINHTTP_FLAG_SECURE,
        ))?;
        let headers: Vec<u16> = "Accept: application/vnd.github+json\r\n"
            .encode_utf16()
            .collect();
        WinHttpSendRequest(request.0, Some(&headers), None, 0, 0, 0)?;
        WinHttpReceiveResponse(request.0, ptr::null_mut())?;
        let mut status = 0u32;
        let mut size = std::mem::size_of_val(&status) as u32;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            None,
            Some((&raw mut status).cast()),
            &mut size,
            ptr::null_mut(),
        )?;
        if status != 200 {
            return Err(format!("GitHub HTTP {status}").into());
        }
        let mut body = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let mut read = 0;
            WinHttpReadData(
                request.0,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut read,
            )?;
            if read == 0 {
                return Ok(body);
            }
            if body.len() + read as usize > MAX_BODY {
                return Err("GitHub 响应超过大小限制".into());
            }
            body.extend_from_slice(&buffer[..read as usize]);
        }
    }
}

pub fn start(app: &AppHandle) {
    app.manage(Mutex::new(UpdateState {
        current_version: app.package_info().version.to_string(),
        ..Default::default()
    }));
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(10));
        loop {
            check_update(app.clone());
            thread::sleep(Duration::from_secs(12 * 3600));
        }
    });
}

fn publish(app: &AppHandle, state: &UpdateState) {
    if let Err(e) = app.emit_to("manager", "manager:update-state", state) {
        eprintln!("更新状态广播失败：{e}");
    }
}

fn notify(app: &AppHandle, version: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.preferences().notified_update_version.as_deref() != Some(version) {
        app.notification()
            .builder()
            .title(format!("发现新版本 v{version}"))
            .body("通过托盘菜单或设备管理页查看发布详情")
            .show()
            .map_err(|e| e.to_string())?;
        state.edit_preferences(app, |p| {
            p.notified_update_version = Some(version.to_owned())
        })?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_update_state(app: AppHandle) -> UpdateState {
    app.state::<Mutex<UpdateState>>().lock().unwrap().clone()
}

#[tauri::command]
pub fn check_update(app: AppHandle) -> UpdateState {
    let store = app.state::<Mutex<UpdateState>>();
    let mut state = store.lock().unwrap();
    if state.checking {
        return state.clone();
    }
    state.checking = true;
    state.error = None;
    publish(&app, &state);
    let started = state.clone();
    drop(state);
    let current = started.current_version.clone();
    thread::spawn(move || {
        let result = fetch(&current)
            .map_err(|e| e.to_string())
            .and_then(|body| newer_release(&body, &current));
        let store = app.state::<Mutex<UpdateState>>();
        let mut state = store.lock().unwrap();
        let mut changed = false;
        match result {
            Ok(release) => {
                let (latest, url) = release.unzip();
                changed = state.latest_version != latest;
                state.latest_version = latest;
                state.release_url = url;
            }
            Err(e) => state.error = Some(e),
        }
        let latest = state.latest_version.clone();
        drop(state);
        // 菜单操作可能等待窗口线程；保持检查在途，但不占用状态锁。
        if changed {
            if let Err(e) = system_tray::set_update_version(&app, latest.as_deref()) {
                eprintln!("更新托盘菜单失败：{e}");
            }
        }
        if let Some(v) = latest {
            if let Err(e) = notify(&app, &v) {
                eprintln!("新版本通知失败：{e}");
            }
        }
        let mut state = store.lock().unwrap();
        state.checked_at = Some(chrono::Utc::now().to_rfc3339());
        state.checking = false;
        publish(&app, &state);
    });
    started
}

fn open(url: &str) -> Result<(), String> {
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(url),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        Err(format!("打开浏览器失败（{}）", result.0 as isize))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn open_repository() -> Result<(), String> {
    open(REPOSITORY)
}

#[tauri::command]
pub fn open_release_page(app: AppHandle) -> Result<(), String> {
    open(
        get_update_state(app)
            .release_url
            .as_deref()
            .unwrap_or(LATEST),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_versions() {
        assert_eq!(version("v1.20.3"), Some([1, 20, 3]));
        for tag in [
            "1.2",
            "1.2.3.4",
            "1.2.3-beta",
            " 1.2.3",
            "+1.2.3",
            "1..3",
            "V1.2.3",
        ] {
            assert_eq!(version(tag), None);
        }
    }

    #[test]
    fn compares_github_release() {
        let json = br#"{"tag_name":"v1.10.0","html_url":"https://example.org"}"#;
        assert_eq!(
            newer_release(json, "1.9.9").unwrap(),
            Some(("1.10.0".into(), LATEST.into()))
        );
        for current in ["1.10.0", "2.0.0"] {
            assert!(newer_release(json, current).unwrap().is_none());
        }
        assert!(newer_release(b"{}", "1.0.0").is_err());
    }

    #[test]
    fn trusts_only_repository_releases() {
        let valid = format!("{REPOSITORY}/releases/tag/v2.0.0");
        assert_eq!(release_url(Some(&valid)), valid);
        for url in [
            None,
            Some("http://github.com/naseaoi/atktool/releases/"),
            Some("https://github.com/naseaoi/atktool/releases/../../other"),
        ] {
            assert_eq!(release_url(url), LATEST);
        }
    }

    #[test]
    #[ignore = "访问真实 GitHub Releases API"]
    fn github_latest_release_live() {
        let body = fetch(env!("CARGO_PKG_VERSION")).unwrap();
        let (latest, url) = newer_release(&body, "0.0.0").unwrap().unwrap();
        println!("latest v{latest} {url}");
        assert!(version(&latest).is_some());
        assert!(url.starts_with(&format!("{REPOSITORY}/releases/")));
    }
}
