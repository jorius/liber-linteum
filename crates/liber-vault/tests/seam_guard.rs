//! The seam guard (E2): production code reaches vault files only through
//! `Storage`. A line that touches the file system directly must sit in an
//! allowed file or carry `// seam: outside (<reason>)`.
//! See docs/architecture/storage-seam.md.

use std::path::Path;

/// Whole files or folders outside the seam (repo-relative, `/`-separated).
const ALLOWED: &[&str] = &[
    "crates/liber-vault/src/storage/",
    "crates/liber-testkit/",
    "apps/desktop/src-tauri/src/settings.rs",
    "apps/desktop/src-tauri/src/legacy_dirs.rs",
    "crates/liber-crypto/src/vectors.rs",
];

const MARK: &str = "// seam: outside (";

/// Single lines outside the seam that can't carry the mark, because rustfmt
/// moves a comment after `{` onto the next line: (file, the line's start).
const ALLOWED_LINES: &[(&str, &str)] = &[
    // The definition, not a call: PlainStorage and single-file windows call it.
    (
        "crates/liber-vault/src/path.rs",
        "pub fn to_fs_path(&self, root: &Path)",
    ),
];

/// `std::fs|\bfs::|\bFile::|OpenOptions|read_dir|symlink_metadata|canonicalize|notify::|trash::|to_fs_path\(`
fn touches_fs(line: &str) -> bool {
    const ANYWHERE: &[&str] = &[
        "std::fs",
        "OpenOptions",
        "read_dir",
        "symlink_metadata",
        "canonicalize",
        "notify::",
        "trash::",
        "to_fs_path(",
    ];
    ANYWHERE.iter().any(|n| line.contains(n))
        || ["fs::", "File::"].iter().any(|n| at_word_start(line, n))
}

/// `\b<needle>`: `needle` (which starts with a word character) not preceded by
/// one, so `KeyringFile::` is not `File::`.
fn at_word_start(line: &str, needle: &str) -> bool {
    line.match_indices(needle).any(|(i, _)| {
        !line[..i]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
    })
}

/// `path:line` of each offending line before the file's test module.
fn offenders(path: &str, text: &str) -> Vec<String> {
    if ALLOWED.iter().any(|a| path.starts_with(a)) {
        return Vec::new();
    }
    let lines: Vec<&str> = text.lines().collect();
    // The test module: `#[cfg(test)]` then `mod … {`. A `#[cfg(test)]` on a
    // single item mid-file does not end the scan.
    let end = (0..lines.len())
        .find(|&i| {
            lines[i].trim() == "#[cfg(test)]"
                && lines.get(i + 1).is_some_and(|l| {
                    let l = l.trim();
                    l.ends_with('{') && l.split_whitespace().any(|w| w == "mod")
                })
        })
        .unwrap_or(lines.len());
    lines[..end]
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.contains(MARK) && touches_fs(l))
        .filter(|(_, l)| {
            !ALLOWED_LINES
                .iter()
                .any(|(f, start)| *f == path && l.trim_start().starts_with(start))
        })
        .map(|(i, _)| format!("{path}:{}", i + 1))
        .collect()
}

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn seam_guard() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for krate in std::fs::read_dir(repo.join("crates")).unwrap() {
        let src = krate.unwrap().path().join("src");
        if src.is_dir() {
            rust_files(&src, &mut files);
        }
    }
    rust_files(&repo.join("apps/desktop/src-tauri/src"), &mut files);
    assert!(
        files.len() > 50,
        "the walk found only {} files",
        files.len()
    );

    let mut found = Vec::new();
    for file in &files {
        let rel = file.strip_prefix(&repo).unwrap();
        let rel: Vec<_> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect();
        found.extend(offenders(
            &rel.join("/"),
            &std::fs::read_to_string(file).unwrap(),
        ));
    }
    found.sort();
    assert!(
        found.is_empty(),
        "direct file-system calls outside the Storage seam (route them through `Vault`, \
         or mark a line that is truly outside any vault with `// seam: outside (<reason>)`):\n{}",
        found.join("\n")
    );
}

#[test]
fn seam_guard_catches_an_offender() {
    let x = "crates/liber-session/src/x.rs";
    assert_eq!(
        offenders(x, "let x = std::fs::read(p);"),
        vec![format!("{x}:1")]
    );
    assert!(offenders(x, "let k = KeyringFile::new();").is_empty());
    assert!(offenders(x, "File::open(p) // seam: outside (an export zip)").is_empty());
    assert_eq!(
        offenders(x, "\n#[cfg(test)]\nfn hook() {}\nFile::open(p);"),
        vec![format!("{x}:4")]
    );
    assert!(
        offenders(
            x,
            "#[cfg(test)]\npub(crate) mod tests {\n  File::open(p);\n}"
        )
        .is_empty()
    );
    assert!(
        offenders(
            "crates/liber-vault/src/storage/plain.rs",
            "std::fs::read(p);"
        )
        .is_empty()
    );
    let path_rs = "crates/liber-vault/src/path.rs";
    assert!(
        offenders(
            path_rs,
            "    pub fn to_fs_path(&self, root: &Path) -> PathBuf {"
        )
        .is_empty()
    );
    assert_eq!(
        offenders(path_rs, "let f = p.to_fs_path(root);"),
        vec![format!("{path_rs}:1")]
    );
}
