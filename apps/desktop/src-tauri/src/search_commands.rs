//! M5 §5: search — one command, a thin wrapper over `nimw-session`.

use crate::error::CmdResult;
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_session::{FacetCount, FacetPage, SearchHit, SearchPage, SearchQuery, SnippetPart};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// Longest text searched; longer input is cut (a paste, not a query).
const MAX_TEXT_CHARS: usize = 500;
/// Most tag filters at once.
const MAX_TAGS: usize = 20;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQueryDto {
    pub text: String,
    pub project: Option<String>,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub links_to: Option<String>,
    pub links_from: Option<String>,
    pub has_image: bool,
    pub has_audio: bool,
    pub archived: bool,
    /// Only text and code files (batch 6).
    pub text_files: bool,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetPartDto {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitDto {
    pub path: String,
    pub title: String,
    pub cover: Option<String>,
    pub tags: Vec<String>,
    pub has_image: bool,
    pub has_audio: bool,
    pub snippet: Option<Vec<SnippetPartDto>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetCountDto {
    pub value: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetPageDto {
    pub path: String,
    pub title: String,
    pub count: u32,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetsDto {
    pub projects: Vec<FacetCountDto>,
    pub tags: Vec<FacetCountDto>,
    pub links_to: Vec<FacetPageDto>,
    pub links_from: Option<FacetPageDto>,
    pub has_image: u32,
    pub has_audio: u32,
    pub archived: u32,
    pub text_files: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPageDto {
    pub results: Vec<SearchHitDto>,
    pub total: u32,
    pub facets: FacetsDto,
    pub recent: bool,
    pub indexing: bool,
}

fn count(f: FacetCount) -> FacetCountDto {
    FacetCountDto {
        value: f.value,
        count: f.count,
    }
}

fn page(f: FacetPage) -> FacetPageDto {
    FacetPageDto {
        path: f.path,
        title: f.title,
        count: f.count,
        active: f.active,
    }
}

fn part(p: SnippetPart) -> SnippetPartDto {
    SnippetPartDto {
        text: p.text,
        hit: p.hit,
    }
}

fn hit(h: SearchHit) -> SearchHitDto {
    SearchHitDto {
        path: h.path,
        title: h.title,
        cover: h.cover,
        tags: h.tags,
        has_image: h.has_image,
        has_audio: h.has_audio,
        snippet: h.snippet.map(|s| s.into_iter().map(part).collect()),
    }
}

impl From<SearchPage> for SearchPageDto {
    fn from(p: SearchPage) -> SearchPageDto {
        SearchPageDto {
            results: p.results.into_iter().map(hit).collect(),
            total: p.total,
            facets: FacetsDto {
                projects: p.facets.projects.into_iter().map(count).collect(),
                tags: p.facets.tags.into_iter().map(count).collect(),
                links_to: p.facets.links_to.into_iter().map(page).collect(),
                links_from: p.facets.links_from.map(page),
                has_image: p.facets.has_image,
                has_audio: p.facets.has_audio,
                archived: p.facets.archived,
                text_files: p.facets.text_files,
            },
            recent: p.recent,
            indexing: p.indexing,
        }
    }
}

pub(crate) fn search_impl(state: &AppState, q: SearchQueryDto) -> CmdResult<SearchPageDto> {
    let session = state.session()?;
    let query = SearchQuery {
        text: q.text.chars().take(MAX_TEXT_CHARS).collect(),
        project: q.project,
        folder: q.folder,
        tags: q.tags.into_iter().take(MAX_TAGS).collect(),
        links_to: q.links_to,
        links_from: q.links_from,
        has_image: q.has_image,
        has_audio: q.has_audio,
        archived: q.archived,
        text_files: q.text_files,
        offset: q.offset,
        limit: q.limit,
    };
    Ok(session.search(&query)?.into())
}

#[tauri::command]
pub async fn search<R: Runtime>(
    app: AppHandle<R>,
    query: SearchQueryDto,
) -> CmdResult<SearchPageDto> {
    blocking(app, move |app| search_impl(&app.state::<AppState>(), query)).await
}
