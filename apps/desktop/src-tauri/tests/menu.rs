//! The app menu (M2a §3.3 quit flush, final review I1). macOS's predefined
//! Quit (⌘Q) terminates the app without a `CloseRequested`, skipping the UI's
//! save-before-close guard. Our menu's Quit closes the windows instead, so it
//! goes through the same close request as the window's close button.
//!
//! `harness = false`: muda menus can only be created on the main thread, so
//! the checks run one after the other from `main`.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuEvent, MenuId, MenuItemKind};
use tauri::test::{MockRuntime, mock_builder};
use tauri::{App, Manager, RunEvent, WindowEvent};

/// The app exactly as `run()` builds it (plus the menu on macOS), on the mock
/// runtime; its main window comes from tauri.conf.json.
fn build_app(tag: &str) -> App<MockRuntime> {
    let dirs = nimw_desktop::AppDirs {
        config: std::env::temp_dir().join(format!("nimw-menu-{tag}-cfg-{}", std::process::id())),
        cache: std::env::temp_dir().join(format!("nimw-menu-{tag}-cache-{}", std::process::id())),
    };
    nimw_desktop::menu::with_app_menu(nimw_desktop::configure(mock_builder(), Some(dirs)))
        .build(tauri::generate_context!())
        .expect("failed to build app with the real context")
}

