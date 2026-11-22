use crate::{
    models::WindowPosition,
    state::{save_preferences, AppState},
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Dwm::{DwmFlush, DwmIsCompositionEnabled},
    Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromRect, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        MONITOR_DEFAULTTONULL,
    },
    UI::{
        HiDpi::GetDpiForWindow,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::*,
    },
};

const TIMER: usize = 0x41544b;
const CONFIGURE: u32 = WM_APP + 0x451;
const FRAME: u32 = CONFIGURE + 1;
const FRAME_TIMER: usize = TIMER + 1;
const DURATION: Duration = Duration::from_millis(150);
static NEXT_CLOCK: AtomicUsize = AtomicUsize::new(1);
type Pos = (i32, i32);

#[derive(Clone, Copy)]
struct Exposed {
    left: bool,
    right: bool,
    top: bool,
}

fn snapped(r: RECT, work: RECT, distance: i32, exposed: Exposed) -> Pos {
    let reaches = |gap: i32, open| (0..=distance).contains(&gap) || (gap < 0 && open);
    let x = if reaches(r.left - work.left, exposed.left) {
        work.left
    } else if reaches(work.right - r.right, exposed.right) {
        work.right - (r.right - r.left)
    } else {
        r.left
    };
    let y = if reaches(r.top - work.top, exposed.top) {
        work.top
    } else if (work.bottom - r.bottom).abs() <= distance {
        work.bottom - (r.bottom - r.top)
    } else {
        r.top
    };
    (x, y)
}

// 用物理屏幕边缘探测邻屏，工作区边缘可能隔着任务栏。
fn exposed(r: RECT, screen: RECT) -> Exposed {
    let open = |probe: RECT| {
        unsafe { MonitorFromRect(&probe, MONITOR_DEFAULTTONULL) }
            .0
            .is_null()
    };
    Exposed {
        left: open(RECT {
            left: screen.left - 1,
            right: screen.left,
            ..r
        }),
        right: open(RECT {
            left: screen.right,
            right: screen.right + 1,
            ..r
        }),
        top: open(RECT {
            top: screen.top - 1,
            bottom: screen.top,
            ..r
        }),
    }
}

#[derive(Clone, Copy)]
struct Dock {
    home: Pos,
    away: Pos,
}

#[derive(Clone, Copy)]
struct Animation {
    start: Instant,
    from: f64,
    to: f64,
}

impl Animation {
    fn sample(self, now: Instant) -> f64 {
        let t = now.duration_since(self.start).as_secs_f64() / DURATION.as_secs_f64();
        if t >= 1. {
            self.to
        } else {
            self.from + (self.to - self.from) * (1. - (1. - t).powi(3))
        }
    }
}

struct FrameClock {
    id: usize,
    resume: Option<mpsc::Sender<()>>,
}

impl FrameClock {
    fn start(hwnd: HWND) -> Result<Self, String> {
        let id = NEXT_CLOCK.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        let handle = hwnd.0 as usize;
        let worker = thread::Builder::new()
            .name("overlay-vsync".into())
            .spawn(move || {
                let hwnd = HWND(handle as _);
                let composed = unsafe { DwmIsCompositionEnabled() }.is_ok_and(|v| v.as_bool());
                loop {
                    let fallback = !composed || unsafe { DwmFlush() }.is_err();
                    if let Err(e) = unsafe {
                        PostMessageW(Some(hwnd), FRAME, WPARAM(id), LPARAM(fallback as isize))
                    } {
                        if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                            eprintln!("贴边动画帧投递失败：{e}");
                        }
                        break;
                    }
                    // 只允许一帧在途。停止动画会释放发送端，使等待中的线程退出。
                    if fallback || rx.recv().is_err() {
                        break;
                    }
                }
            });
        let mut clock = Self {
            id,
            resume: Some(tx),
        };
        if let Err(e) = worker {
            eprintln!("贴边动画改用定时器：{e}");
            clock.fallback(hwnd)?;
        }
        Ok(clock)
    }
    fn fallback(&mut self, hwnd: HWND) -> Result<(), String> {
        if unsafe { SetTimer(Some(hwnd), FRAME_TIMER, 1, None) } == 0 {
            return Err("动画定时器创建失败".into());
        }
        self.resume = None;
        Ok(())
    }
}

