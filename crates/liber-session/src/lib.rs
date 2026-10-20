//! One open vault: indexing, watching and file operations, composed from
//! `liber-vault` (filesystem), `liber-markdown` (parsing) and `liber-index` (cache).

mod attachments;
mod bin;
mod editing;
mod error;
mod events;
mod external;
mod global_view;
mod quick_notes;
mod rename;
mod search;
mod session;
mod text_files;
mod watching;

pub use attachments::{Attached, LinkSuggestion, cover_reference, sanitize_file_name};
pub use bin::BinItem;
pub use error::{Result, SessionError};
pub use events::{IndexReport, RenameOutcome, SessionEvent};
pub use external::{ExternalFile, file_url, opens_from_notes};
pub use global_view::{
    CardKind, EdgeKind, GvCard, GvChildren, GvEdge, GvLevel, IndexFrom, MAX_NEIGHBOURS,
    MAX_VISIBLE, Relation, SUMMARY_TITLES,
};
pub use liber_index::{
    FacetCount, FacetPage, Facets, SearchHit, SearchPage, SearchQuery, SnippetPart,
};
pub use quick_notes::{AutoName, MAX_QUICK_NAME, device_name, quick_note_stem};
pub use session::{VaultSession, index_db_path};
pub use text_files::{TEXT_MAX_BYTES, is_text_content, is_text_path};
