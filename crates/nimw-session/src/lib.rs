//! One open vault: indexing, watching and file operations, composed from
//! `nimw-vault` (filesystem), `nimw-markdown` (parsing) and `nimw-index` (cache).

mod attachments;
mod editing;
mod error;
mod events;
mod global_view;
mod rename;
mod session;
mod text_files;
mod watching;

pub use attachments::{Attached, LinkSuggestion, cover_reference, sanitize_file_name};
pub use error::{Result, SessionError};
pub use events::{IndexReport, RenameOutcome, SessionEvent};
pub use global_view::{
    CardKind, EdgeKind, GvCard, GvChildren, GvEdge, GvLevel, IndexFrom, MAX_NEIGHBOURS,
    MAX_VISIBLE, Relation, SUMMARY_TITLES,
};
pub use session::{VaultSession, index_db_path};
pub use text_files::{TEXT_MAX_BYTES, is_text_content, is_text_path};
