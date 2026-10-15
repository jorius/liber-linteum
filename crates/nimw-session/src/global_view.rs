//! M3a §3, §4, §8: Global View levels and cards — the vault (projects and
//! root pages), a folder (subfolders and pages) or a page and its
//! neighbourhood — read from the index in a few queries.

use crate::error::{Result, SessionError};
use crate::session::VaultSession;
use nimw_index::{CardRow, FileKind, Index, PageLink};
use nimw_markdown::{LinkKind, name_key};
use nimw_vault::{AttachmentPolicy, CoverSide, VaultPath};
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

/// Which GV-02 rule chose a folder's index note (M3b §4): a pick is offered
/// only where rules 1–2 give nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexFrom {
    /// Rule 1: a page named like the folder.
    Named,
    /// Rule 2: `index.md`.
    Index,
    /// Rule 3: `.nimw/vault.json` `indexPicks`.
    Picked,
    /// Rule 4: the folder's only page.
    Only,
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
    /// `cover-x` (0–100), the horizontal focus (M4b part 3 §3).
    pub cover_x: Option<u8>,
    /// Where the cover sits (`.nimw/vault.json` `coverSides`; §3).
    pub cover_side: CoverSide,
    pub excerpt: String,
    pub has_image: bool,
    pub has_audio: bool,
    /// Folders: the page previewed on the card (GV-02).
    pub index_page: Option<String>,
    /// Folders: the rule that chose `index_page`.
    pub index_from: Option<IndexFrom>,
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
    /// Page levels: neighbours left out by the [`MAX_NEIGHBOURS`] cap.
    pub omitted: u32,
}

/// Most child titles a folder summary lists.
pub const SUMMARY_TITLES: usize = 5;

/// Most neighbour cards a page level shows around its centre (final review
/// m14): a hub page with thousands of backlinks would otherwise make more
/// cards than `gv_edges` accepts ([`MAX_VISIBLE`]).
pub const MAX_NEIGHBOURS: usize = 200;

/// A card's cover placement (M4b part 3 §3): its page's, or for a folder
/// card the index note's it previews.
fn place_cover(sides: &BTreeMap<String, CoverSide>, card: &mut GvCard) {
    let page = match card.kind {
        CardKind::Page => Some(&card.path),
        CardKind::Folder | CardKind::Project => card.index_page.as_ref(),
    };
    card.cover_side = page.and_then(|p| sides.get(p)).copied().unwrap_or_default();
}

impl VaultSession {
    /// The cards of one Global View level (M3a §3), with their cover
    /// placements (M4b part 3 §3).
    pub fn gv_children(&self, level: &GvLevel) -> Result<GvChildren> {
        let mut out = self.level_cards(level)?;
        let sides = self.vault.cover_sides();
        for card in &mut out.cards {
            place_cover(&sides, card);
        }
        Ok(out)
    }

