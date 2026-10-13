//! Parity with the TypeScript model (M2a spec §2.6): the same fixtures are
//! asserted by apps/desktop/src/markdown/parity.test.ts.

use nimw_markdown::parse_page;
use serde_json::{Value, json};
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/markdown")
}

#[test]
fn pg_05_parity_fixtures_match_the_typescript_model() {
    let mut seen = 0;
    for entry in std::fs::read_dir(fixtures()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        seen += 1;
        let src = std::fs::read_to_string(&path).unwrap();
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(path.with_extension("expected.json")).unwrap(),
        )
        .unwrap();
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let meta = parse_page(&src, stem);
        let links: Vec<Value> = meta
            .links
            .iter()
            .map(|l| {
                json!({
                    "kind": l.kind.as_str(),
                    "target": l.target,
                    "heading": l.heading,
                    "alias": l.alias,
                })
            })
            .collect();
        let tags: Vec<&str> = meta.tags.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(Value::Array(links), expected["links"], "{}", path.display());
        assert_eq!(json!(tags), expected["tags"], "{}", path.display());
    }
    assert!(seen > 0, "no fixtures found");
}
