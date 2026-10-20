use std::io::{Cursor, Read, Seek, SeekFrom, Write};

use nimw_crypto::{Secret, StreamReader, StreamWriter};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn prop_round_trip_and_ranges(
        size in 0usize..300_000,
        seed: u64,
        start_frac in 0.0f64..1.1,
        want in 0usize..140_000,
    ) {
        let mut s = seed;
        let pt: Vec<u8> = (0..size)
            .map(|_| {
                s = s.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
                (s >> 56) as u8
            })
            .collect();
        let key = Secret::random();
        let mut w = StreamWriter::new(Vec::new(), &key, 7).unwrap();
        w.write_all(&pt).unwrap();
        let ct = w.finish().unwrap();

        let mut r = StreamReader::open(Cursor::new(ct), |e| (e == 7).then_some(&key)).unwrap();
        prop_assert_eq!(r.len(), size as u64);
        let mut all = Vec::new();
        r.read_to_end(&mut all).unwrap();
        prop_assert_eq!(&all, &pt);

        // A range read, possibly starting past the end.
        let start = (size as f64 * start_frac) as u64;
        prop_assert_eq!(r.seek(SeekFrom::Start(start)).unwrap(), start);
        let mut got = Vec::new();
        r.by_ref().take(want as u64).read_to_end(&mut got).unwrap();
        let from = (start as usize).min(size);
        let to = from.saturating_add(want).min(size);
        prop_assert_eq!(&got[..], &pt[from..to]);
    }
}
