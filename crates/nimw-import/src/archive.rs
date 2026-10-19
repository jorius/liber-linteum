//! Reading a Notion export zip (M7 §4). Every byte is untrusted: names are
//! checked and never used as paths, sizes and ratios are capped, and reads
//! stop at the declared size.

use crate::ImportError;
use std::cell::RefCell;
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::Path;
use zip::ZipArchive;

const MIB: u64 = 1024 * 1024;

/// Limits that refuse an export before anything is written (spec §4).
#[derive(Debug, Clone)]
pub struct Limits {
    /// Files, across every part.
    pub entries: usize,
    /// Uncompressed bytes, across every part.
    pub total: u64,
    /// Uncompressed bytes of one file.
    pub entry: u64,
    /// Uncompressed : compressed, for files over 1 MiB.
    pub ratio: u64,
    /// A Markdown or CSV file read into memory.
    pub text: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            entries: 200_000,
            total: 16 * 1024 * MIB,
            entry: 4 * 1024 * MIB,
            ratio: 1_000,
            text: 32 * MIB,
        }
    }
}

/// One file of the export.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Its path in the export, one name per component, `Export-…` root dropped.
    pub path: Vec<String>,
    /// Uncompressed size, as declared.
    pub size: u64,
    part: usize,
    index: usize,
}

/// An opened export: the outer zip, or its parts (each in a temp file).
pub struct Export {
    parts: Vec<RefCell<ZipArchive<File>>>,
    entries: Vec<Entry>,
    warnings: Vec<String>,
    limits: Limits,
}

impl std::fmt::Debug for Export {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Export")
            .field("entries", &self.entries.len())
            .field("warnings", &self.warnings)
            .finish()
    }
}

fn zip_err(e: zip::result::ZipError) -> ImportError {
    ImportError::Zip(e.to_string())
}

impl Export {
    /// Opens `path` and lists its files. A zip holding nothing but `.zip`
    /// files is Notion's multi-part export: each part is read in turn.
    pub fn open(path: &Path, limits: &Limits) -> Result<Export, ImportError> {
        let mut outer = ZipArchive::new(File::open(path)?).map_err(zip_err)?;
        let mut export = Export {
            parts: Vec::new(),
            entries: Vec::new(),
            warnings: Vec::new(),
            limits: limits.clone(),
        };
        let files: Vec<usize> = (0..outer.len())
            .filter(|&i| outer.by_index_raw(i).is_ok_and(|f| !f.is_dir()))
            .collect();
        let all_zips = !files.is_empty()
            && files.iter().all(|&i| {
                outer
                    .by_index_raw(i)
                    .is_ok_and(|f| name_of(f.name()).to_ascii_lowercase().ends_with(".zip"))
            });
        if all_zips {
            for i in files {
                let mut tmp = tempfile::tempfile()?;
                {
                    let mut part = outer.by_index(i).map_err(zip_err)?;
                    check_size(limits, &name_of(part.name()), part.size(), part.compressed_size())?;
                    copy_capped(&mut part, &mut tmp)?;
                }
                tmp.rewind()?;
                export.add_part(ZipArchive::new(tmp).map_err(zip_err)?)?;
            }
        } else {
            let file = outer.into_inner();
            export.add_part(ZipArchive::new(file).map_err(zip_err)?)?;
        }
        export.drop_export_root();
        Ok(export)
    }

    fn add_part(&mut self, mut zip: ZipArchive<File>) -> Result<(), ImportError> {
        let part = self.parts.len();
        let mut total: u64 = self.entries.iter().map(|e| e.size).sum();
        for index in 0..zip.len() {
            let file = zip.by_index_raw(index).map_err(zip_err)?;
            if file.is_dir() {
                continue;
            }
            // A name that doesn't decode is empty, so refused below.
            let name = name_of(file.name());
            if file.is_symlink() {
                self.warnings.push(format!("skipped {name:?}: a symbolic link"));
                continue;
            }
            let Some(path) = safe_path(&name) else {
                self.warnings
                    .push(format!("skipped {name:?}: not a safe path inside the export"));
                continue;
            };
            check_size(&self.limits, &name, file.size(), file.compressed_size())?;
            total += file.size();
            if total > self.limits.total {
                return Err(ImportError::Limit(format!(
                    "the export unpacks to more than {} GiB",
                    self.limits.total / (1024 * MIB)
                )));
            }
            if self.entries.len() >= self.limits.entries {
                return Err(ImportError::Limit(format!(
                    "the export holds more than {} files",
                    self.limits.entries
                )));
            }
            self.entries.push(Entry {
                path,
                size: file.size(),
                part,
                index,
            });
        }
        self.parts.push(RefCell::new(zip));
        Ok(())
    }

