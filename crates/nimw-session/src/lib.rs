//! One open vault: indexing, watching and file operations, composed from
//! `nimw-vault` (filesystem), `nimw-markdown` (parsing) and `nimw-index` (cache).

mod error;
mod events;
mod rename;
mod session;
mod watching;

pub use error::{Result, SessionError};
pub use events::{IndexReport, RenameOutcome, SessionEvent};
pub use session::{VaultSession, index_db_path};
