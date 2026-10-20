#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| liber_crypto::fuzzing::fuzz_names(data));