    fn level_cards(&self, level: &GvLevel) -> Result<GvChildren> {
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
                omitted: 0,
            }),
            GvLevel::Folder(folder) => {
                match index.card(folder.as_str())? {
                    Some(row) if row.kind == FileKind::Folder => {}
                    _ => return Err(SessionError::NotIndexed(folder.to_string())),
                }
                Ok(GvChildren {
                    cards: ctx.children(folder.as_str(), CardKind::Folder)?,
                    centre: None,
                    omitted: 0,
                })
            }
            GvLevel::Page(page) => {
                let centre = match index.card(page.as_str())? {
                    Some(row) if row.kind == FileKind::Page => row,
                    _ => return Err(SessionError::NotIndexed(page.to_string())),
                };
                let around = neighbours(page.as_str(), &index.page_links_of(page.as_str())?);
                let (around, omitted) = cap_neighbours(&index, around)?;
                let mut cards = vec![page_card(&centre, Some(Relation::Centre))];
                for n in around {
                    if let Some(row) = index.card(&n.path)? {
                        cards.push(page_card(&row, Some(n.relation)));
                    }
                }
                Ok(GvChildren {
                    cards,
                    centre: Some(page.to_string()),
                    omitted,
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

    /// A folder's direct pages and visible subfolders.
    fn contents(&self, folder: &str) -> Result<(Vec<CardRow>, Vec<CardRow>)> {
        let (mut pages, mut subfolders) = (Vec::new(), Vec::new());
        for row in self.index.card_children(folder)? {
            match row.kind {
                FileKind::Page => pages.push(row),
                FileKind::Folder if !is_attachment_folder(self.policy, &row.path) => {
                    subfolders.push(row);
                }
                _ => {}
            }
        }
        Ok((pages, subfolders))
    }

    /// A folder's index note and the GV-02 rule that chose it, from its
    /// direct pages and visible subfolders.
    fn index_note(
        &self,
        folder: &CardRow,
        pages: &[CardRow],
        subfolders: &[CardRow],
    ) -> (Option<CardRow>, Option<IndexFrom>) {
        let own = name_key(&folder.name);
        let named_like = pages.iter().find(|r| name_key(stem(&r.name)) == own);
        let index_md = pages.iter().find(|r| name_key(&r.name) == "index.md");
        // A pick holds only for a page directly in the folder; one that
        // points elsewhere (hand-edited, or left by an older version) is
        // ignored (final review I4).
        let picked = self
            .picks
            .get(&folder.path)
            .and_then(|p| pages.iter().find(|r| &r.path == p));
        let only = (pages.len() == 1 && subfolders.is_empty()).then(|| &pages[0]);
        let (row, from) = if let Some(r) = named_like {
            (Some(r), Some(IndexFrom::Named))
        } else if let Some(r) = index_md {
            (Some(r), Some(IndexFrom::Index))
        } else if let Some(r) = picked {
            (Some(r), Some(IndexFrom::Picked))
        } else if let Some(r) = only {
            (Some(r), Some(IndexFrom::Only))
        } else {
            (None, None)
        };
        (row.cloned(), from)
    }

    /// The index note of the folder at `path`, if it is one and has one.
    fn index_page_of(&self, path: &str) -> Result<Option<String>> {
        let Some(folder) = self
            .index
            .card(path)?
            .filter(|r| r.kind == FileKind::Folder)
        else {
            return Ok(None);
        };
        let (pages, subfolders) = self.contents(path)?;
        Ok(self
            .index_note(&folder, &pages, &subfolders)
            .0
            .map(|r| r.path))
    }

    /// A folder card: its index note's preview, else a summary (GV-02).
    fn folder_card(&self, folder: &CardRow, kind: CardKind) -> Result<GvCard> {
        let (pages, subfolders) = self.contents(&folder.path)?;
        let child_titles: Vec<String> = subfolders
            .iter()
            .map(|r| r.name.clone())
            .chain(pages.iter().map(title_of))
            .take(SUMMARY_TITLES)
            .collect();
        let (index_row, index_from) = self.index_note(folder, &pages, &subfolders);
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
                cover_x: None,
                cover_side: CoverSide::Top,
                excerpt: child_titles.join(" · "),
                has_image: false,
                has_audio: false,
                index_page: None,
                index_from: None,
                pages: 0,
                folders: 0,
                child_titles: Vec::new(),
                relation: None,
            },
        };
        card.path = folder.path.clone();
        card.kind = kind;
        card.index_page = index_row.map(|r| r.path);
        card.index_from = index_from;
        card.pages = pages.len() as u32;
        card.folders = subfolders.len() as u32;
        card.child_titles = child_titles;
        Ok(card)
    }
}

impl VaultSession {
    /// Picks (`Some`) or clears (`None`) the index note of `folder`, a
    /// visible folder; the page must be a page directly inside it (M3b §4,
    /// §6). Answers the folder's card as the Global View now shows it.
    pub fn index_pick_set(&self, folder: &VaultPath, page: Option<&VaultPath>) -> Result<GvCard> {
        let row = {
            let index = self.index();
            let row = index
                .card(folder.as_str())?
                .filter(|r| r.kind == FileKind::Folder)
                .ok_or_else(|| SessionError::NotIndexed(folder.to_string()))?;
            if let Some(page) = page {
                let inside = page.parent().is_some_and(|p| p.as_str() == folder.as_str());
                let is_page = index
                    .card(page.as_str())?
                    .is_some_and(|r| r.kind == FileKind::Page);
                if !inside || !is_page {
                    return Err(SessionError::NotIndexed(page.to_string()));
                }
            }
            row
        };
        self.vault
            .set_index_pick(folder.as_str(), page.map(VaultPath::as_str))?;
        let policy = self.vault.attachment_policy();
        let picks = self.vault.index_picks();
        let index = self.index();
        let ctx = Ctx {
            index: &index,
            policy: &policy,
            picks: &picks,
        };
        let kind = if folder.as_str().contains('/') {
            CardKind::Folder
        } else {
            CardKind::Project
        };
        let mut card = ctx.folder_card(&row, kind)?;
        place_cover(&self.vault.cover_sides(), &mut card);
        Ok(card)
    }

