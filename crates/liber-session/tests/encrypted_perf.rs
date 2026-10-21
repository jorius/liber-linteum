//! E3 (spec §10): unlock to searchable on the 10,000-note reference vault,
//! sealed, in at most 3 s, excluding the deliberate Argon2id time. The vault
//! uses the test switch's tiny Argon2 parameters, so the measured unlock is
//! almost all header and key work; it is counted too, which is stricter.
//! Opt-in, release only:
//! `LIBER_PERF=1 cargo test --release -p liber-session --test encrypted_perf -- --nocapture`.

use liber_session::{SearchQuery, SessionEvent, VaultSession};
use liber_testkit::{VaultShape, generate_vault};
use liber_vault::seal_in_place;
use std::time::{Duration, Instant};

#[test]
fn unlock_to_searchable_10k() {
    if std::env::var("LIBER_PERF").as_deref() != Ok("1") || cfg!(debug_assertions) {
        eprintln!("skipped: a timing probe; run it in release with LIBER_PERF=1");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    generate_vault(dir.path(), VaultShape::TEN_K, 42);
    drop(seal_in_place(dir.path()).unwrap());

    let started = Instant::now();
    let storage = seal_in_place(dir.path()).unwrap();
    let unlocked = started.elapsed();
    let (session, report) = VaultSession::open_encrypted(storage, |_: SessionEvent| {}).unwrap();
    let opened = started.elapsed();
    let query = SearchQuery {
        text: "note".into(),
        ..SearchQuery::default()
    };
    let found = session.search(&query).unwrap();
    let searchable = started.elapsed();
    eprintln!(
        "unlock {unlocked:?} (tiny Argon2), open_encrypted + index {:?}, first search {:?}; \
         total {searchable:?}; {} hits, index report {report:?}",
        opened - unlocked,
        searchable - opened,
        found.total,
    );
    assert!(found.total > 0, "the first search finds the notes");
    assert!(searchable <= Duration::from_secs(3), "{searchable:?}");
}
