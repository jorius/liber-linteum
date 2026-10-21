//! E3 planning ruling 2: the test-only features (tiny Argon2 parameters below
//! the floor, the failure hooks, the storage switch) reach this crate only
//! through `[dev-dependencies]`, so a release build never has them. Checked on
//! the normal-edge feature graph, which is what `cargo build --release` resolves.

#[test]
fn a_release_build_has_no_test_features() {
    let out = std::process::Command::new(env!("CARGO"))
        .args(["tree", "-e", "features,normal", "-p", "liber-desktop"])
        .args(["--locked", "--offline", "--prefix", "none"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    let tree = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "cargo tree failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(tree.contains("liber-crypto feature \"default\""), "{tree}");
    for feature in [
        "liber-crypto feature \"test-params\"",
        "liber-vault feature \"test-params\"",
        "liber-vault feature \"test-storage\"",
        "liber-desktop feature \"test-params\"",
    ] {
        assert!(
            !tree.contains(feature),
            "{feature} in a release build:\n{tree}"
        );
    }
}