    /// The wiki target a relationship from `source` to `target` writes: the
    /// shortest one that resolves back to `target` (M3b §2, §6).
    pub fn link_target(&self, source: &VaultPath, target: &VaultPath) -> Result<String> {
        let index = self.index();
        if index.card(target.as_str())?.is_none() {
            return Err(SessionError::NotIndexed(target.to_string()));
        }
        let files = index.file_set()?;
        Ok(nimw_markdown::shortest_unique_target(
            target.as_str(),
            source.as_str(),
            &files,
            LinkKind::FrontmatterRelated,
            false,
        ))
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
        cover_x: row.cover_x,
        cover_side: CoverSide::Top,
        excerpt: row.excerpt.clone().unwrap_or_default(),
        has_image: row.has_image,
        has_audio: row.has_audio,
        index_page: None,
        index_from: None,
        pages: 0,
        folders: 0,
        child_titles: Vec::new(),
        relation,
    }
}

/// A page around a page level's centre.
struct Neighbour {
    path: String,
    relation: Relation,
    /// The centre links to it, or they are related (`related:`): kept
    /// before plain backlinks when the neighbourhood is capped.
    preferred: bool,
}

/// The pages around `centre`, by name: links out (and undirected
/// relationships either way) go right, links in and relationships directed
/// at the centre go left; both ways is `Both`.
fn neighbours(centre: &str, links: &[PageLink]) -> Vec<Neighbour> {
    // (in, out, preferred) per page.
    let mut sides: BTreeMap<(String, String), (bool, bool, bool)> = BTreeMap::new();
    for l in links {
        let related = l.kind == LinkKind::FrontmatterRelated;
        let (other, out) = if l.src == centre && l.target != centre {
            (&l.target, true)
        } else if l.target == centre && l.src != centre {
            (&l.src, related && !l.directed)
        } else {
            continue;
        };
        let file = other.rsplit('/').next().unwrap_or(other);
        let entry = sides
            .entry((name_key(file), other.clone()))
            .or_insert((false, false, false));
        if out {
            entry.1 = true;
        } else {
            entry.0 = true;
        }
        entry.2 |= l.src == centre || related;
    }
    sides
        .into_iter()
        .map(|((_, path), (into, out, preferred))| {
            let relation = match (into, out) {
                (true, true) => Relation::Both,
                (true, false) => Relation::In,
                _ => Relation::Out,
            };
            Neighbour {
                path,
                relation,
                preferred,
            }
        })
        .collect()
}

/// At most [`MAX_NEIGHBOURS`] of `around`, still in name order, and how many
/// were left out (final review m14). Pages the centre links to and related
/// pages come first, then backlinks; within each, the most recently
/// modified first.
fn cap_neighbours(index: &Index, around: Vec<Neighbour>) -> Result<(Vec<Neighbour>, u32)> {
    if around.len() <= MAX_NEIGHBOURS {
        return Ok((around, 0));
    }
    let mut ranked = Vec::with_capacity(around.len());
    for (at, n) in around.iter().enumerate() {
        let mtime = index.stat(&n.path)?.map_or(i64::MIN, |s| s.mtime_ns);
        ranked.push((!n.preferred, std::cmp::Reverse(mtime), at));
    }
    ranked.sort_unstable();
    let keep: std::collections::HashSet<usize> = ranked[..MAX_NEIGHBOURS]
        .iter()
        .map(|&(_, _, at)| at)
        .collect();
    let omitted = (around.len() - MAX_NEIGHBOURS) as u32;
    let kept = around
        .into_iter()
        .enumerate()
        .filter_map(|(at, n)| keep.contains(&at).then_some(n))
        .collect();
    Ok((kept, omitted))
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

impl VaultSession {
    /// Pinned Global View positions follow renames (M3a §7), all of them in
    /// one layout update (final review I3). The layout is a convenience: a
    /// failure is reported, never fails the rename.
    pub(crate) fn follow_layout(&self, renames: &[(String, String)]) {
        // Index-note picks follow too (M3b §4).
        let picks = self.vault.remap_index_picks_many(renames);
        // Page widths follow too (M4b part 2 §1), and cover heights, sides
        // and strip widths (part 3 §3).
        let widths = self.vault.remap_page_widths_many(renames);
        let heights = self.vault.remap_cover_heights_many(renames);
        let sides = self.vault.remap_cover_sides_many(renames);
        let strips = self.vault.remap_cover_widths_many(renames);
        if let Err(e) = self
            .vault
            .remap_layout_many(renames)
            .and(picks)
            .and(widths)
            .and(heights)
            .and(sides)
            .and(strips)
        {
            let what = match renames {
                [(from, to)] => format!("{from} → {to}"),
                _ => format!("{} renamed entries", renames.len()),
            };
            self.emit(crate::events::SessionEvent::Warning(format!(
                "Global View layout not updated for {what}: {e}"
            )));
        }
    }
}

/// Edge kinds drawn from the index (parent/child edges are drawn by the UI).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EdgeKind {
    /// Text links and page embeds.
    Link,
    /// `related:` relationships (GV-22–24).
    Manual,
}

