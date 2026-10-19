//! The import itself (M7 §8): a plan of every file the new vault gets (the
//! preview reads it), then the writes, create-only, through `nimw-vault`.

use crate::database::Table;
use crate::markdown::{Resolver, Target, convert, strip_properties};
use crate::names::{NameMap, clean_component};
use crate::{Entry, Export, ImportError, strip_notion_id};
use nimw_vault::{Vault, VaultPath};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use unicode_normalization::UnicodeNormalization;

/// The report page, at the new vault's root.
const REPORT: &str = "Notion import report.md";
/// The longest vault path written, in bytes: deep Notion trees of long names
/// pass every OS's path limit (macOS: 1024 bytes, the vault's own included).
const MAX_PATH_BYTES: usize = 600;
/// Warnings listed in the preview (the report lists them all).
pub const PREVIEW_WARNINGS: usize = 50;

/// What the preview shows (spec §3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Preview {
    pub pages: usize,
    pub databases: usize,
    pub rows: usize,
    pub attachments: usize,
    pub folders: usize,
    pub bytes: u64,
    pub warnings: Vec<String>,
}

enum Body {
    /// Text the import makes up (a row with no page, a database's index).
    Text(String),
    /// An exported page, converted while it is written (never held: an
    /// export can hold far more Markdown than memory); `row` is its
    /// database and row when it is one.
    Page {
        entry: usize,
        row: Option<(usize, usize)>,
    },
    /// An export file copied as it is.
    Entry(usize),
}

struct Out {
    path: String,
    body: Body,
}

/// A database's CSV as the pages need it: its table and its folder.
struct Rows {
    table: Table,
    csv_dir: Vec<String>,
}

/// Every folder and file the new vault gets, in write order.
pub struct Plan {
    folders: Vec<String>,
    files: Vec<Out>,
    report: String,
    counts: Preview,
    targets: Targets,
    databases: Vec<Rows>,
}

/// An exported page as the vault's: links rewritten, a row's properties made
/// frontmatter. Also returns its warnings.
fn page_text(
    export: &Export,
    entry: &Entry,
    path: &str,
    row: Option<(usize, usize)>,
    databases: &[Rows],
    targets: &Targets,
) -> Result<(String, Vec<String>), ImportError> {
    let mut warnings = Vec::new();
    let (text, lossy) = export.read_text(entry)?;
    if lossy {
        warnings.push(format!("{path}: not valid UTF-8; odd characters replaced"));
    }
    let dir = &entry.path[..entry.path.len() - 1];
    let (mut body, missing) = convert(&text, dir, targets);
    for m in missing {
        warnings.push(format!("{path}: the link to {m} points nowhere"));
    }
    if let Some((d, r)) = row {
        let db = &databases[d];
        body = strip_properties(&body, &db.table.headers[1..]);
        if let Some(front) = db.table.frontmatter(r, &db.csv_dir, targets) {
            body = format!("{front}{body}");
        }
    }
    Ok((body, warnings))
}

/// What [`write`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub root: PathBuf,
    /// The report page's vault path.
    pub report: String,
    pub cancelled: bool,
    /// Why the import stopped early (a full disk) or its report couldn't be
    /// written: the vault at `root` is there, partly written (spec §8).
    pub failed: Option<String>,
    /// Files written, the report included.
    pub written: usize,
}