struct Edge {
    app: AppHandle,
    dock: Cell<Option<Dock>>,
    moving: Cell<bool>,
    menu: Cell<bool>,
    internal: Cell<bool>,
    frame: Cell<Option<Pos>>,
    outside: Cell<Option<Instant>>,
    fraction: Cell<f64>,
    animation: Cell<Option<Animation>>,
    clock: RefCell<Option<FrameClock>>,
    interval: Cell<u32>,
}

fn bounds(hwnd: HWND) -> Result<RECT, String> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut r) }.map_err(|e| e.to_string())?;
    Ok(r)
}
fn monitor(hwnd: HWND) -> Result<MONITORINFO, String> {
    let mut m = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as _,
        ..Default::default()
    };
    unsafe { GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut m).ok() }
        .map_err(|e| e.to_string())?;
    Ok(m)
}
fn scale(hwnd: HWND) -> f64 {
    f64::from(unsafe { GetDpiForWindow(hwnd) }).max(96.) / 96.
}

fn dock(hwnd: HWND) -> Result<Option<Dock>, String> {
    let r = bounds(hwnd)?;
    let m = monitor(hwnd)?;
    let w = m.rcWork;
    let screen = m.rcMonitor;
    let home = (r.left, r.top);
    let strip = (14. * scale(hwnd)).round() as i32;
    let open = exposed(r, screen);
    let away = if open.left && r.left == w.left {
        (screen.left - (r.right - r.left) + strip, r.top)
    } else if open.right && r.right == w.right {
        (screen.right - strip, r.top)
    } else if open.top && r.top == w.top {
        (r.left, screen.top - (r.bottom - r.top) + strip)
    } else {
        return Ok(None);
    };
    Ok(Some(Dock { home, away }))
}

