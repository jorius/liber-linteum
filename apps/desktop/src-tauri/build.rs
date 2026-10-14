/// Every command the webview may call. Each also needs an `allow-<name>`
/// permission in `capabilities/main.json` (kebab-case).
const COMMANDS: &[&str] = &[
    "app_info",
    "vault_open",
    "vault_create",
    "vault_close",
    "vault_tree",
    "page_get",
    "backlink_count",
    "entry_create_page",
    "entry_create_folder",
    "entry_rename",
    "entry_trash",
    "settings_get",
    "settings_set",
    "vaults_recent",
    "vaults_forget",
    "page_read",
    "page_write",
    "page_create_conflict_copy",
    "links_resolve",
    "url_open",
    "file_open_external",
    "fonts_list",
    "vault_settings_get",
    "vault_settings_set",
    "attachment_paste",
    "attachment_import",
    "cover_pick",
    "link_suggest",
    "gv_children",
    "gv_edges",
    "layout_get",
    "layout_set",
    "link_target",
    "index_pick_set",
    "page_width_set",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
