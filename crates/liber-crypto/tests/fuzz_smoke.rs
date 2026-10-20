//! Stable stand-in for the cargo-fuzz targets: the same entry points, fed by proptest.
//! A panic is the only failure; every `Result` is ignored.

use liber_crypto::fuzzing::{fuzz_header, fuzz_keyring, fuzz_names, fuzz_stream};
use proptest::prelude::*;

const V: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/v1/");

fn vector(name: &str) -> Vec<u8> {
    std::fs::read(format!("{V}{name}")).unwrap()
}

/// Random bytes, or a valid vector with a few bytes overwritten and an optional cut.
fn input(valid: Vec<Vec<u8>>) -> impl Strategy<Value = Vec<u8>> {
    let mutated = (
        proptest::sample::select(valid),
        proptest::collection::vec((any::<usize>(), any::<u8>()), 0..4),
        any::<proptest::sample::Index>(),
        any::<bool>(),
    )
        .prop_map(|(mut v, edits, cut, do_cut)| {
            for (i, b) in edits {
                if !v.is_empty() {
                    let n = v.len();
                    v[i % n] = b;
                }
            }
            if do_cut {
                v.truncate(cut.index(v.len() + 1));
            }
            v
        });
    prop_oneof![proptest::collection::vec(any::<u8>(), 0..4096), mutated]
}

fn name_vectors() -> Vec<Vec<u8>> {
    let j: serde_json::Value = serde_json::from_slice(&vector("vectors.json")).unwrap();
    j["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["on_disk"].as_str().unwrap().as_bytes().to_vec())
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn header(d in input(vec![vector("header.json"), vector("header-rotated.json")])) {
        fuzz_header(&d);
    }

    #[test]
    fn keyring(d in input(vec![vector("keyring.liberk")])) {
        fuzz_keyring(&d);
    }

    #[test]
    fn stream(d in input(["file-0", "file-1", "file-65535", "file-65536"]
        .iter().map(|n| vector(&format!("{n}.libere"))).collect())) {
        fuzz_stream(&d);
    }

    #[test]
    fn names(d in input(name_vectors())) {
        fuzz_names(&d);
    }
}