    /// Newer exports wrap everything in one `Export-<id>` folder: dropped.
    fn drop_export_root(&mut self) {
        let Some(first) = self.entries.first().and_then(|e| e.path.first()).cloned() else {
            return;
        };
        let is_export_root = first
            .strip_prefix("Export-")
            .is_some_and(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        if is_export_root && self.entries.iter().all(|e| e.path.len() > 1 && e.path[0] == first) {
            for e in &mut self.entries {
                e.path.remove(0);
            }
        }
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Entries refused while reading, as warnings for the preview.
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// A Markdown or CSV file as text: BOM dropped, invalid UTF-8 replaced
    /// (`true` when that happened). Over the text limit is an error.
    pub fn read_text(&self, entry: &Entry) -> Result<(String, bool), ImportError> {
        if entry.size > self.limits.text {
            return Err(ImportError::Limit(format!(
                "{} is larger than {} MiB",
                entry.path.join("/"),
                self.limits.text / MIB
            )));
        }
        let mut bytes = Vec::with_capacity(entry.size as usize);
        self.copy_to(entry, &mut bytes)?;
        let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
        match std::str::from_utf8(body) {
            Ok(text) => Ok((text.to_string(), false)),
            Err(_) => Ok((String::from_utf8_lossy(body).into_owned(), true)),
        }
    }

    /// Streams `entry` into `out`; a file longer than it declared is an error.
    pub fn copy_to(&self, entry: &Entry, out: &mut dyn Write) -> Result<u64, ImportError> {
        let mut zip = self.parts[entry.part].borrow_mut();
        let mut file = zip.by_index(entry.index).map_err(zip_err)?;
        let n = std::io::copy(&mut (&mut file).take(entry.size + 1), out)?;
        if n > entry.size {
            return Err(ImportError::Limit(format!(
                "{} is larger than it says",
                entry.path.join("/")
            )));
        }
        Ok(n)
    }
}

fn name_of(name: zip::result::ZipResult<std::borrow::Cow<'_, str>>) -> String {
    name.map(|n| n.into_owned()).unwrap_or_default()
}

fn check_size(limits: &Limits, name: &str, size: u64, compressed: u64) -> Result<(), ImportError> {
    if size > limits.entry {
        return Err(ImportError::Limit(format!("{name} is too large to import")));
    }
    if size > MIB && size / compressed.max(1) > limits.ratio {
        return Err(ImportError::Limit(format!(
            "{name} expands suspiciously (over {}:1)",
            limits.ratio
        )));
    }
    Ok(())
}

/// Copies a part to its temp file, at most its declared size.
fn copy_capped(part: &mut zip::read::ZipFile<'_, File>, out: &mut File) -> Result<(), ImportError> {
    let size = part.size();
    let n = std::io::copy(&mut part.take(size + 1), out)?;
    if n > size {
        return Err(ImportError::Limit(format!(
            "{} is larger than it says",
            name_of(part.name())
        )));
    }
    Ok(())
}

/// The components of a zip entry name, or `None` when it could point
/// anywhere but inside the export: absolute, a drive prefix, `.`/`..`, NUL.
fn safe_path(name: &str) -> Option<Vec<String>> {
    let name = name.replace('\\', "/");
    let bytes = name.as_bytes();
    let drive = bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic();
    if name.starts_with('/') || drive || name.contains('\0') {
        return None;
    }
    let parts: Vec<String> = name.split('/').filter(|p| !p.is_empty()).map(String::from).collect();
    if parts.is_empty() || parts.iter().any(|p| p == "." || p == ".." || p.contains(':')) {
        return None;
    }
    Some(parts)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    /// A zip with `files` (name, bytes), written to a temp file.
    pub(crate) fn zip_file(files: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), zip_bytes(files)).unwrap();
        tmp
    }

    pub(crate) fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        for (name, bytes) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn names(export: &Export) -> Vec<String> {
        let mut out: Vec<String> = export.entries().iter().map(|e| e.path.join("/")).collect();
        out.sort();
        out
    }

