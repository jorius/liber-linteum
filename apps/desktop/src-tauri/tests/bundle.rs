//! The macOS bundle's own Info.plist, which Tauri merges into the app's.

/// The text after `<key>{key}</key>`, up to the next key.
fn value_of<'a>(plist: &'a str, key: &str) -> Option<&'a str> {
    let rest = plist.split_once(&format!("<key>{key}</key>"))?.1;
    Some(rest.split("<key>").next().unwrap_or(rest))
}

/// Batch 6 review I8: WKWebView only reports the languages the bundle lists
/// (Q-I18N-1), and macOS asks for the microphone with our sentence (M6).
#[test]
fn b6_review_i8_the_bundle_lists_its_languages_and_why_it_uses_the_microphone() {
    let plist =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Info.plist")).unwrap();
    let languages = value_of(&plist, "CFBundleLocalizations").expect("CFBundleLocalizations");
    assert!(languages.contains("<string>en</string>"), "{languages}");
    assert!(languages.contains("<string>es</string>"), "{languages}");
    let why = value_of(&plist, "NSMicrophoneUsageDescription").expect("microphone description");
    assert!(why.contains("<string>") && why.contains("record"), "{why}");
}
