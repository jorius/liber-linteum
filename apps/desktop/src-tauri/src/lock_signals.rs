//! Lock signals (E3, spec §6.2): the OS tells the app the machine slept or the
//! screen locked, and the front end locks the encrypted vault in answer.
//!
//! `vault:lock-request { reason }` goes to the `main` window only, and only
//! while an encrypted session is open.
//! - Sleep, every OS: a 5 s tick compares the wall clock to the expected time;
//!   a jump of more than 30 s means the machine slept ([`slept`]).
//! - Screen lock, macOS: `com.apple.screenIsLocked` on the distributed
//!   notification center.
//! - Screen lock, Windows: polled every 5 s; a locked session has no input
//!   desktop.
//! - Linux: sleep detection only (no portable screen-lock signal).

use std::time::{Duration, SystemTime};

const TICK: Duration = Duration::from_secs(5);
const SLEEP_GAP: Duration = Duration::from_secs(30);
pub const LOCK_REQUEST_EVENT: &str = "vault:lock-request";

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum Reason {
    Sleep,
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    ScreenLock,
}

#[derive(Clone, serde::Serialize)]
struct Payload {
    reason: Reason,
}

/// Whether the wall clock jumped well past `expected` (a backwards jump is
/// not a sleep).
fn slept(expected: SystemTime, now: SystemTime) -> bool {
    now.duration_since(expected).is_ok_and(|d| d > SLEEP_GAP)
}

fn request<R: tauri::Runtime>(app: &tauri::AppHandle<R>, reason: Reason) {
    use tauri::{Emitter, Manager};
    let open = app
        .try_state::<crate::state::AppState>()
        .and_then(|s| s.session().ok())
        .is_some_and(|s| s.vault().encrypted().is_some());
    if open {
        let _ = app.emit_to("main", LOCK_REQUEST_EVENT, Payload { reason });
    }
}

/// Starts every signal once. The thread is detached: it never blocks exit.
pub fn start<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    mac::observe(&app);
    let spawned = std::thread::Builder::new()
        .name("lock-signals".into())
        .spawn(move || {
            #[cfg(windows)]
            let mut was_locked = false;
            loop {
                let expected = SystemTime::now() + TICK;
                std::thread::sleep(TICK);
                if slept(expected, SystemTime::now()) {
                    request(&app, Reason::Sleep);
                }
                #[cfg(windows)]
                {
                    let locked = win::locked();
                    if locked && !was_locked {
                        request(&app, Reason::ScreenLock);
                    }
                    was_locked = locked;
                }
            }
        });
    drop(spawned);
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_SWITCHDESKTOP, OpenInputDesktop,
    };

    /// A locked session has no input desktop to open.
    pub fn locked() -> bool {
        // SAFETY: plain Win32 calls; a non-null handle is closed at once.
        unsafe {
            let desktop = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
            if desktop.is_null() {
                return true;
            }
            CloseDesktop(desktop);
            false
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Reason;
    use objc2::declare::ClassBuilder;
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::{class, msg_send, sel};
    use std::sync::OnceLock;

    static APP: OnceLock<tauri::AppHandle<tauri::Wry>> = OnceLock::new();

    extern "C" fn screen_locked(_this: &AnyObject, _sel: Sel, _note: *mut AnyObject) {
        if let Some(app) = APP.get() {
            super::request(app, Reason::ScreenLock);
        }
    }

    /// Observes `com.apple.screenIsLocked`; the center keeps the observer.
    pub fn observe<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
        // shortcut: only the real (Wry) runtime observes; mock-runtime tests skip it.
        let Some(app) = (app as &dyn std::any::Any).downcast_ref::<tauri::AppHandle<tauri::Wry>>()
        else {
            return;
        };
        if APP.set(app.clone()).is_err() {
            return;
        }
        let Some(mut builder) = ClassBuilder::new(c"LiberScreenLockObserver", class!(NSObject))
        else {
            return;
        };
        // SAFETY: the IMP matches `- (void)screenLocked:(NSNotification *)`.
        unsafe {
            builder.add_method(sel!(screenLocked:), screen_locked as extern "C" fn(_, _, _));
        }
        let cls: &AnyClass = builder.register();
        // SAFETY: standard Foundation calls; the observer is leaked on purpose.
        unsafe {
            let observer: *mut AnyObject = msg_send![cls, new];
            let name: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c"com.apple.screenIsLocked".as_ptr()];
            let center: *mut AnyObject =
                msg_send![class!(NSDistributedNotificationCenter), defaultCenter];
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![center, addObserver: observer, selector: sel!(screenLocked:), name: name, object: nil];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slept_detects_a_jump() {
        let t = SystemTime::now();
        assert!(!slept(t, t + Duration::from_secs(6)));
        assert!(slept(t, t + Duration::from_secs(40)));
        assert!(
            !slept(t, t - Duration::from_secs(10)),
            "backwards is not a sleep"
        );
    }
}
