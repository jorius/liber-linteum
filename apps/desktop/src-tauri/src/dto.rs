//! Serializable shapes returned to the UI (M1b spec §2.4), all camelCase.

use nimw_session::{IndexReport, RenameOutcome};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexReportDto {
    pub files: usize,
    pub pages: usize,
    pub parsed: usize,
    pub skipped_unchanged: usize,
    pub removed: usize,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

impl From<&IndexReport> for IndexReportDto {
    fn from(r: &IndexReport) -> IndexReportDto {
        IndexReportDto {
            files: r.files,
            pages: r.pages,
            parsed: r.parsed,
            skipped_unchanged: r.skipped_unchanged,
            removed: r.removed,
            warnings: r.warnings.clone(),
            duration_ms: r.duration.as_millis() as u64,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub name: String,
    pub root: String,
    pub report: IndexReportDto,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeNodeDto {
    pub path: String,
    /// `"page" | "folder" | "attachment"`.
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageDto {
    pub path: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub cover: Option<String>,
    /// Frontmatter `cover-y` (0–100), M2c §4.
    #[serde(rename = "coverY")]
    pub cover_y: Option<u8>,
    pub tags: Vec<String>,
    pub links: usize,
    pub backlinks: usize,
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcomeDto {
    pub moved: Vec<(String, String)>,
    pub updated_files: Vec<String>,
    pub updated_links: usize,
    pub failed: Vec<(String, String)>,
}

impl From<RenameOutcome> for RenameOutcomeDto {
    fn from(o: RenameOutcome) -> RenameOutcomeDto {
        RenameOutcomeDto {
            moved: o.moved,
            updated_files: o.updated_files,
            updated_links: o.updated_links,
            failed: o.failed,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressPayload {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedPayload {
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
    pub renamed: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WarningPayload {
    pub message: String,
}

/// A file saved into (or found in) the vault for a page (M2c §7.3).
#[derive(Debug, Clone, Serialize)]
pub struct AttachedDto {
    pub path: String,
    pub link: String,
    pub copied: bool,
}

impl From<nimw_session::Attached> for AttachedDto {
    fn from(a: nimw_session::Attached) -> AttachedDto {
        AttachedDto {
            path: a.path.to_string(),
            link: a.link,
            copied: a.copied,
        }
    }
}

/// One dropped path's outcome: `ok` or `err`.
#[derive(Debug, Clone, Serialize)]
pub struct ImportResultDto {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<AttachedDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<crate::error::CommandError>,
}

/// `cover_pick`: the imported image and its frontmatter `cover:` value.
#[derive(Debug, Clone, Serialize)]
pub struct CoverDto {
    pub path: String,
    pub reference: String,
}

/// One `[[` suggestion (M2c §7.2).
#[derive(Debug, Clone, Serialize)]
pub struct LinkSuggestionDto {
    pub path: String,
    /// `"page" | "attachment"`.
    pub kind: &'static str,
    pub title: Option<String>,
    pub target: String,
}

/// `.nimw/vault.json` attachments: `vault` | `same` | `subfolder` | `folder`.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct AttachmentsDto {
    pub mode: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultSettingsDto {
    pub attachments: AttachmentsDto,
    /// Obsidian's `attachmentFolderPath` when set (it wins).
    pub obsidian: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct VaultSettingsPatch {
    pub attachments: Option<AttachmentsDto>,
}
