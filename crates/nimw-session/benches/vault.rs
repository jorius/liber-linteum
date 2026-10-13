//! NFR-03 benchmarks on a generated 10,000-note vault (spec §7.3).
//! Run: `cargo bench -p nimw-session`. Targets: first index < 30 s,
//! single-file re-index < 100 ms. Results go in the M1a hand-off.

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use nimw_session::{SessionEvent, VaultSession};
use nimw_testkit::{VaultShape, generate_vault};
use nimw_vault::{VaultPath, WatchEvent};
use std::time::Duration;

fn quiet(_: SessionEvent) {}

fn benches(c: &mut Criterion) {
    let vault = tempfile::tempdir().unwrap();
    let notes = generate_vault(vault.path(), VaultShape::TEN_K, 42);
    let mut group = c.benchmark_group("10k-notes");
    group
        .sample_size(10)
        .measurement_time(Duration::from_secs(60));

    group.bench_function("first full index", |b| {
        b.iter_batched(
            || tempfile::tempdir().unwrap(),
            |cache| VaultSession::open(vault.path(), cache.path(), quiet).unwrap(),
            BatchSize::PerIteration,
        )
    });

    let cache = tempfile::tempdir().unwrap();
    VaultSession::open(vault.path(), cache.path(), quiet).unwrap();
    group.bench_function("reopen, nothing changed", |b| {
        b.iter(|| VaultSession::open(vault.path(), cache.path(), quiet).unwrap())
    });

    let (session, _) = VaultSession::open(vault.path(), cache.path(), quiet).unwrap();
    let note = VaultPath::new(&notes[5]).unwrap();
    let mut n = 0u64;
    group.bench_function("re-index one modified file", |b| {
        b.iter(|| {
            n += 1;
            std::fs::write(
                vault.path().join(note.as_str()),
                format!("# Note 5 v{n}\n\n[[hub]] [[Note 6]]\n"),
            )
            .unwrap();
            session
                .apply(vec![WatchEvent::Changed(note.clone())])
                .unwrap();
        })
    });

    let hub = VaultPath::new("hub.md").unwrap();
    let renamed = VaultPath::new("hub renamed.md").unwrap();
    let mut flip = false;
    group.bench_function("rename page with 100 backlinks", |b| {
        b.iter(|| {
            let (from, to) = if flip {
                (&renamed, &hub)
            } else {
                (&hub, &renamed)
            };
            flip = !flip;
            let out = session.rename(from, to, true).unwrap();
            assert_eq!(out.updated_files.len(), 100);
        })
    });
    group.finish();
}

criterion_group!(m1a, benches);
criterion_main!(m1a);