/// One edge between two visible cards (M3a §6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GvEdge {
    /// Undirected edges: the smaller path. Directed ones: the source.
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    /// Links (or relationships) folded into this edge.
    pub count: u32,
    /// An end stands for a folder card the link starts or ends inside (GV-25).
    pub aggregated: bool,
    /// Manual edges: an entry for this pair is directed (`from` → `to`).
    pub directed: bool,
    /// Manual edges: the first label found for this pair.
    pub label: Option<String>,
}

/// Most cards one `gv_edges` call may name.
pub const MAX_VISIBLE: usize = 1000;

impl VaultSession {
    /// Edges between `visible` cards: every resolved page-to-page link and
    /// relationship, each end moved to its nearest visible ancestor-or-self,
    /// one edge per card pair and kind with a count (GV-20, GV-25).
    ///
    /// A folder card stands for its index note in a relationship (M3b §2),
    /// so a relationship whose ends are both the cards' own pages or index
    /// notes is direct, not "from inside folders" (final review I3). An edge
    /// that holds one is direct: it is labelled and oriented by its direct
    /// relationships, and counts the others too.
    pub fn gv_edges(&self, visible: &[String]) -> Result<Vec<GvEdge>> {
        if visible.is_empty() {
            return Ok(Vec::new());
        }
        let shown: std::collections::HashSet<&str> = visible.iter().map(String::as_str).collect();
        let lift = |path: &str| -> Option<String> {
            let mut p = path;
            loop {
                if shown.contains(p) {
                    return Some(p.to_string());
                }
                p = &p[..p.rfind('/')?];
            }
        };
        let policy = self.vault.attachment_policy();
        let picks = self.vault.index_picks();
        let index = self.index();
        let ctx = Ctx {
            index: &index,
            policy: &policy,
            picks: &picks,
        };
        // Folder cards' index notes, read when a relationship needs one.
        let mut index_pages: HashMap<String, Option<String>> = HashMap::new();
        let mut stands_for = |card: &str, page: &str| -> Result<bool> {
            if card == page {
                return Ok(true);
            }
            if !index_pages.contains_key(card) {
                index_pages.insert(card.to_string(), ctx.index_page_of(card)?);
            }
            Ok(index_pages[card].as_deref() == Some(page))
        };
        // A link whose source isn't shown (or inside a shown folder) can't
        // become an edge, so only those are read.
        let links = index.page_links_from(visible)?;
        // Each edge, and whether it holds a direct relationship.
        let mut edges: BTreeMap<(String, String, EdgeKind), (GvEdge, bool)> = BTreeMap::new();
        for l in links {
            let (Some(a), Some(b)) = (lift(&l.src), lift(&l.target)) else {
                continue;
            };
            if a == b {
                continue;
            }
            let kind = if l.kind == LinkKind::FrontmatterRelated {
                EdgeKind::Manual
            } else {
                EdgeKind::Link
            };
            let lifted = a != l.src || b != l.target;
            let direct =
                kind == EdgeKind::Manual && stands_for(&a, &l.src)? && stands_for(&b, &l.target)?;
            let (lo, hi) = if a < b { (&a, &b) } else { (&b, &a) };
            let (edge, has_direct) =
                edges
                    .entry((lo.clone(), hi.clone(), kind))
                    .or_insert_with(|| {
                        let edge = GvEdge {
                            from: lo.clone(),
                            to: hi.clone(),
                            kind,
                            count: 0,
                            aggregated: false,
                            directed: false,
                            label: None,
                        };
                        (edge, false)
                    });
            edge.count += 1;
            if kind == EdgeKind::Link {
                edge.aggregated |= lifted;
                continue;
            }
            if direct && !*has_direct {
                // The first direct relationship: from now on only those
                // label and orient the edge.
                *has_direct = true;
                edge.label = None;
                edge.directed = false;
                edge.from = lo.clone();
                edge.to = hi.clone();
            } else if !direct && *has_direct {
                continue;
            }
            if edge.label.is_none() {
                edge.label = l.label.clone().filter(|s| !s.trim().is_empty());
            }
            if l.directed && !edge.directed {
                edge.directed = true;
                edge.from = a.clone();
                edge.to = b.clone();
            }
        }
        Ok(edges
            .into_values()
            .map(|(mut edge, has_direct)| {
                if edge.kind == EdgeKind::Manual {
                    edge.aggregated = !has_direct;
                }
                edge
            })
            .collect())
    }
}
