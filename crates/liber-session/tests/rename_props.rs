//! Property tests for rename-with-rewrite (spec §7.2): links keep their target,
//! and no byte outside a link target changes.

use liber_markdown::{FileSet, LinkKind, parse_page, shortest_unique_target};
use liber_session::{SessionEvent, VaultSession};
use liber_vault::VaultPath;
use proptest::prelude::*;
use std::collections::BTreeMap;

const FOLDERS: [&str; 4] = ["", "x", "x/y", "z"];
const NAMES: [&str; 4] = ["a", "b", "Ideas", "note c"];

fn path(folder: usize, name: usize) -> String {
    let f = FOLDERS[folder];
    if f.is_empty() {
        format!("{}.md", NAMES[name])
    } else {
        format!("{f}/{}.md", NAMES[name])
    }
}

#[derive(Debug, Clone)]
struct Case {
    files: Vec<(usize, usize)>,
    /// Per file: (target file index, markdown-style?).
    links: Vec<Vec<(usize, bool)>>,
    rename: (usize, usize, usize),
}

fn case() -> impl Strategy<Value = Case> {
    proptest::collection::btree_set((0..4usize, 0..4usize), 2..7)
        .prop_flat_map(|set| {
            let files: Vec<_> = set.into_iter().collect();
            let n = files.len();
            (
                Just(files),
                proptest::collection::vec(
                    proptest::collection::vec((0..n, any::<bool>()), 0..4),
                    n,
                ),
                (0..n, 0..4usize, 0..4usize),
            )
        })
        .prop_map(|(files, links, rename)| Case {
            files,
            links,
            rename,
        })
}

fn encode(s: &str) -> String {
    s.replace(' ', "%20")
}

/// Text outside link target ranges, in order.
fn segments(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut last = 0;
    for l in parse_page(text, "x").links {
        out.push(text[last..l.range.start].to_string());
        last = l.range.end;
    }
    out.push(text[last..].to_string());
    out
}

/// Builds the vault for `c`, renames `from` → `to` (file or folder), and checks
/// every page's targets (mapped through `map`) and its bytes outside links.
fn check(
    c: &Case,
    from: &str,
    to: &str,
    map: &dyn Fn(&str) -> String,
) -> Result<(), TestCaseError> {
    let paths: Vec<String> = c.files.iter().map(|&(f, n)| path(f, n)).collect();
    let set = FileSet::new(paths.iter().cloned());
    let vault = tempfile::tempdir().unwrap();
    for f in &FOLDERS[1..] {
        std::fs::create_dir_all(vault.path().join(f)).unwrap();
    }
    let mut texts = BTreeMap::new();
    for (i, src) in paths.iter().enumerate() {
        let mut text = format!("# Page {i}\n\nIntro text.\n");
        for &(t, md) in &c.links[i] {
            if md {
                let dest = shortest_unique_target(&paths[t], src, &set, LinkKind::Markdown, false);
                text.push_str(&format!("- see [link]({}) here\n", encode(&dest)));
            } else {
                let dest = shortest_unique_target(&paths[t], src, &set, LinkKind::Wiki, false);
                text.push_str(&format!("- see [[{dest}|alias]] here\n"));
            }
        }
        std::fs::write(vault.path().join(src), &text).unwrap();
        texts.insert(src.clone(), text);
    }
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    let expected: BTreeMap<String, Vec<Option<String>>> = paths
        .iter()
        .map(|p| {
            (
                p.clone(),
                s.page(&VaultPath::new(p).unwrap())
                    .unwrap()
                    .unwrap()
                    .links
                    .into_iter()
                    .map(|l| l.target_path)
                    .collect(),
            )
        })
        .collect();
    prop_assert!(
        expected.values().flatten().all(Option::is_some),
        "generated links resolve"
    );

    if let Some(parent) = std::path::Path::new(to).parent() {
        std::fs::create_dir_all(vault.path().join(parent)).unwrap();
    }
    let out = s
        .rename(
            &VaultPath::new(from).unwrap(),
            &VaultPath::new(to).unwrap(),
            true,
        )
        .unwrap();
    prop_assert!(out.failed.is_empty(), "{:?}", out.failed);

    for (old, want) in &expected {
        let now = map(old);
        let page = s.page(&VaultPath::new(&now).unwrap()).unwrap().unwrap();
        let got: Vec<_> = page.links.into_iter().map(|l| l.target_path).collect();
        let want: Vec<_> = want.iter().map(|t| t.as_deref().map(map)).collect();
        prop_assert_eq!(&got, &want, "targets of {}", now);
        let after = std::fs::read_to_string(vault.path().join(&now)).unwrap();
        prop_assert_eq!(
            segments(&texts[old]),
            segments(&after),
            "bytes outside links of {}",
            now
        );
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]
    #[test]
    fn exp_04_file_rename_preserves_targets_and_bytes(c in case()) {
        if liber_testkit::plain_disk_only() {
            return Ok(());
        }
        let paths: Vec<String> = c.files.iter().map(|&(f, n)| path(f, n)).collect();
        let (file_idx, new_folder, new_name) = c.rename;
        let to = path(new_folder, new_name);
        prop_assume!(!paths.contains(&to));
        let from = paths[file_idx].clone();
        let map = |p: &str| if p == from { to.clone() } else { p.to_string() };
        check(&c, &from, &to, &map)?;
    }

    #[test]
    fn exp_04_folder_move_preserves_targets_and_bytes(c in case()) {
        if liber_testkit::plain_disk_only() {
            return Ok(());
        }
        let paths: Vec<String> = c.files.iter().map(|&(f, n)| path(f, n)).collect();
        prop_assume!(paths.iter().any(|p| p.starts_with("x/")));
        let map = |p: &str| match p.strip_prefix("x/") {
            Some(rest) => format!("z/moved/{rest}"),
            None => p.to_string(),
        };
        check(&c, "x", "z/moved", &map)?;
    }
}
