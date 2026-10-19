//! One open vault: indexing, watching and file operations, composed from
//! `nimw-vault` (filesystem), `nimw-markdown` (parsing) and `nimw-index` (cache).

mod attachments;
mod editing;
mod error;
mod events;
mod rename;
mod session;
mod watching;

pub use attachments::{Attached, LinkSuggestion, cover_reference, sanitize_file_name};
pub use error::{Result, SessionError};
pub use events::{IndexReport, RenameOutcome, SessionEvent};
pub use session::{VaultSession, index_db_path};
