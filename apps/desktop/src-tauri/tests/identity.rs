//! Rename to Liber Linteum: the shipped name and bundle id.

use liber_desktop::legacy_dirs::LEGACY_IDENTIFIER;

#[test]
fn identity_matches_the_rename() {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(conf["productName"], "Liber Linteum");
    assert_eq!(conf["identifier"], "app.liberlinteum.desktop");
    assert_ne!(conf["identifier"], LEGACY_IDENTIFIER);
    assert_eq!(conf["app"]["windows"][0]["title"], "Liber Linteum");
}
