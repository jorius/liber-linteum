//! M3a §3, §4, §8: Global View levels and cards — the vault (projects and
//! root pages), a folder (subfolders and pages) or a page and its
//! neighbourhood — read from the index in a few queries.

use crate::error::{Result, SessionError};
use crate::session::VaultSession;
use nimw_index::{CardRow, FileKind, Index, PageLink};
use nimw_markdown::{LinkKind, name_key};
use nimw_vault::{AttachmentPolicy, VaultPath};
use std::collections::{BTreeMap, HashMap};

/// What one click opens (M3a §3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GvLevel {
    /// Level 0: projects and the pages in the vault root (GV-10).
    Vault,
    /// A folder's subfolders and pages.
    Folder(VaultPath),
    /// A page and the pages it links to, links from and is related to (GV-16).
    Page(VaultPath),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardKind {
    /// A top-level folder.
    Project,
    Folder,
    Page,
}

/// Where a page sits in another page's neighbourhood (layout side, §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    Centre,
    /// Links (or is directed) to the centre page: shown left.
    In,
    /// The centre links to it, or an undirected relationship: shown right.
    Out,
    Both,
}

/// One Global View card (M3a §4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GvCard {
    pub path: String,
    pub kind: CardKind,
    pub title: String,
    pub subtitle: Option<String>,
    /// The cover's vault path; `None` for no, remote or missing covers.
    pub cover: Option<String>,
    pub cover_remote: bool,
    pub cover_y: Option<u8>,
    pub excerpt: String,
    pub has_image: bool,
    pub has_audio: bool,
    /// Folders: the page previewed on the card (GV-02).
    pub index_page: Option<String>,
    /// Folders: direct pages and (visible) subfolders.
    pub pages: u32,
    pub folders: u32,
    /// Folders: the first child names/titles (folder summary).
    pub child_titles: Vec<String>,
    /// Page levels: the card's place around the centre.
    pub relation: Option<Relation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GvChildren {
    pub cards: Vec<GvCard>,
    /// Page levels: the page itself.
    pub centre: Option<String>,
}

/// Most child titles a folder summary lists.
pub const SUMMARY_TITLES: usize = 5;

impl VaultSession {
    /// The cards of one Global View level (M3a §3).
    pub fn gv_children(&self, level: &GvLevel) -> Result<GvChildren> {
        let policy = self.vault.attachment_policy();
        let picks = self.vault.index_picks();
        let index = self.index();
        let ctx = Ctx {
            index: &index,
            policy: &policy,
            picks: &picks,
        };
        match level {
            GvLevel::Vault => Ok(GvChildren {
                cards: ctx.children("", CardKind::Project)?,
                centre: None,
            }),
            GvLevel::Folder(folder) => {
                match index.card(folder.as_str())? {
                    Some(row) if row.kind == FileKind::Folder => {}
                    _ => return Err(SessionError::NotIndexed(folder.to_string())),
                }
                Ok(GvChildren {
                    cards: ctx.children(folder.as_str(), CardKind::Folder)?,
                    centre: None,
                })
            }
            GvLevel::Page(page) => {
                let centre = match index.card(page.as_str())? {
                    Some(row) if row.kind == FileKind::Page => row,
                    _ => return Err(SessionError::NotIndexed(page.to_string())),
                };
                let mut cards = vec![page_card(&centre, Some(Relation::Centre))];
                for (path, relation) in
                    neighbours(page.as_str(), &index.page_links_of(page.as_str())?)
                {
                    if let Some(row) = index.card(&path)? {
                        cards.push(page_card(&row, Some(relation)));
                    }
                }
                Ok(GvChildren {
                    cards,
                    centre: Some(page.to_string()),
                })
            }
        }
    }
}

struct Ctx<'a> {
    index: &'a Index,
    policy: &'a AttachmentPolicy,
    picks: &'a HashMap<String, String>,
}

