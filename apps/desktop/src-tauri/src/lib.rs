pub mod commands;
pub mod error;
pub mod settings;
pub mod state;

/// Registers everything the app exposes to the webview. Shared by `run()` and the
/// IPC integration tests so the tests exercise the real command registration.
pub fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![commands::app_info])
}

pub fn run() {
    configure(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running Notes In My Way");
}