impl Edge {
    fn timer(&self, hwnd: HWND, ms: u32) -> Result<(), String> {
        if self.interval.get() != ms {
            if ms == 0 {
                unsafe { KillTimer(Some(hwnd), TIMER) }.map_err(|e| e.to_string())?;
            } else if unsafe { SetTimer(Some(hwnd), TIMER, ms, None) } == 0 {
                return Err("贴边定时器创建失败".into());
            }
            self.interval.set(ms);
        }
        Ok(())
    }
    fn place(&self, hwnd: HWND, p: Pos) -> Result<(), String> {
        // SetWindowPos 同步重入子类过程；动画位置只用于绘制，不参与位置记忆。
        self.internal.set(true);
        let result = unsafe {
            SetWindowPos(
                hwnd,
                None,
                p.0,
                p.1,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
        self.internal.set(false);
        if result.is_ok() {
            self.frame.set(Some(p));
        }
        result.map_err(|e| e.to_string())
    }
    fn reveal(&self, hwnd: HWND) -> Result<(), String> {
        self.stop_animation(hwnd)?;
        if self.fraction.replace(0.) != 0. {
            if let Some(d) = self.dock.get() {
                self.place(hwnd, d.home)?;
            }
        }
        self.outside.set(None);
        Ok(())
    }
    fn configure(&self, hwnd: HWND) -> Result<(), String> {
        let enabled = self.app.state::<AppState>().preferences().edge_auto_hide
            && !self.moving.get()
            && !self.menu.get()
            && unsafe { IsWindowVisible(hwnd) }.as_bool();
        self.dock.set(if enabled { dock(hwnd)? } else { None });
        self.outside.set(None);
        self.timer(hwnd, if self.dock.get().is_some() { 80 } else { 0 })
    }
    fn tick(&self, hwnd: HWND) -> Result<(), String> {
        if self.dock.get().is_none() {
            return Ok(());
        }
        let mut p = POINT::default();
        unsafe { GetCursorPos(&mut p) }.map_err(|e| e.to_string())?;
        let r = bounds(hwnd)?;
        let inside = p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
        let now = Instant::now();
        let hide = if inside {
            self.outside.set(None);
            false
        } else {
            let since = self.outside.get().unwrap_or(now);
            self.outside.set(Some(since));
            now.duration_since(since) >= Duration::from_millis(800)
        };
        let target = if hide { 1.0 } else { 0.0 };
        if self.animation.get().map_or(self.fraction.get(), |a| a.to) != target {
            if self.clock.borrow().is_none() {
                *self.clock.borrow_mut() = Some(FrameClock::start(hwnd)?);
            }
            self.animation.set(Some(Animation {
                start: now,
                from: self.fraction.get(),
                to: target,
            }));
        }
        Ok(())
    }

    fn stop_animation(&self, hwnd: HWND) -> Result<(), String> {
        self.animation.set(None);
        if self
            .clock
            .borrow_mut()
            .take()
            .is_some_and(|c| c.resume.is_none())
        {
            unsafe { KillTimer(Some(hwnd), FRAME_TIMER) }.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn render_frame(&self, hwnd: HWND) -> Result<(), String> {
        let (Some(a), Some(d)) = (self.animation.get(), self.dock.get()) else {
            return Ok(());
        };
        let next = a.sample(Instant::now());
        let interp =
            |from: i32, to: i32| (from as f64 + f64::from(to - from) * next).round() as i32;
        let p = (interp(d.home.0, d.away.0), interp(d.home.1, d.away.1));
        if self.frame.get() != Some(p) {
            self.place(hwnd, p)?;
        }
        self.fraction.set(next);
        if next == a.to {
            self.stop_animation(hwnd)?;
        }
        Ok(())
    }

    fn vsync(&self, hwnd: HWND, id: usize, fallback: bool) -> Result<(), String> {
        // 反复隐藏或重建 HWND 后，队列里仍可能有旧线程的最后一帧。
        if self.clock.borrow().as_ref().is_none_or(|c| c.id != id) {
            return Ok(());
        }
        self.render_frame(hwnd)?;
        if let Some(clock) = self.clock.borrow_mut().as_mut().filter(|c| c.id == id) {
            if fallback {
                clock.fallback(hwnd)?;
            } else if let Some(tx) = &clock.resume {
                tx.send(()).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    fn remember(&self, hwnd: HWND) -> Result<(), String> {
        let r = bounds(hwnd)?;
        let scale = scale(hwnd);
        let p = self
            .app
            .state::<AppState>()
            .set_overlay_position(WindowPosition {
                x: (r.left as f64 / scale).round() as i32,
                y: (r.top as f64 / scale).round() as i32,
                scale_factor: Some(scale),
            });
        save_preferences(&self.app, &p)
    }
    fn event(&self, hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> Result<(), String> {
        if self.internal.get() {
            return Ok(());
        }
        match msg {
            WM_ENTERMENULOOP | WM_ENTERSIZEMOVE => {
                if msg == WM_ENTERMENULOOP {
                    self.menu.set(true)
                } else {
                    self.moving.set(true)
                }
                self.reveal(hwnd)?;
                self.timer(hwnd, 0)
            }
            WM_EXITMENULOOP => {
                self.menu.set(false);
                self.configure(hwnd)
            }
            WM_EXITSIZEMOVE => {
                self.moving.set(false);
                let r = bounds(hwnd)?;
                let m = monitor(hwnd)?;
                let dest = snapped(
                    r,
                    m.rcWork,
                    (16. * scale(hwnd)).round() as i32,
                    exposed(r, m.rcMonitor),
                );
                if dest != (r.left, r.top) {
                    self.place(hwnd, dest)?;
                }
                self.remember(hwnd)?;
                self.configure(hwnd)
            }
            CONFIGURE | WM_DISPLAYCHANGE => {
                self.reveal(hwnd)?;
                self.configure(hwnd)
            }
            WM_WINDOWPOSCHANGED if !self.moving.get() => {
                let flags = unsafe { (*(l.0 as *const WINDOWPOS)).flags };
                // DestroyWindow 也会先发隐藏通知，此时 SetWindowPos 返回参数错误；
                // 隐藏时只停掉动画，保留停靠信息，再次显示时由 reveal 移回原位。
                if flags.contains(SWP_HIDEWINDOW) {
                    self.stop_animation(hwnd)?;
                    self.outside.set(None);
                    return self.timer(hwnd, 0);
                }
                if !flags.contains(SWP_NOMOVE) {
                    let r = bounds(hwnd)?;
                    let pos = (r.left, r.top);
                    if self.frame.get() != Some(pos) || self.fraction.get() == 0. {
                        self.fraction.set(0.);
                        self.remember(hwnd)?;
                    }
                }
                if !flags.contains(SWP_NOMOVE | SWP_NOSIZE) || flags.contains(SWP_SHOWWINDOW) {
                    self.reveal(hwnd)?;
                    self.configure(hwnd)?;
                }
                Ok(())
            }
            FRAME => self.vsync(hwnd, w.0, l.0 != 0),
            WM_TIMER if w.0 == FRAME_TIMER => {
                if self
                    .clock
                    .borrow()
                    .as_ref()
                    .is_some_and(|c| c.resume.is_none())
                {
                    self.render_frame(hwnd)?;
                }
                Ok(())
            }
            WM_TIMER if w.0 == TIMER && self.interval.get() != 0 => self.tick(hwnd),
            _ => Ok(()),
        }
    }
}

unsafe extern "system" fn proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(proc), id);
            drop(Rc::from_raw(data as *const Edge));
        }
    } else {
        // 原生窗口操作可能重入甚至销毁窗口；本次回调保留独立引用。
        let edge = unsafe {
            Rc::increment_strong_count(data as *const Edge);
            Rc::from_raw(data as *const Edge)
        };
        if let Err(e) = edge.event(hwnd, msg, w, l) {
            eprintln!("悬浮窗贴边处理失败：{e}");
            if msg == FRAME || msg == WM_TIMER && w.0 == FRAME_TIMER {
                if let Err(e) = edge.stop_animation(hwnd) {
                    eprintln!("贴边动画停止失败：{e}");
                }
            }
            if msg == CONFIGURE {
                return LRESULT(-1);
            }
        }
        if msg == CONFIGURE || msg == FRAME || msg == WM_TIMER && matches!(w.0, TIMER | FRAME_TIMER)
        {
            return LRESULT(0);
        }
    }
    unsafe { DefSubclassProc(hwnd, msg, w, l) }
}

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let app = window.app_handle().clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let edge = Rc::into_raw(Rc::new(Edge {
                app,
                dock: Cell::new(None),
                moving: Cell::new(false),
                menu: Cell::new(false),
                internal: Cell::new(false),
                frame: Cell::new(None),
                outside: Cell::new(None),
                fraction: Cell::new(0.),
                animation: Cell::new(None),
                clock: RefCell::new(None),
                interval: Cell::new(0),
            }));
            let result = unsafe {
                SetWindowSubclass(HWND(hwnd as _), Some(proc), TIMER, edge as usize).ok()
            };
            if result.is_err() {
                unsafe { drop(Rc::from_raw(edge)) };
            }
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv()
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
pub fn reconfigure(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        if unsafe { SendMessageW(hwnd, CONFIGURE, None, None) }.0 == -1 {
            return Err("悬浮窗贴边状态更新失败".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const OPEN: Exposed = Exposed {
        left: true,
        right: true,
        top: true,
    };
    fn snap(x: i32, y: i32, edges: Exposed) -> Pos {
        let work = RECT {
            left: -1600,
            top: 20,
            right: 0,
            bottom: 1020,
        };
        snapped(
            RECT {
                left: x,
                top: y,
                right: x + 200,
                bottom: y + 80,
            },
            work,
            24,
            edges,
        )
    }

    #[test]
    fn snaps_within_inclusive_scaled_threshold() {
        assert_eq!(snap(-1576, 44, OPEN), (-1600, 20));
        assert_eq!(snap(-224, 916, OPEN), (-200, 940));
        assert_eq!(snap(-1575, 45, OPEN), (-1575, 45));
        assert_eq!(snap(-600, 964, OPEN), (-600, 940));
    }
    #[test]
    fn pulls_back_over_exposed_edges_except_bottom() {
        assert_eq!(snap(-1690, -30, OPEN), (-1600, 20));
        assert_eq!(snap(-110, 980, OPEN), (-200, 980));
    }
    #[test]
    fn shared_edges_allow_crossing_but_still_snap_on_approach() {
        let shared = Exposed {
            left: false,
            right: false,
            top: false,
        };
        assert_eq!(snap(-1690, -30, shared), (-1690, -30));
        assert_eq!(snap(-110, 45, shared), (-110, 45));
        assert_eq!(snap(-199, 19, shared), (-199, 19));
        assert_eq!(snap(-201, 21, shared), (-200, 20));
    }
    #[test]
    fn reversal_starts_at_last_drawn_position_and_finishes_after_150ms() {
        let start = Instant::now();
        let out = Animation {
            start,
            from: 0.,
            to: 1.,
        };
        let mid = start + Duration::from_millis(75);
        let current = out.sample(mid);
        assert_eq!(current, 0.875);
        let back = Animation {
            start: mid,
            from: current,
            to: 0.,
        };
        assert_eq!(back.sample(mid), current);
        assert!(back.sample(mid + Duration::from_millis(10)) < current);
        assert_eq!(back.sample(mid + DURATION), 0.);
        assert_eq!(out.sample(start + DURATION * 2), 1.);
    }
}