impl Ctx<'_> {
    /// Cards for the entries inside `parent`: folders (as `folder_kind`),
    /// then pages; attachments and attachment folders are left out.
    fn children(&self, parent: &str, folder_kind: CardKind) -> Result<Vec<GvCard>> {
        let mut cards = Vec::new();
        for row in self.index.card_children(parent)? {
            match row.kind {
                FileKind::Folder if !is_attachment_folder(self.policy, &row.path) => {
                    cards.push(self.folder_card(&row, folder_kind)?);
                }
                FileKind::Page => cards.push(page_card(&row, None)),
                _ => {}
            }
        }
        Ok(cards)
    }

    /// A folder card: its index note's preview, else a summary (GV-02).
    fn folder_card(&self, folder: &CardRow, kind: CardKind) -> Result<GvCard> {
        let children = self.index.card_children(&folder.path)?;
        let subfolders: Vec<&CardRow> = children
            .iter()
            .filter(|r| r.kind == FileKind::Folder && !is_attachment_folder(self.policy, &r.path))
            .collect();
        let pages: Vec<&CardRow> = children
            .iter()
            .filter(|r| r.kind == FileKind::Page)
            .collect();
        let child_titles: Vec<String> = subfolders
            .iter()
            .map(|r| r.name.clone())
            .chain(pages.iter().map(|r| title_of(r)))
            .take(SUMMARY_TITLES)
            .collect();
        let own = name_key(&folder.name);
        let named_like = pages.iter().find(|r| name_key(stem(&r.name)) == own);
        let index_md = pages.iter().find(|r| name_key(&r.name) == "index.md");
        let picked = match self.picks.get(&folder.path) {
            Some(p) => self.index.card(p)?.filter(|r| r.kind == FileKind::Page),
            None => None,
        };
        let index_row: Option<CardRow> = named_like
            .or(index_md)
            .map(|r| (*r).clone())
            .or(picked)
            .or_else(|| (pages.len() == 1 && subfolders.is_empty()).then(|| pages[0].clone()));
        let mut card = match &index_row {
            Some(row) => page_card(row, None),
            None => GvCard {
                path: String::new(),
                kind,
                title: folder.name.clone(),
                subtitle: Some(folder.name.clone()),
                cover: None,
                cover_remote: false,
                cover_y: None,
                excerpt: child_titles.join(" · "),
                has_image: false,
                has_audio: false,
                index_page: None,
                pages: 0,
                folders: 0,
                child_titles: Vec::new(),
                relation: None,
            },
        };
        card.path = folder.path.clone();
        card.kind = kind;
        card.index_page = index_row.map(|r| r.path);
        card.pages = pages.len() as u32;
        card.folders = subfolders.len() as u32;
        card.child_titles = child_titles;
        Ok(card)
    }
}

/// A page's card data from its index row.
fn page_card(row: &CardRow, relation: Option<Relation>) -> GvCard {
    let remote = row.cover.as_deref().is_some_and(has_scheme);
    GvCard {
        path: row.path.clone(),
        kind: CardKind::Page,
        title: title_of(row),
        subtitle: row.subtitle.clone(),
        cover: if remote { None } else { row.cover_path.clone() },
        cover_remote: remote,
        cover_y: row.cover_y,
        excerpt: row.excerpt.clone().unwrap_or_default(),
        has_image: row.has_image,
        has_audio: row.has_audio,
        index_page: None,
        pages: 0,
        folders: 0,
        child_titles: Vec::new(),
        relation,
    }
}

/// The pages around `centre`, by name: links out (and undirected
/// relationships either way) go right, links in and relationships directed
/// at the centre go left; both ways is `Both`.
fn neighbours(centre: &str, links: &[PageLink]) -> Vec<(String, Relation)> {
    let mut sides: BTreeMap<(String, String), (bool, bool)> = BTreeMap::new();
    for l in links {
        let (other, out) = if l.src == centre && l.target != centre {
            (&l.target, true)
        } else if l.target == centre && l.src != centre {
            let undirected_related = l.kind == LinkKind::FrontmatterRelated && !l.directed;
            (&l.src, undirected_related)
        } else {
            continue;
        };
        let file = other.rsplit('/').next().unwrap_or(other);
        let entry = sides
            .entry((name_key(file), other.clone()))
            .or_insert((false, false));
        if out {
            entry.1 = true;
        } else {
            entry.0 = true;
        }
    }
    sides
        .into_iter()
        .map(|((_, path), side)| {
            let relation = match side {
                (true, true) => Relation::Both,
                (true, false) => Relation::In,
                _ => Relation::Out,
            };
            (path, relation)
        })
        .collect()
}

/// True when `path` is where the vault's attachments go (M3a §3.1).
pub(crate) fn is_attachment_folder(policy: &AttachmentPolicy, path: &str) -> bool {
    match policy {
        AttachmentPolicy::Subfolder(sub) => {
            let key = name_key(path);
            let sub = name_key(sub);
            key == sub || key.ends_with(&format!("/{sub}"))
        }
        AttachmentPolicy::Folder(folder) => name_key(path) == name_key(folder.as_str()),
        AttachmentPolicy::VaultRoot | AttachmentPolicy::SameAsNote => false,
    }
}

fn title_of(row: &CardRow) -> String {
    row.title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| stem(&row.name).to_string())
}

fn stem(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((s, ext)) if !s.is_empty() && ext.eq_ignore_ascii_case("md") => s,
        _ => name,
    }
}

/// `https:`, `data:`… — a cover that isn't a vault path (M2a URL policy).
fn has_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        && scheme.len() > 1
}
