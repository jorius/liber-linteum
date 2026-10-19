//! Dock Quit, logout and shutdown (M5b final review I2).
//!
//! macOS asks the app delegate `applicationShouldTerminate:` before any quit
//! that isn't our own Quit item (the Dock's Quit, logout, shutdown). tao's
//! delegate doesn't implement it, so AppKit terminates at once: no window gets
//! a close request, and with auto save off every unsaved page was dropped.
//!
//! With auto save off the delegate now answers "cancel" and quits the way our
//! Quit item does ([`crate::menu::request_quit`]): each window's close request
//! runs the Save / Don't Save / Cancel prompt, and the app exits when the last
//! window is gone. With auto save on nothing changes (the M2a ≤ 500 ms limit).
//! Cost: a logout with auto save off is cancelled once by the app, which then
//! quits; the user logs out again. The same holds while a clip is being
//! recorded, whatever the setting (batch 6 review C1).

/// Whether a system quit must go through the windows' close requests first:
/// with auto save off, or while a clip is being recorded (its take is
/// stopped and inserted there, batch 6 review C1).
pub fn must_ask(auto_save: bool, recording: bool) -> bool {
    !auto_save || recording
}

#[cfg(target_os = "macos")]
pub use mac::install;

/// No-op off macOS: Windows and Linux quits reach the windows' close requests.
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
mod mac {
    use crate::state::AppState;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, ffi, msg_send, sel};
    use std::sync::OnceLock;
    use tauri::Manager;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    const TERMINATE_CANCEL: usize = 0; // NSTerminateCancel
    const TERMINATE_NOW: usize = 1; // NSTerminateNow

    unsafe extern "C-unwind" fn should_terminate(
        _this: *mut AnyObject,
        _sel: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        let Some(app) = APP.get() else {
            return TERMINATE_NOW;
        };
        let auto_save = app
            .try_state::<AppState>()
            .is_none_or(|s| s.settings.get().0.auto_save);
        let recording = app
            .try_state::<crate::audio_commands::AudioState>()
            .is_some_and(|a| a.recording());
        if !super::must_ask(auto_save, recording) {
            return TERMINATE_NOW;
        }
        crate::menu::request_quit(app);
        TERMINATE_CANCEL
    }

    /// Adds `applicationShouldTerminate:` to tao's delegate class. Call once
    /// the event loop runs (`RunEvent::Ready`), when the delegate is set.
    pub fn install(app: &tauri::AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        let Some(cls) = AnyClass::get(c"TaoAppDelegateParent") else {
            return;
        };
        // SAFETY: the IMP matches `- (NSApplicationTerminateReply)
        // applicationShouldTerminate:(NSApplication *)sender` ("Q@:@").
        unsafe {
            let imp: Imp = std::mem::transmute(
                should_terminate as unsafe extern "C-unwind" fn(_, _, _) -> usize,
            );
            ffi::class_addMethod(
                (cls as *const AnyClass).cast_mut(),
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            );
            // Re-set the delegate so AppKit re-reads what it responds to.
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            let _: () = msg_send![ns_app, setDelegate: delegate];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::must_ask;

    #[test]
    fn m5b_final_i2_a_system_quit_asks_only_with_auto_save_off() {
        assert!(
            must_ask(false, false),
            "auto save off: the windows' prompt must run first"
        );
        assert!(
            !must_ask(true, false),
            "auto save on: quit at once, as before"
        );
    }

    #[test]
    fn b6_review_c1_a_system_quit_mid_take_goes_through_the_windows() {
        assert!(
            must_ask(true, true),
            "a take in progress is stopped and inserted before the app quits"
        );
    }
}
