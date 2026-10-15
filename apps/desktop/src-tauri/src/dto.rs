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
    /// Frontmatter `cover-x` (0–100), a side cover's horizontal focus (M4b
    /// part 3 §3).
    #[serde(rename = "coverX")]
    pub cover_x: Option<u8>,
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
#[serde(rename_all = "camelCase")]
pub struct VaultSettingsDto {
    pub attachments: AttachmentsDto,
    /// Obsidian's `attachmentFolderPath` when set (it wins unless overridden).
    pub obsidian: Option<String>,
    /// NIMW's place wins over Obsidian's (M4b §5).
    pub override_obsidian: bool,
    /// The vault's default page width (`None`: the app's; M4b part 2 §1).
    pub page_width: Option<nimw_vault::PageWidth>,
    /// Pages with their own width.
    pub page_widths: std::collections::BTreeMap<String, nimw_vault::PageWidth>,
    /// Pages with their own cover height in px (cover resize).
    pub cover_heights: std::collections::BTreeMap<String, u32>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSettingsPatch {
    pub attachments: Option<AttachmentsDto>,
    pub override_obsidian: Option<bool>,
    /// `"readable"`, `"full"` or `"default"` (use the app setting).
    pub page_width: Option<String>,
}

/// `gv_children`'s argument: which level to open (M3a §3).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum GvLevelDto {
    Vault,
    Folder { path: String },
    Page { path: String },
}

/// One Global View card (M3a §4, §8).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GvCardDto {
    pub path: String,
    /// `"project" | "folder" | "page"`.
    pub kind: &'static str,
    pub title: String,
    pub subtitle: Option<String>,
    pub cover: Option<String>,
    pub cover_remote: bool,
    pub cover_y: Option<u8>,
    /// `cover-x` (0–100; M4b part 3 §3).
    pub cover_x: Option<u8>,
    /// `"top" | "left" | "right"` (M4b part 3 §3).
    pub cover_side: &'static str,
    pub excerpt: String,
    pub has_image: bool,
    pub has_audio: bool,
    pub index_page: Option<String>,
    /// Folders: `"named" | "index" | "picked" | "only"` (M3b §4).
    pub index_from: Option<&'static str>,
    pub pages: u32,
    pub folders: u32,
    pub child_titles: Vec<String>,
    /// Page levels: `"centre" | "in" | "out" | "both"`.
    pub relation: Option<&'static str>,
}

impl From<nimw_session::GvCard> for GvCardDto {
    fn from(c: nimw_session::GvCard) -> GvCardDto {
        use nimw_session::{CardKind, IndexFrom, Relation};
        GvCardDto {
            path: c.path,
            kind: match c.kind {
                CardKind::Project => "project",
                CardKind::Folder => "folder",
                CardKind::Page => "page",
            },
            title: c.title,
            subtitle: c.subtitle,
            cover: c.cover,
            cover_remote: c.cover_remote,
            cover_y: c.cover_y,
            cover_x: c.cover_x,
            cover_side: c.cover_side.as_str(),
            excerpt: c.excerpt,
            has_image: c.has_image,
            has_audio: c.has_audio,
            index_page: c.index_page,
            index_from: c.index_from.map(|f| match f {
                IndexFrom::Named => "named",
                IndexFrom::Index => "index",
                IndexFrom::Picked => "picked",
                IndexFrom::Only => "only",
            }),
            pages: c.pages,
            folders: c.folders,
            child_titles: c.child_titles,
            relation: c.relation.map(|r| match r {
                Relation::Centre => "centre",
                Relation::In => "in",
                Relation::Out => "out",
                Relation::Both => "both",
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GvLevelResultDto {
    pub cards: Vec<GvCardDto>,
    pub centre: Option<String>,
    /// Page levels: neighbours left out by the 200-card cap (final review
    /// m14); 0 elsewhere.
    pub omitted: u32,
}

/// One Global View edge (M3a §6).
#[derive(Debug, Clone, Serialize)]
pub struct GvEdgeDto {
    pub from: String,
    pub to: String,
    /// `"link" | "manual"`.
    pub kind: &'static str,
    pub count: u32,
    pub aggregated: bool,
    pub directed: bool,
    pub label: Option<String>,
}

impl From<nimw_session::GvEdge> for GvEdgeDto {
    fn from(e: nimw_session::GvEdge) -> GvEdgeDto {
        GvEdgeDto {
            from: e.from,
            to: e.to,
            kind: match e.kind {
                nimw_session::EdgeKind::Link => "link",
                nimw_session::EdgeKind::Manual => "manual",
            },
            count: e.count,
            aggregated: e.aggregated,
            directed: e.directed,
            label: e.label,
        }
    }
}