type Entry = (&'static str, String, String);

/// (submenu text, [(item kind, id, text)]) for every top-level submenu.
fn outline(menu: &Menu<MockRuntime>) -> Vec<(String, Vec<Entry>)> {
    menu.items()
        .unwrap()
        .into_iter()
        .filter_map(|item| match item {
            MenuItemKind::Submenu(sub) => Some((
                sub.text().unwrap(),
                sub.items()
                    .unwrap()
                    .into_iter()
                    .map(|i| match i {
                        MenuItemKind::MenuItem(m) => ("item", m.id().0.clone(), m.text().unwrap()),
                        MenuItemKind::Predefined(p) => (
                            "predefined",
                            p.id().0.clone(),
                            p.text().unwrap().replace('&', ""),
                        ),
                        other => ("other", other.id().0.clone(), String::new()),
                    })
                    .collect(),
            )),
            _ => None,
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_menu_quit_is_ours_and_the_standard_items_stay() {
    let found: Rc<RefCell<Option<Menu<MockRuntime>>>> = Rc::default();
    let slot = found.clone();
    build_app("outline").run_return(move |handle, event| {
        if let RunEvent::Ready = event {
            *slot.borrow_mut() = handle.menu();
            // Stop the loop: closing the last window ends the run.
            for window in handle.webview_windows().into_values() {
                window.close().unwrap();
            }
        }
    });
    let menu = found.borrow().clone().expect("the app has a menu on macOS");
    let outline = outline(&menu);
    let all: Vec<_> = outline.iter().flat_map(|(_, items)| items.iter()).collect();

    // No predefined Quit (it would bypass the close guard)...
    assert!(
        !all.iter()
            .any(|(kind, _, text)| *kind == "predefined" && text.starts_with("Quit")),
        "predefined Quit found: {outline:?}"
    );
    // ...but our own, in the app menu.
    let (_, app_items) = &outline[0];
    assert!(
        app_items.iter().any(|(kind, id, text)| *kind == "item"
            && id == nimw_desktop::menu::QUIT_ID
            && text == "Quit Notes In My Way"),
        "custom Quit missing from the app menu: {outline:?}"
    );
    let app_texts: Vec<&String> = app_items.iter().map(|(_, _, t)| t).collect();
    for want in ["About", "Hide", "Hide Others", "Show All"] {
        assert!(
            app_texts.iter().any(|t| t.starts_with(want)),
            "{want} missing from the app menu: {app_texts:?}"
        );
    }
    let texts = |name: &str| -> Vec<String> {
        outline
            .iter()
            .find(|(t, _)| t == name)
            .unwrap_or_else(|| panic!("no {name} menu: {outline:?}"))
            .1
            .iter()
            .map(|(_, _, t)| t.clone())
            .filter(|t| !t.is_empty())
            .collect()
    };
    // Text editing shortcuts (⌘Z, ⌘C, ⌘V, …) come from the Edit menu on macOS.
    assert_eq!(
        texts("Edit"),
        ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]
    );
    // M2b §3: Back / Forward along the link trail (⌘[ / ⌘] are handled by the
    // page itself, so the items carry no accelerator).
    let view = texts("View");
    for want in [
        "Back",
        "Forward",
        "Toggle Formatting Toolbar",
        "Toggle Line Numbers",
        "Toggle Outline",
        "Editor",
        "Global View",
        "See Atoms of This Page",
    ] {
        assert!(view.iter().any(|t| t == want), "{want}: {view:?}");
    }
    let window = texts("Window");
    for want in ["Minimize", "Zoom", "Close Window"] {
        assert!(window.iter().any(|t| t == want), "{want}: {window:?}");
    }
}

fn quit_menu_item_requests_the_window_close_like_the_close_button() {
    let seen: Rc<RefCell<Vec<String>>> = Rc::default();
    let log = seen.clone();
    let timed_out = Arc::new(AtomicBool::new(false));
    let flag = timed_out.clone();
    build_app("quit").run_return(move |handle, event| match event {
        RunEvent::Ready => {
            // If Quit does nothing, end the run anyway (and fail below).
            let watchdog = handle.clone();
            let flag = flag.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                flag.store(true, Ordering::SeqCst);
                for window in watchdog.webview_windows().into_values() {
                    let _ = window.destroy();
                }
            });
            nimw_desktop::menu::on_menu_event(
                handle,
                MenuEvent {
                    id: MenuId::new(nimw_desktop::menu::QUIT_ID),
                },
            );
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { .. },
            ..
        } => log.borrow_mut().push(format!("close-requested:{label}")),
        RunEvent::ExitRequested { .. } => log.borrow_mut().push("exit-requested".into()),
        _ => {}
    });
    assert!(
        !timed_out.load(Ordering::SeqCst),
        "Quit did not close the window"
    );
    // The close request reaches the window first (where the UI's guard saves
    // pending pages and may keep it open); the app exits only once it closed.
    assert_eq!(
        *seen.borrow(),
        ["close-requested:main".to_string(), "exit-requested".into()]
    );
}

/// M2b §3: View → Back / Forward tell the page to walk the link trail.
fn back_and_forward_items_emit_menu_navigate() {
    use tauri::Listener;
    let got: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let log = got.clone();
    build_app("navigate").run_return(move |handle, event| {
        if let RunEvent::Ready = event {
            let log = log.clone();
            handle.listen("menu:navigate", move |e| {
                log.lock().unwrap().push(e.payload().to_string());
            });
            for id in [nimw_desktop::menu::BACK_ID, nimw_desktop::menu::FORWARD_ID] {
                nimw_desktop::menu::on_menu_event(
                    handle,
                    MenuEvent {
                        id: MenuId::new(id),
                    },
                );
            }
            for window in handle.webview_windows().into_values() {
                window.close().unwrap();
            }
        }
    });
    assert_eq!(
        *got.lock().unwrap(),
        ["\"back\"".to_string(), "\"forward\"".into()]
    );
}

/// M2b feedback round: View → Toggle Formatting Toolbar / Toggle Line Numbers
/// (and Toggle Outline, M4b part 2 §5) tell the page which setting to flip.
fn toggle_items_emit_menu_toggle() {
    use tauri::Listener;
    let got: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let log = got.clone();
    build_app("toggle").run_return(move |handle, event| {
        if let RunEvent::Ready = event {
            let log = log.clone();
            handle.listen("menu:toggle", move |e| {
                log.lock().unwrap().push(e.payload().to_string());
            });
            for id in [
                nimw_desktop::menu::TOOLBAR_ID,
                nimw_desktop::menu::LINE_NUMBERS_ID,
                nimw_desktop::menu::OUTLINE_ID,
            ] {
                nimw_desktop::menu::on_menu_event(
                    handle,
                    MenuEvent {
                        id: MenuId::new(id),
                    },
                );
            }
            for window in handle.webview_windows().into_values() {
                window.close().unwrap();
            }
        }
    });
    assert_eq!(
        *got.lock().unwrap(),
        [
            "\"toolbar\"".to_string(),
            "\"lineNumbers\"".into(),
            "\"outline\"".into()
        ]
    );
}

/// M3a §2: View → Editor / Global View tell the page which screen to show;
/// M4b part 3 §6: See Atoms of This Page, the open page's atoms.
fn screen_items_emit_menu_screen() {
    use tauri::Listener;
    let got: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let log = got.clone();
    build_app("screen").run_return(move |handle, event| {
        if let RunEvent::Ready = event {
            let log = log.clone();
            handle.listen("menu:screen", move |e| {
                log.lock().unwrap().push(e.payload().to_string());
            });
            for id in [
                nimw_desktop::menu::EDITOR_ID,
                nimw_desktop::menu::GLOBAL_VIEW_ID,
                nimw_desktop::menu::ATOMS_ID,
            ] {
                nimw_desktop::menu::on_menu_event(
                    handle,
                    MenuEvent {
                        id: MenuId::new(id),
                    },
                );
            }
            for window in handle.webview_windows().into_values() {
                window.close().unwrap();
            }
        }
    });
    assert_eq!(
        *got.lock().unwrap(),
        [
            "\"edit\"".to_string(),
            "\"global\"".into(),
            "\"atoms\"".into()
        ]
    );
}

fn main() {
    #[cfg(target_os = "macos")]
    {
        macos_menu_quit_is_ours_and_the_standard_items_stay();
        println!("test macos_menu_quit_is_ours_and_the_standard_items_stay ... ok");
    }
    quit_menu_item_requests_the_window_close_like_the_close_button();
    println!("test quit_menu_item_requests_the_window_close_like_the_close_button ... ok");
    back_and_forward_items_emit_menu_navigate();
    println!("test back_and_forward_items_emit_menu_navigate ... ok");
    toggle_items_emit_menu_toggle();
    println!("test toggle_items_emit_menu_toggle ... ok");
    screen_items_emit_menu_screen();
    println!("test screen_items_emit_menu_screen ... ok");
}
