#[cfg(target_os = "windows")]
mod platform {
    use std::{
        sync::atomic::{AtomicIsize, Ordering},
        sync::{mpsc, Arc},
        thread::{self, JoinHandle},
    };

    use tauri::{AppHandle, Manager};
    use windows::{
        core::w,
        Win32::{
            Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
                GetWindowLongPtrW, PostMessageW, PostQuitMessage, RegisterClassW,
                SetWindowLongPtrW, CREATESTRUCTW, GWLP_USERDATA, HWND_MESSAGE, MSG,
                WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE, WM_NCCREATE, WM_NCDESTROY, WNDCLASSW,
            },
        },
    };

    use crate::{battery_service::BatteryService, state::AppState};

    const WM_POWERBROADCAST: u32 = 0x0218;
    const WM_DEVICECHANGE: u32 = 0x0219;
    const PBT_APMSUSPEND: usize = 0x0004;
    const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_NCCREATE {
            let create = unsafe { &*(lparam.0 as *const CREATESTRUCTW) };
            unsafe {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
            }
        }
        let reference = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) };
        if reference != 0 {
            let app = unsafe { &*(reference as *const AppHandle) };
            match message {
                WM_DEVICECHANGE => {
                    let _ = app.state::<BatteryService>().refresh(true);
                }
                WM_POWERBROADCAST if wparam.0 == PBT_APMSUSPEND => {
                    let _ = app.state::<BatteryService>().set_suspended(true);
                }
                WM_POWERBROADCAST if wparam.0 == PBT_APMRESUMEAUTOMATIC => {
                    if !app.state::<AppState>().hub_sync() {
                        let service = app.state::<BatteryService>();
                        let _ = service.set_suspended(false);
                        let _ = service.refresh(true);
                    }
                }
                WM_CLOSE => {
                    let _ = unsafe { DestroyWindow(hwnd) };
                    return LRESULT(0);
                }
                WM_NCDESTROY => {
                    unsafe {
                        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                        drop(Box::from_raw(reference as *mut AppHandle));
                        PostQuitMessage(0);
                    }
                    return LRESULT(0);
                }
                _ => {}
            }
        }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    pub struct WindowsIntegration {
        hwnd: Arc<AtomicIsize>,
        thread: Option<JoinHandle<()>>,
    }

    impl WindowsIntegration {
        pub fn start(app: AppHandle) -> Result<Self, String> {
            let hwnd = Arc::new(AtomicIsize::new(0));
            let thread_hwnd = Arc::clone(&hwnd);
            let (ready, result) = mpsc::sync_channel(1);
            let worker = thread::Builder::new()
                .name("atk-windows-events".to_owned())
                .spawn(move || {
                    run_message_loop(app, &thread_hwnd, ready);
                })
                .map_err(|error| error.to_string())?;
            result.recv().map_err(|error| error.to_string())??;
            Ok(Self {
                hwnd,
                thread: Some(worker),
            })
        }
    }

    impl Drop for WindowsIntegration {
        fn drop(&mut self) {
            let hwnd = self.hwnd.load(Ordering::Acquire);
            if hwnd != 0 {
                let _ = unsafe {
                    PostMessageW(Some(HWND(hwnd as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0))
                };
            }
            if let Some(worker) = self.thread.take() {
                let _ = worker.join();
            }
        }
    }

    fn run_message_loop(
        app: AppHandle,
        hwnd_slot: &AtomicIsize,
        ready: mpsc::SyncSender<Result<(), String>>,
    ) {
        let module = match unsafe { GetModuleHandleW(None) } {
            Ok(module) => module,
            Err(error) => {
                let _ = ready.send(Err(error.to_string()));
                return;
            }
        };
        let class_name = w!("AtkBatteryMessageWindow");
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: HINSTANCE(module.0),
            lpszClassName: class_name,
            ..Default::default()
        };
        if unsafe { RegisterClassW(&window_class) } == 0 {
            let _ = ready.send(Err("Windows 消息窗口类注册失败".to_owned()));
            return;
        }
        let reference = Box::into_raw(Box::new(app)) as *const std::ffi::c_void;
        let window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                class_name,
                w!("ATK Battery Events"),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(HINSTANCE(module.0)),
                Some(reference),
            )
        };
        let window = match window {
            Ok(window) => window,
            Err(error) => {
                unsafe {
                    drop(Box::from_raw(reference as *mut AppHandle));
                }
                let _ = ready.send(Err(error.to_string()));
                return;
            }
        };
        hwnd_slot.store(window.0 as isize, Ordering::Release);
        let _ = ready.send(Ok(()));
        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
            unsafe {
                DispatchMessageW(&message);
            }
        }
        hwnd_slot.store(0, Ordering::Release);
    }
}

#[cfg(target_os = "windows")]
pub use platform::WindowsIntegration;

#[cfg(not(target_os = "windows"))]
pub struct WindowsIntegration;

#[cfg(not(target_os = "windows"))]
impl WindowsIntegration {
    pub fn start(_app: tauri::AppHandle) -> Result<Self, String> {
        Ok(Self)
    }
}