fn ext(entry: &Entry) -> String {
    let name = entry.path.last().map_or("", String::as_str);
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn key(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

/// A database: its CSV (`_all` preferred), the export folder of its rows,
/// and where its index page goes.
struct Database {
    csv: usize,
    parent: Vec<String>,
    base: String,
}

/// The export's targets, by export path.
struct Targets(HashMap<String, Target>);

impl Resolver for Targets {
    fn target(&self, p: &[String]) -> Option<Target> {
        self.0.get(&p.join("/")).cloned()
    }
}

/// The vault name `path` (without `.md`) is linked by: its bare name when no
/// other page shares it, else its whole path.
fn link_text(path: &str, stems: &HashMap<String, usize>) -> String {
    let no_ext = path.strip_suffix(".md").unwrap_or(path);
    let stem = no_ext.rsplit('/').next().unwrap_or(no_ext);
    if stems.get(&key(stem)) == Some(&1) {
        stem.to_string()
    } else {
        no_ext.to_string()
    }
}

/// Reads the export and decides every file the vault gets. Nothing is written.
/// `cancel` is checked between files: a long export stops when asked.
pub fn plan(export: &Export, cancel: &AtomicBool) -> Result<Plan, ImportError> {
    let stop = || {
        if cancel.load(Ordering::Relaxed) {
            Err(ImportError::Cancelled)
        } else {
            Ok(())
        }
    };
    let entries = export.entries();
    let mut warnings: Vec<String> = export.warnings().to_vec();
    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by(|&a, &b| entries[a].path.cmp(&entries[b].path));

    // Databases: `X.csv` and `X_all.csv` beside a folder `X` of rows. A
    // CSV is one only when Notion named it (an id) or its rows' folder is
    // there; any other CSV is a file attached to a page.
    let folders_in_export: BTreeSet<&[String]> = entries
        .iter()
        .flat_map(|e| (1..e.path.len()).map(move |n| &e.path[..n]))
        .collect();
    let mut databases: Vec<Database> = Vec::new();
    let mut db_csvs: BTreeSet<usize> = BTreeSet::new();
    let mut by_base: HashMap<(Vec<String>, String), usize> = HashMap::new();
    for &i in &order {
        if ext(&entries[i]) != "csv" {
            continue;
        }
        let (name, parent) = entries[i].path.split_last().expect("a file has a name");
        let stem = &name[..name.len() - 4];
        let (base, all) = match stem.strip_suffix("_all") {
            Some(b) => (b.to_string(), true),
            None => (stem.to_string(), false),
        };
        let mut rows_folder = parent.to_vec();
        rows_folder.push(base.clone());
        if strip_notion_id(name) == *name && !folders_in_export.contains(rows_folder.as_slice()) {
            continue;
        }
        db_csvs.insert(i);
        match by_base.get(&(parent.to_vec(), base.clone())) {
            Some(&d) => {
                if all {
                    databases[d].csv = i;
                }
            }
            None => {
                by_base.insert((parent.to_vec(), base.clone()), databases.len());
                databases.push(Database {
                    csv: i,
                    parent: parent.to_vec(),
                    base,
                });
            }
        }
    }

    // Names: real files first (sorted), then what the import makes up.
    let mut names = NameMap::default();
    let mut paths: HashMap<usize, String> = HashMap::new();
    for &i in &order {
        if !db_csvs.contains(&i) {
            paths.insert(i, names.assign(&entries[i].path, true));
        }
    }
    let report = names.claim("", REPORT, true);

    // Each database's index page, row folder, table and row pages.
    struct Db {
        index: String,
        title: String,
        rows: Vec<String>,
        /// Row `i`'s page in the export, if it has one.
        pages: Vec<Option<usize>>,
    }
    let mut dbs: Vec<Db> = Vec::new();
    let mut tables: Vec<Rows> = Vec::new();
    let mut row_of: HashMap<usize, (usize, usize)> = HashMap::new();
    for db in &databases {
        stop()?;
        let csv = &entries[db.csv];
        let table = match export.read_text(csv).map(|(text, _)| Table::parse(&text)) {
            Ok(Some(t)) => t,
            Ok(None) => {
                warnings.push(format!(
                    "{}: an empty database, skipped",
                    csv.path.join("/")
                ));
                continue;
            }
            Err(e) => {
                warnings.push(format!("{}: {e}", csv.path.join("/")));
                continue;
            }
        };
        let parent_vault = if db.parent.is_empty() {
            String::new()
        } else {
            names.assign(&db.parent, false)
        };
        let title = strip_notion_id(&db.base);
        let index = names.claim(
            &parent_vault,
            &clean_component(&format!("{}.md", db.base), true),
            true,
        );
        let mut folder_orig = db.parent.clone();
        folder_orig.push(db.base.clone());
        let folder = match names.get(&folder_orig) {
            Some(f) => f.to_string(),
            None => names.claim(&parent_vault, &clean_component(&db.base, false), false),
        };
        // Row pages in the export, by their cleaned name.
        let mut waiting: HashMap<String, VecDeque<usize>> = HashMap::new();
        for &i in &order {
            let e = &entries[i];
            if ext(e) == "md"
                && e.path.len() == folder_orig.len() + 1
                && e.path.starts_with(&folder_orig)
            {
                let name = clean_component(e.path.last().expect("named"), true);
                waiting
                    .entry(key(name.trim_end_matches(".md")))
                    .or_default()
                    .push_back(i);
            }
        }
        let d = dbs.len();
        let mut rows = Vec::new();
        let mut pages = Vec::new();
        for r in 0..table.rows.len() {
            let wanted = clean_component(&format!("{}.md", table.title(r)), true);
            match waiting
                .get_mut(&key(wanted.trim_end_matches(".md")))
                .and_then(VecDeque::pop_front)
            {
                Some(i) => {
                    rows.push(paths[&i].clone());
                    pages.push(Some(i));
                    row_of.insert(i, (d, r));
                }
                None => {
                    rows.push(names.claim(&folder, &wanted, true));
                    pages.push(None);
                }
            }
        }
        for left in waiting.into_values().flatten() {
            warnings.push(format!(
                "{} has no row in {}; imported as a plain page",
                paths[&left],
                csv.path.join("/")
            ));
        }
        dbs.push(Db {
            index,
            title,
            rows,
            pages,
        });
        tables.push(Rows {
            table,
            csv_dir: db.parent.clone(),
        });
    }

    // How each page is linked, now that every page has its name.
    let mut stems: HashMap<String, usize> = HashMap::new();
    let page_paths = order
        .iter()
        .filter(|&&i| ext(&entries[i]) == "md")
        .map(|i| paths[i].clone())
        .chain(
            dbs.iter()
                .flat_map(|d| d.rows.iter().cloned().chain([d.index.clone()])),
        );
    let page_paths: BTreeSet<String> = page_paths.collect();
    for p in &page_paths {
        let no_ext = p.strip_suffix(".md").unwrap_or(p);
        *stems
            .entry(key(no_ext.rsplit('/').next().unwrap_or(no_ext)))
            .or_default() += 1;
    }
    let mut targets: HashMap<String, Target> = HashMap::new();
    for &i in &order {
        let e = &entries[i];
        let target = match ext(e).as_str() {
            "md" => Target::Page(link_text(&paths[&i], &stems)),
            _ if db_csvs.contains(&i) => continue,
            _ => Target::Asset(paths[&i].clone()),
        };
        targets.insert(e.path.join("/"), target);
    }
    for (db, d) in databases.iter().zip(&dbs) {
        let link = Target::Page(link_text(&d.index, &stems));
        for suffix in [".csv", "_all.csv"] {
            let mut p = db.parent.clone();
            p.push(format!("{}{suffix}", db.base));
            targets.insert(p.join("/"), link.clone());
        }
    }
    let targets = Targets(targets);

    let text: u64 = entries
        .iter()
        .filter(|e| ext(e) == "md")
        .map(|e| e.size)
        .sum();
    if text > export.limits().pages {
        return Err(ImportError::Limit(format!(
            "the export's pages hold more than {} MiB of text",
            export.limits().pages / (1024 * 1024)
        )));
    }

    // The files, in export order, then what databases add.
    let mut counts = Preview::default();
    let mut files = Vec::new();
    for &i in &order {
        stop()?;
        let e = &entries[i];
        counts.bytes += e.size;
        match ext(e).as_str() {
            _ if db_csvs.contains(&i) => {}
            "md" => {
                let path = paths[&i].clone();
                let row = row_of.get(&i).copied();
                // Converted now for its warnings, then dropped: written later.
                let body = match page_text(export, e, &path, row, &tables, &targets) {
                    Ok((_, w)) => {
                        warnings.extend(w);
                        Body::Page { entry: i, row }
                    }
                    Err(err) => {
                        warnings.push(format!("{path}: {err}; copied unchanged"));
                        Body::Entry(i)
                    }
                };
                if row.is_some() && matches!(body, Body::Page { .. }) {
                    counts.rows += 1;
                } else {
                    counts.pages += 1;
                }
                files.push(Out { path, body });
            }
            _ => {
                counts.attachments += 1;
                files.push(Out {
                    path: paths[&i].clone(),
                    body: Body::Entry(i),
                });
            }
        }
    }
    for (d, rows) in dbs.iter().zip(&tables) {
        counts.databases += 1;
        for (r, page) in d.pages.iter().enumerate() {
            if page.is_none() {
                let front = rows
                    .table
                    .frontmatter(r, &rows.csv_dir, &targets)
                    .unwrap_or_default();
                let text = format!("{front}# {}\n", rows.table.title(r));
                files.push(Out {
                    path: d.rows[r].clone(),
                    body: Body::Text(text),
                });
                counts.rows += 1;
            }
        }
        let links: Vec<String> = d
            .rows
            .iter()
            .map(|p| p.trim_end_matches(".md").to_string())
            .collect();
        files.push(Out {
            path: d.index.clone(),
            body: Body::Text(rows.table.index_page(&d.title, &links)),
        });
    }

    files.retain(|f| {
        let fits = f.path.len() <= MAX_PATH_BYTES;
        if !fits {
            warnings.push(format!("{}: the path is too long; skipped", f.path));
        }
        fits
    });
    let mut folders = BTreeSet::new();
    for f in &files {
        let mut p = f.path.as_str();
        while let Some((parent, _)) = p.rsplit_once('/') {
            folders.insert(parent.to_string());
            p = parent;
        }
    }
    counts.folders = folders.len();
    counts.warnings = warnings;
    Ok(Plan {
        folders: folders.into_iter().collect(),
        files,
        report,
        counts,
        targets,
        databases: tables,
    })
}

impl Plan {
    /// The counts and warnings (every warning: the dialog shows the first
    /// [`PREVIEW_WARNINGS`]).
    pub fn preview(&self) -> &Preview {
        &self.counts
    }

    /// Files [`write`] will write, the report included.
    pub fn total(&self) -> usize {
        self.files.len() + 1
    }
}

/// `days` since 1970-01-01 as `YYYY-MM-DD` (Howard Hinnant's civil_from_days).
fn civil(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    civil((secs / 86_400) as i64)
}

fn report_text(
    source: &str,
    counts: &Preview,
    written: usize,
    total: usize,
    end: Option<&str>,
) -> String {
    let mut out = format!(
        "# Notion import report\n\nImported from `{source}` on {}.\n\n| What | Count |\n| --- | --- |\n| Pages | {} |\n| Databases | {} |\n| Database rows | {} |\n| Attachments | {} |\n| Folders | {} |\n",
        today(),
        counts.pages,
        counts.databases,
        counts.rows,
        counts.attachments,
        counts.folders
    );
    if let Some(end) = end {
        out.push_str(&format!(
            "\n**{end}** {written} of {total} files were written.\n"
        ));
    }
    if counts.warnings.is_empty() {
        out.push_str("\nNo warnings.\n");
    } else {
        out.push_str(&format!("\n## Warnings ({})\n\n", counts.warnings.len()));
        for w in &counts.warnings {
            out.push_str(&format!("- {}\n", w.replace('\n', " ")));
        }
    }
    out
}

/// Writes the plan into `target`, a folder that must not exist yet (its
/// parent must). `progress(done, total)` follows every file; `cancel` is
/// checked between files. Stopping early keeps what was written and says so
/// in the report (spec §8, ruling 4).
pub fn write(
    export: &Export,
    plan: &Plan,
    source: &str,
    target: &Path,
    progress: &mut dyn FnMut(usize, usize),
    cancel: &AtomicBool,
) -> Result<Report, ImportError> {
    if target.symlink_metadata().is_ok() {
        return Err(ImportError::Exists(target.display().to_string()));
    }
    std::fs::create_dir(target)?;
    let vault = Vault::open(target)?;
    let total = plan.total();
    let mut written = 0;
    let mut stopped: Option<String> = None;
    // Plain create-only writes: the folder is new and nothing else reads it
    // yet, so no temp file or fsync per file (spec §10: 5k pages in seconds).
    let step = |out: &Out| -> Result<(), ImportError> {
        let full = vault.fs_path(&VaultPath::new(&out.path)?)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&full)?;
        let written = match &out.body {
            Body::Text(text) => file.write_all(text.as_bytes()).map_err(ImportError::from),
            Body::Page { entry, row } => page_text(
                export,
                &export.entries()[*entry],
                &out.path,
                *row,
                &plan.databases,
                &plan.targets,
            )
            .and_then(|(text, _)| file.write_all(text.as_bytes()).map_err(ImportError::from)),
            Body::Entry(i) => export.copy_to(&export.entries()[*i], &mut file).map(|_| ()),
        };
        if written.is_err() {
            drop(file);
            let _ = std::fs::remove_file(&full); // never leave half a file
        }
        written
    };
    let mut failure = None;
    // One file that can't be written is a warning; a full disk stops it all.
    let mut skipped: Vec<String> = Vec::new();
    let full = |e: &ImportError| matches!(e, ImportError::Io(io) if io.kind() == std::io::ErrorKind::StorageFull);
    for folder in &plan.folders {
        let made = VaultPath::new(folder)
            .and_then(|p| vault.create_dir_all(&p))
            .map_err(ImportError::from);
        if let Err(e) = made {
            if full(&e) {
                stopped = Some("Stopped: the disk is full.".to_string());
                failure = Some(e);
                break;
            }
            skipped.push(format!("{folder}: {e}; its files may be missing"));
        }
    }
    if failure.is_none() {
        for out in &plan.files {
            if cancel.load(Ordering::Relaxed) {
                stopped = Some("Cancelled.".to_string());
                break;
            }
            match step(out) {
                Ok(()) => written += 1,
                Err(e) if full(&e) => {
                    stopped = Some(format!("Stopped by an error at {}: {e}.", out.path));
                    failure = Some(e);
                    break;
                }
                Err(e) => skipped.push(format!("{}: {e}; not imported", out.path)),
            }
            progress(written + skipped.len(), total);
        }
    }
    let mut counts = plan.counts.clone();
    counts.warnings.extend(skipped);
    let text = report_text(source, &counts, written, total, stopped.as_deref());
    // Best effort: a full disk may refuse the report too; the first error is
    // the one the user hears about.
    let saved = VaultPath::new(&plan.report)
        .and_then(|p| vault.write_cas(&p, text.as_bytes(), None).map(|_| ()));
    let failed = match (failure, saved) {
        (Some(e), _) => Some(e.to_string()),
        (None, Err(e)) => Some(format!("the report couldn't be written: {e}")),
        (None, Ok(())) => {
            written += 1;
            None
        }
    };
    progress(written, total);
    Ok(Report {
        root: target.to_path_buf(),
        report: plan.report.clone(),
        cancelled: failed.is_none() && stopped.is_some(),
        failed,
        written,
    })
}

/// A vault name from the zip's: `Export-<id>…` (Notion's default) is "Notion".
pub fn suggested_name(zip: &Path) -> String {
    let stem = zip
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if stem.is_empty() || stem.starts_with("Export-") {
        return "Notion".to_string();
    }
    clean_component(&stem, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Limits;
    use crate::archive::tests::zip_file;

    const A: &str = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
    const B: &str = "ffffffffffffffffffffffffffffffff";
    const C: &str = "0123456789abcdef0123456789abcdef";

    /// A small export with every shape the importer handles.
    fn sample() -> tempfile::NamedTempFile {
        let home = format!(
            "# Home\n\nSee [Child](Home%20{A}/Child%20{B}.md) and [Tasks](Home%20{A}/Tasks%20{C}.csv).\n\n![pic.png](Home%20{A}/pic.png)\n\n<aside>\n💡 Tip\n</aside>\n\n[gone](Nope.md)\n"
        );
        let child = "# Child\n\nBack to [Home](../Home%201a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md).\n"
            .to_string();
        let csv_all = format!(
            "Name,Status,Due,Related\nWrite intro,Done,\"October 1, 2026\",Child (Child%20{B}.md)\nShip it,,,\n"
        );
        let row = "# Write intro\n\nStatus: Done\nDue: October 1, 2026\nRelated: Child (../Child%20ffffffffffffffffffffffffffffffff.md)\n\nThe body.\n".to_string();
        let files: Vec<(String, Vec<u8>)> = vec![
            (format!("Home {A}.md"), home.into_bytes()),
            (format!("Home {A}/Child {B}.md"), child.into_bytes()),
            (format!("Home {A}/pic.png"), b"PNG".to_vec()),
            (
                format!("Home {A}/Tasks {C}.csv"),
                b"Name,Status\nWrite intro,Done\n".to_vec(),
            ),
            (format!("Home {A}/Tasks {C}_all.csv"), csv_all.into_bytes()),
            (
                format!("Home {A}/Tasks {C}/Write intro {B}.md"),
                row.into_bytes(),
            ),
            (
                format!("Home {A}/Tasks {C}/Stray {A}.md"),
                b"# Stray\n".to_vec(),
            ),
            (format!("Notes {A}.md"), b"# Notes\n".to_vec()),
            (format!("Notes {B}.md"), b"# Notes too\n".to_vec()),
        ];
        let refs: Vec<(&str, &[u8])> = files
            .iter()
            .map(|(n, b)| (n.as_str(), b.as_slice()))
            .collect();
        zip_file(&refs)
    }

    fn import(
        zip: &Path,
        cancel_after: Option<usize>,
    ) -> (tempfile::TempDir, Result<Report, ImportError>, Plan) {
        let export = Export::open(zip, &Limits::default()).unwrap();
        let plan = plan(&export, &AtomicBool::new(false)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let mut progress = |done: usize, _total: usize| {
            if Some(done) == cancel_after {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        let report = write(
            &export,
            &plan,
            "export.zip",
            &dir.path().join("Vault"),
            &mut progress,
            &cancel,
        );
        (dir, report, plan)
    }

    fn read(dir: &tempfile::TempDir, path: &str) -> String {
        std::fs::read_to_string(dir.path().join("Vault").join(path)).unwrap()
    }

    #[test]
    fn m7_previews_without_writing() {
        let zip = sample();
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        let preview = plan(&export, &AtomicBool::new(false)).unwrap().counts;
        assert_eq!(
            (
                preview.pages,
                preview.databases,
                preview.rows,
                preview.attachments,
                preview.folders
            ),
            (5, 1, 2, 1, 2),
            "{preview:?}"
        );
        assert!(
            preview.warnings.iter().any(|w| w.contains("Nope.md")),
            "{:?}",
            preview.warnings
        );
        assert!(
            preview
                .warnings
                .iter()
                .any(|w| w.contains("Stray") && w.contains("no row")),
            "{:?}",
            preview.warnings
        );
    }

    #[test]
    fn m7_imports_a_whole_export() {
        let (dir, report, _) = import(sample().path(), None);
        let report = report.unwrap();
        assert!(!report.cancelled);
        assert_eq!(report.report, REPORT);
        assert_eq!(
            read(&dir, "Home.md"),
            "# Home\n\nSee [[Child]] and [[Tasks]].\n\n![[Home/pic.png]]\n\n> [!note]\n> 💡 Tip\n\n[gone](Nope.md)\n"
        );
        assert_eq!(
            read(&dir, "Home/Child.md"),
            "# Child\n\nBack to [[Home]].\n"
        );
        assert_eq!(read(&dir, "Home/pic.png"), "PNG");
        // The row: properties as frontmatter, the property lines gone.
        assert_eq!(
            read(&dir, "Home/Tasks/Write intro.md"),
            "---\nStatus: \"Done\"\nDue: 2026-10-01\nRelated: [\"[[Child]]\"]\n---\n# Write intro\n\nThe body.\n"
        );
        // A row with no page gets one; the index page links both.
        assert_eq!(read(&dir, "Home/Tasks/Ship it.md"), "# Ship it\n");
        assert_eq!(
            read(&dir, "Home/Tasks.md"),
            "# Tasks\n\n| Name | Status | Due | Related |\n| --- | --- | --- | --- |\n| [[Home/Tasks/Write intro\\|Write intro]] | Done | October 1, 2026 | Child (Child%20ffffffffffffffffffffffffffffffff.md) |\n| [[Home/Tasks/Ship it\\|Ship it]] |  |  |  |\n"
        );
        // Duplicate names numbered; the plain CSV not written.
        assert_eq!(read(&dir, "Notes.md"), "# Notes\n");
        assert_eq!(read(&dir, "Notes 1.md"), "# Notes too\n");
        assert!(!dir.path().join("Vault/Home/Tasks.csv").exists());
        let text = read(&dir, REPORT);
        assert!(
            text.contains("| Database rows | 2 |") && text.contains("Nope.md"),
            "{text}"
        );
    }

    #[test]
    fn m7_never_writes_into_an_existing_folder() {
        let zip = sample();
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        let plan = plan(&export, &AtomicBool::new(false)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let err = write(
            &export,
            &plan,
            "x.zip",
            dir.path(),
            &mut |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(matches!(err, ImportError::Exists(_)), "{err}");
    }

    #[test]
    fn m7_cancel_keeps_what_was_written_and_says_so() {
        let (dir, report, plan) = import(sample().path(), Some(2));
        let report = report.unwrap();
        assert!(report.cancelled);
        assert_eq!(report.written, 3, "two files and the report");
        assert!(plan.total() > 3);
        assert!(read(&dir, REPORT).contains("**Cancelled.** 2 of"));
    }

    #[test]
    fn b6_review_i5_an_attached_csv_stays_a_file() {
        let home = format!("# Home\n\n[sales.csv](Home%20{A}/sales.csv)\n");
        let zip = zip_file(&[
            (&format!("Home {A}.md"), home.as_bytes()),
            (
                &format!("Home {A}/sales.csv"),
                b"Region,Total\nNorth,1\nSouth,2\n",
            ),
        ]);
        let (dir, report, plan) = import(zip.path(), None);
        report.unwrap();
        assert_eq!(
            read(&dir, "Home/sales.csv"),
            "Region,Total\nNorth,1\nSouth,2\n"
        );
        assert!(!dir.path().join("Vault/Home/sales.md").exists());
        assert!(!dir.path().join("Vault/Home/sales").exists());
        assert_eq!(read(&dir, "Home.md"), "# Home\n\n[[Home/sales.csv]]\n");
        assert_eq!(plan.preview().databases, 0);
        assert_eq!(plan.preview().attachments, 1);
    }

    #[test]
    fn b6_review_i5_a_csv_beside_its_rows_folder_is_a_database() {
        let zip = zip_file(&[
            ("Tasks.csv", b"Name\nA\n".as_slice()),
            ("Tasks/A.md", b"# A\n".as_slice()),
        ]);
        let (dir, report, plan) = import(zip.path(), None);
        report.unwrap();
        assert_eq!(plan.preview().databases, 1);
        assert!(read(&dir, "Tasks.md").starts_with("# Tasks\n"));
    }

    #[test]
    fn b6_review_m2_a_file_and_a_folder_of_one_name_both_import() {
        let zip = zip_file(&[
            ("Home", b"plain".as_slice()),
            ("Home/a.md", b"# a\n".as_slice()),
        ]);
        let (dir, report, _) = import(zip.path(), None);
        report.unwrap();
        assert_eq!(read(&dir, "Home"), "plain");
        assert_eq!(read(&dir, "Home 1/a.md"), "# a\n");
    }

    #[test]
    fn b6_review_m2_a_path_too_long_is_skipped_with_a_warning() {
        let deep = (0..6)
            .map(|_| "d".repeat(190))
            .collect::<Vec<_>>()
            .join("/");
        let long = format!("{deep}/a.md");
        let zip = zip_file(&[
            (long.as_str(), b"# a\n".as_slice()),
            ("ok.md", b"# ok\n".as_slice()),
        ]);
        let (dir, report, plan) = import(zip.path(), None);
        report.unwrap();
        assert_eq!(read(&dir, "ok.md"), "# ok\n");
        assert!(
            plan.preview()
                .warnings
                .iter()
                .any(|w| w.contains("too long")),
            "{:?}",
            plan.preview().warnings
        );
    }

    #[test]
    fn b6_review_m2_one_file_that_fails_is_a_warning_and_the_rest_imports() {
        let zip = sample();
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        let mut plan = plan(&export, &AtomicBool::new(false)).unwrap();
        // A file whose folder is a file: it can't be written.
        plan.files.insert(
            0,
            Out {
                path: "Notes.md/x.md".to_string(),
                body: Body::Text("x".to_string()),
            },
        );
        let dir = tempfile::tempdir().unwrap();
        let report = write(
            &export,
            &plan,
            "x.zip",
            &dir.path().join("Vault"),
            &mut |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(!report.cancelled);
        assert_eq!(read(&dir, "Notes.md"), "# Notes\n");
        let text = read(&dir, REPORT);
        assert!(text.contains("Notes.md/x.md"), "{text}");
    }

    #[test]
    fn b6_review_i3_the_plan_holds_no_converted_page() {
        let zip = sample();
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        let plan = plan(&export, &AtomicBool::new(false)).unwrap();
        // Exported pages are converted while writing; only what the import
        // makes up (a row with no page, the index page) is held as text.
        let held: Vec<&str> = plan
            .files
            .iter()
            .filter(|f| matches!(f.body, Body::Text(_)))
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(held, ["Home/Tasks/Ship it.md", "Home/Tasks.md"]);
        assert!(
            plan.files
                .iter()
                .any(|f| matches!(f.body, Body::Page { .. }))
        );
    }

    #[test]
    fn b6_review_i3_too_much_text_is_refused_in_the_preview() {
        let zip = sample();
        let limits = Limits {
            pages: 64,
            ..Limits::default()
        };
        let export = Export::open(zip.path(), &limits).unwrap();
        let err = plan(&export, &AtomicBool::new(false))
            .err()
            .expect("refused");
        assert!(matches!(err, ImportError::Limit(_)), "{err}");
    }

    #[test]
    fn b6_review_i2_planning_stops_when_cancelled() {
        let zip = sample();
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        let err = plan(&export, &AtomicBool::new(true))
            .err()
            .expect("cancelled");
        assert!(matches!(err, ImportError::Cancelled), "{err}");
    }

    #[test]
    fn b6_review_i8_m3_a_failed_report_is_said_and_the_vault_is_returned() {
        let zip = sample();
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        let mut plan = plan(&export, &AtomicBool::new(false)).unwrap();
        // The report can't be written where a folder already is.
        plan.report = "Home".to_string();
        let dir = tempfile::tempdir().unwrap();
        let report = write(
            &export,
            &plan,
            "x.zip",
            &dir.path().join("Vault"),
            &mut |_, _| {},
            &AtomicBool::new(false),
        )
        .expect("the vault is returned, not only an error");
        assert_eq!(report.root, dir.path().join("Vault"));
        assert!(
            report
                .failed
                .as_deref()
                .is_some_and(|f| f.contains("report")),
            "{report:?}"
        );
        assert_eq!(read(&dir, "Home.md").lines().next(), Some("# Home"));
    }

    #[test]
    fn b6_review_m1_a_folder_that_cant_be_made_is_reported() {
        let zip = sample();
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        let mut plan = plan(&export, &AtomicBool::new(false)).unwrap();
        let long = "d".repeat(300);
        plan.folders.insert(0, long.clone());
        let dir = tempfile::tempdir().unwrap();
        let _ = write(
            &export,
            &plan,
            "x.zip",
            &dir.path().join("Vault"),
            &mut |_, _| {},
            &AtomicBool::new(false),
        );
        let text = read(&dir, REPORT);
        assert!(text.contains(&long), "{text}");
    }

    #[test]
    fn m7_suggests_a_vault_name() {
        assert_eq!(
            suggested_name(Path::new("/x/Export-7c1e-Part-1.zip")),
            "Notion"
        );
        assert_eq!(
            suggested_name(Path::new(&format!("/x/Team wiki {A}.zip"))),
            "Team wiki"
        );
    }

    #[test]
    fn m7_civil_dates() {
        assert_eq!(civil(0), "1970-01-01");
        assert_eq!(civil(20_744), "2026-10-18");
    }

    /// Spec §10: 5,000 pages, 1,000 rows and 500 attachments in under 60 s.
    #[test]
    #[ignore = "release perf test: cargo test --release -p nimw-import -- --ignored"]
    fn m7_perf_five_thousand_pages() {
        let mut files: Vec<(String, Vec<u8>)> = Vec::new();
        for i in 0..5_000 {
            let folder = format!("Area {} {A}", i % 50);
            let body = format!(
                "# Page {i}\n\nLinks to [next](Page%20{}%20{A}.md) and ![x](img{}.png).\n\n{}\n",
                i + 1,
                i % 500,
                "Some text. ".repeat(80)
            );
            files.push((format!("{folder}/Page {i} {A}.md"), body.into_bytes()));
        }
        for i in 0..500 {
            files.push((format!("Area {} {A}/img{i}.png", i % 50), vec![7u8; 20_000]));
        }
        let mut csv = String::from("Name,Status,Points\n");
        for i in 0..1_000 {
            csv.push_str(&format!("Row {i},Done,{i}\n"));
            files.push((
                format!("DB {C}/Row {i} {B}.md"),
                format!("# Row {i}\n\nStatus: Done\nPoints: {i}\n\nBody\n").into_bytes(),
            ));
        }
        files.push((format!("DB {C}_all.csv"), csv.into_bytes()));
        let refs: Vec<(&str, &[u8])> = files
            .iter()
            .map(|(n, b)| (n.as_str(), b.as_slice()))
            .collect();
        let zip = zip_file(&refs);
        let started = std::time::Instant::now();
        let export = Export::open(zip.path(), &Limits::default()).unwrap();
        let plan = plan(&export, &AtomicBool::new(false)).unwrap();
        let preview = started.elapsed();
        let dir = tempfile::tempdir().unwrap();
        write(
            &export,
            &plan,
            "perf.zip",
            &dir.path().join("V"),
            &mut |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let total = started.elapsed();
        eprintln!("m7 perf: preview {preview:?}, preview + import {total:?}");
        assert!(preview.as_secs() < 10 && total.as_secs() < 60);
    }
}
