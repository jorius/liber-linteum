# Custom title bar (Linux and Windows) — design

> **Status:** built on `feat/custom-titlebar` · **Date:** 2026-10-21
> **Why:** on macOS the app has a native menu bar (Liber Linteum, File, Vault, Edit, View, Window). Linux and Windows had none: only the vault-name button in the sidebar reached Settings, Open, Encrypt and Close. Jose picked option B of three mockups (a strip under the system title bar; the app drawing its own title bar with the menus in it; a ☰ button in the sidebar).

## 1. Where it applies

Everywhere but macOS (`ownTitleBar()`: `navigator.platform` / user agent not Mac). macOS keeps the system frame and its native app menu, unchanged.

The window is frameless there: `decorations: false` for the main window (`tauri.linux.conf.json`, `tauri.windows.conf.json`, which replace `app.windows`) and for single-file windows (`file_windows.rs`). Edge resizing of a frameless window is Tauri's (`tauri-runtime-wry` `undecorated_resizing`, Linux and Windows).

## 2. The bar

One 38 px row (`--titlebar-height`) in the sidebar's colours, fixed at the top of every screen (Welcome, Unlock, the shell, single-file windows) and above dialogs (z-index 50; the highest elsewhere is 40). `html[data-titlebar]` pads the body so screens sit below it.

- **Left:** the menus (§3).
- **Middle:** the page's title. `useWindowTitle` mirrors the window title into `document.title`; file windows set it to the file name. The bar follows `document.title`.
- **Right:** Minimize, Maximize/Restore, Close. GNOME-style round buttons on Linux, flat full-height buttons with a red Close hover on Windows.
- A press on the bar (not a button) moves the window (`window_start_drag`); a double click maximizes it. Close sends a close request (`window_close_request`), so the page saves first exactly as with the system's button.

## 3. The menus

`features/titlebar/menus.ts` mirrors `src-tauri/src/menu.rs` item for item. Labels are the app's i18n strings (sentence case, English and Spanish), not the macOS menu's English Title Case.

- Items with a macOS `id` call **`menu_activate(id)`**, which runs the same Rust dispatch as the native menu (`menu::activate`), targeting the calling window. Quit, window targeting and focusing the main window therefore behave as on macOS. A test checks every id exists in `menu.rs`.
- **Edit** (§3.3) acts on what had the keyboard when the menu opened. The pointer never takes focus from the editor (menu buttons `preventDefault` on mousedown). In CodeMirror, Undo/Redo/Select All dispatch the editor's own keys (Ctrl+Z, Ctrl+Y, Ctrl+A), so its keymaps run. Cut/Copy use `execCommand`. Paste uses WebKitGTK's own Paste editing command on Linux (`window_paste`), and the clipboard API elsewhere.
- **Window:** Minimize, Maximize/Restore, Close window. **View → Full screen** is F11.
- **About** opens a small dialog (name, version, tagline, licence, credits); macOS shows its standard panel.
- Enabled state follows the vault: Encrypt "<vault>"… only for an open plain vault, Lock only for an encrypted one, and the vault-only View items only with a vault open. Toggles show a check when on.
- Single-file windows: no Vault menu. View has only the editor toggles and Full screen.

**Keyboard:** F10 opens the first menu with the keyboard in it; arrows move between items and menus; Enter or Space runs an item; Escape closes and gives the keyboard back. The page also answers the keys only the macOS menu had: **Ctrl+Q** (quit), **Alt+Ctrl+W** (close vault) and **F11**.

## 4. Security

The new commands act on the calling window only, like `window_close_self`; the window plugin is still not granted. Both capability files list them.

## 5. Not done / later

- No window shadow or rounded corners on GNOME (a transparent window with CSS corners could add them).
- The GNOME button layout setting (buttons on the left) isn't read; the buttons are always on the right.
- Windows is built but unverified on a real machine.