    const ID: &str = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

    #[test]
    fn m7_lists_a_plain_export() {
        let zip = zip_file(&[
            (&format!("Home {ID}.md"), b"# Home\n"),
            (&format!("Home {ID}/pic.png"), b"png"),
        ]);
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        assert_eq!(names(&export), [format!("Home {ID}.md"), format!("Home {ID}/pic.png")]);
        let entry = &export.entries()[0];
        assert_eq!(export.read_text(entry).unwrap(), ("# Home\n".into(), false));
    }

    #[test]
    fn m7_drops_the_export_root_folder() {
        let zip = zip_file(&[
            ("Export-7c1e2f3a-aaaa/A.md", b"a"),
            ("Export-7c1e2f3a-aaaa/B/C.md", b"c"),
        ]);
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        assert_eq!(names(&export), ["A.md", "B/C.md"]);
    }

    #[test]
    fn m7_reads_every_part_of_a_multi_part_export() {
        let one = zip_bytes(&[("A.md", b"a")]);
        let two = zip_bytes(&[("B/C.md", b"c"), ("B/x.png", b"x")]);
        let zip = zip_file(&[("Export-1-Part-1.zip", &one), ("Export-1-Part-2.zip", &two)]);
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        assert_eq!(names(&export), ["A.md", "B/C.md", "B/x.png"]);
        let c = export.entries().iter().find(|e| e.path == ["B", "C.md"]).unwrap();
        assert_eq!(export.read_text(c).unwrap().0, "c");
    }

    #[test]
    fn m7_a_zip_beside_pages_stays_an_attachment() {
        let inner = zip_bytes(&[("x.md", b"x")]);
        let zip = zip_file(&[("A.md", b"a"), ("A/backup.zip", &inner)]);
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        assert_eq!(names(&export), ["A.md", "A/backup.zip"]);
    }

    #[test]
    fn m7_refuses_names_that_leave_the_export() {
        let zip = zip_file(&[
            ("../evil.md", b"x"),
            ("/abs.md", b"x"),
            ("C:x.md", b"x"),
            ("a/./b.md", b"x"),
            ("a\\..\\..\\c.md", b"x"),
            ("ok.md", b"fine"),
        ]);
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        assert_eq!(names(&export), ["ok.md"]);
        assert_eq!(export.warnings().len(), 5, "{:?}", export.warnings());
    }

    #[test]
    fn m7_refuses_symbolic_links() {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.add_symlink("link.md", "/etc/passwd", SimpleFileOptions::default()).unwrap();
        w.start_file("ok.md", SimpleFileOptions::default()).unwrap();
        w.write_all(b"x").unwrap();
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), w.finish().unwrap().into_inner()).unwrap();
        let export = Export::open(tmp.path(), &Limits::default()).unwrap();
        assert_eq!(names(&export), ["ok.md"]);
        assert!(export.warnings()[0].contains("symbolic link"));
    }

    #[test]
    fn m7_refuses_too_many_files() {
        let zip = zip_file(&[("a.md", b"a"), ("b.md", b"b"), ("c.md", b"c")]);
        let limits = Limits { entries: 2, ..Limits::default() };
        let err = Export::open(zip.path(), &limits).unwrap_err();
        assert!(matches!(err, ImportError::Limit(_)), "{err}");
    }

    #[test]
    fn m7_refuses_a_bomb() {
        let zeros = vec![0u8; 4 * MIB as usize];
        let zip = zip_file(&[("bomb.png", &zeros)]);
        let limits = Limits { ratio: 100, ..Limits::default() };
        let err = Export::open(zip.path(), &limits).unwrap_err();
        assert!(err.to_string().contains("expands"), "{err}");
    }

    #[test]
    fn m7_text_over_the_limit_is_refused_and_a_bom_dropped() {
        let zip = zip_file(&[("big.md", &[b'x'; 64]), ("t.csv", b"\xEF\xBB\xBFName\n")]);
        let limits = Limits { text: 32, ..Limits::default() };
        let export = Export::open(zip.path(), &limits).unwrap();
        let big = export.entries().iter().find(|e| e.path == ["big.md"]).unwrap();
        assert!(export.read_text(big).is_err());
        let csv = export.entries().iter().find(|e| e.path == ["t.csv"]).unwrap();
        assert_eq!(export.read_text(csv).unwrap().0, "Name\n");
    }
}
