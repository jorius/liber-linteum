//! STREAM file contents (spec §4.2): chunked AES-256-GCM in age's STREAM construction.

use std::io::{self, Read, Seek, SeekFrom, Write};

use aes_gcm::aead::{AeadInOut, KeyInit, Nonce};
use aes_gcm::{Aes256Gcm, Tag};
use zeroize::Zeroizing;

use crate::error::{CryptoError, Result};
use crate::keys::{Secret, hkdf_sha256, random_bytes};

pub const HEADER_LEN: usize = 48;
pub const CHUNK_LEN: usize = 65_536;
pub const TAG_LEN: usize = 16;

const MAGIC: &[u8; 5] = b"NIMWE";
const VERSION: u8 = 1;
const SUITE_AES_256_GCM: u8 = 1;
const LOG2_CHUNK: u8 = 16;
/// One chunk on disk: ciphertext plus tag.
const SEG: u64 = (CHUNK_LEN + TAG_LEN) as u64;

struct Header {
    bytes: [u8; HEADER_LEN],
    salt: [u8; 32],
    epoch: u32,
}

fn parse_header(head: &[u8]) -> Result<Header> {
    let bytes: [u8; HEADER_LEN] = head
        .get(..HEADER_LEN)
        .ok_or(CryptoError::Truncated)?
        .try_into()
        .expect("sliced to HEADER_LEN");
    if bytes[..5] != *MAGIC {
        return Err(CryptoError::BadFormat("not an encrypted vault file"));
    }
    if bytes[5] != VERSION {
        return Err(CryptoError::UnsupportedVersion(bytes[5].into()));
    }
    if bytes[6] != SUITE_AES_256_GCM {
        return Err(CryptoError::BadFormat("unknown cipher suite"));
    }
    if bytes[7] != LOG2_CHUNK {
        return Err(CryptoError::BadFormat("chunk size"));
    }
    if bytes[44..] != [0; 4] {
        return Err(CryptoError::BadFormat("reserved header bytes"));
    }
    Ok(Header {
        salt: bytes[8..40].try_into().expect("32 bytes"),
        epoch: u32::from_be_bytes(bytes[40..44].try_into().expect("4 bytes")),
        bytes,
    })
}

/// K_f = HKDF-SHA-256(K_content, salt = file salt, info = `nimw/v1/file`); the key stays on the heap.
fn file_cipher(content: &Secret<32>, salt: &[u8; 32]) -> Aes256Gcm {
    let kf = hkdf_sha256(content.expose(), salt, b"nimw/v1/file");
    Aes256Gcm::new_from_slice(kf.expose()).expect("32-byte key")
}

/// 11-byte big-endian chunk counter, then the last-chunk flag.
fn nonce(i: u64, last: bool) -> Nonce<Aes256Gcm> {
    let mut n = [0u8; 12];
    n[3..11].copy_from_slice(&i.to_be_bytes());
    n[11] = last as u8;
    n.into()
}

/// Decrypts chunk `i` in place (`buf` = ciphertext ‖ tag) and drops the tag. GCM checks the tag
/// before touching the buffer, so a failed attempt leaves it intact for a retry.
fn open_chunk(
    cipher: &Aes256Gcm,
    aad: &[u8],
    i: u64,
    last: bool,
    buf: &mut Zeroizing<Vec<u8>>,
) -> Result<()> {
    let body = buf
        .len()
        .checked_sub(TAG_LEN)
        .ok_or(CryptoError::Truncated)?;
    let (ct, tag) = buf.split_at_mut(body);
    let tag = Tag::try_from(&*tag).expect("TAG_LEN bytes");
    cipher
        .decrypt_inout_detached(&nonce(i, last), aad, ct.into(), &tag)
        .map_err(|_| CryptoError::Authentication)?;
    buf.truncate(body);
    Ok(())
}

fn to_io(e: CryptoError) -> io::Error {
    match e {
        CryptoError::Io(e) => e,
        e => io::Error::new(io::ErrorKind::InvalidData, e),
    }
}

/// Append-only encrypting writer. Never seeks; each chunk is encrypted exactly once.
/// Dropping it without `finish` leaves a truncated file, by design.
pub struct StreamWriter<W: Write> {
    inner: W,
    cipher: Aes256Gcm,
    header: [u8; HEADER_LEN],
    buf: Zeroizing<Vec<u8>>,
    next: u64,
    /// Set once a write to `inner` fails: its chunk is already encrypted, and retrying could
    /// re-encrypt under the same nonce.
    failed: bool,
}

impl<W: Write> StreamWriter<W> {
    /// Writes the header immediately, with a fresh random file salt.
    pub fn new(inner: W, content: &Secret<32>, epoch: u32) -> io::Result<Self> {
        Self::with_salt(inner, content, epoch, random_bytes())
    }

    /// A fixed salt, for test vectors only: reusing a salt with the same key reuses nonces.
    pub(crate) fn with_salt(
        mut inner: W,
        content: &Secret<32>,
        epoch: u32,
        salt: [u8; 32],
    ) -> io::Result<Self> {
        let mut header = [0u8; HEADER_LEN];
        header[..5].copy_from_slice(MAGIC);
        header[5] = VERSION;
        header[6] = SUITE_AES_256_GCM;
        header[7] = LOG2_CHUNK;
        header[8..40].copy_from_slice(&salt);
        header[40..44].copy_from_slice(&epoch.to_be_bytes());
        inner.write_all(&header)?;
        Ok(Self {
            inner,
            cipher: file_cipher(content, &salt),
            header,
            buf: Zeroizing::new(Vec::with_capacity(CHUNK_LEN)),
            next: 0,
            failed: false,
        })
    }

    fn emit(&mut self, last: bool) -> io::Result<()> {
        if self.failed {
            return Err(io::Error::other("stream writer failed earlier"));
        }
        self.failed = true;
        let tag = self
            .cipher
            .encrypt_inout_detached(
                &nonce(self.next, last),
                &self.header,
                self.buf.as_mut_slice().into(),
            )
            .map_err(|_| io::Error::other("chunk too large"))?;
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| io::Error::other("chunk counter overflow"))?;
        self.inner.write_all(&self.buf)?;
        self.inner.write_all(&tag)?;
        self.buf.clear();
        self.failed = false;
        Ok(())
    }

    /// Writes the last chunk (possibly empty, possibly full) and returns the inner writer.
    pub fn finish(mut self) -> io::Result<W> {
        self.emit(true)?;
        self.inner.flush()?;
        Ok(self.inner)
    }
}

impl<W: Write> Write for StreamWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.is_empty() {
            return Ok(0);
        }
        // A full chunk goes out only once a further byte proves it isn't the last.
        if self.buf.len() == CHUNK_LEN {
            self.emit(false)?;
        }
        let n = data.len().min(CHUNK_LEN - self.buf.len());
        self.buf.extend_from_slice(&data[..n]);
        Ok(n)
    }

    /// Flushes the inner writer only: a partial chunk can't be written before `finish`.
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Seekable decrypting reader over the plaintext. Read errors carry a `CryptoError` inside the
/// `io::Error`; `CryptoError::from` unwraps it again.
pub struct StreamReader<R: Read + Seek> {
    inner: R,
    cipher: Aes256Gcm,
    header: [u8; HEADER_LEN],
    epoch: u32,
    len: u64,
    chunks: u64,
    pos: u64,
    /// The decrypted chunk `cached` (if any).
    buf: Zeroizing<Vec<u8>>,
    cached: Option<u64>,
}

impl<R: Read + Seek> StreamReader<R> {
    /// Parses the header and authenticates the last chunk, so `len()` is trustworthy.
    pub fn open<'k>(
        mut inner: R,
        key_for_epoch: impl Fn(u32) -> Option<&'k Secret<32>>,
    ) -> Result<Self> {
        let total = inner.seek(SeekFrom::End(0))?;
        inner.seek(SeekFrom::Start(0))?;
        let mut head = [0u8; HEADER_LEN];
        read_full(&mut inner, &mut head)?;
        let h = parse_header(&head)?;
        let key = key_for_epoch(h.epoch).ok_or(CryptoError::Authentication)?;
        let body = total
            .checked_sub(HEADER_LEN as u64)
            .ok_or(CryptoError::Truncated)?;
        let (full, rem) = (body / SEG, body % SEG);
        // The last chunk is either full (rem == 0) or carries 0..CHUNK_LEN bytes plus a tag;
        // only an empty file has an empty last chunk.
        let (chunks, len) = match rem {
            0 if full > 0 => (full, full * CHUNK_LEN as u64),
            r if r == TAG_LEN as u64 && full == 0 => (1, 0),
            r if r > TAG_LEN as u64 => (full + 1, full * CHUNK_LEN as u64 + (r - TAG_LEN as u64)),
            _ => return Err(CryptoError::Truncated),
        };
        let mut r = Self {
            inner,
            cipher: file_cipher(key, &h.salt),
            header: h.bytes,
            epoch: h.epoch,
            len,
            chunks,
            pos: 0,
            buf: Zeroizing::new(Vec::with_capacity(SEG as usize)),
            cached: None,
        };
        r.load(chunks - 1)?;
        Ok(r)
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    fn load(&mut self, i: u64) -> Result<()> {
        if self.cached == Some(i) {
            return Ok(());
        }
        self.cached = None;
        let last = i + 1 == self.chunks;
        let start = i * SEG;
        let seg_len = if last {
            self.len - i * CHUNK_LEN as u64 + TAG_LEN as u64
        } else {
            SEG
        };
        self.inner
            .seek(SeekFrom::Start(HEADER_LEN as u64 + start))?;
        self.buf.resize(seg_len as usize, 0);
        read_full(&mut self.inner, &mut self.buf)?;
        if let Err(e) = open_chunk(&self.cipher, &self.header, i, last, &mut self.buf) {
            // A valid non-last chunk at the end means the file was cut at a chunk boundary.
            if last && open_chunk(&self.cipher, &self.header, i, false, &mut self.buf).is_ok() {
                self.buf.clear();
                return Err(CryptoError::Truncated);
            }
            return Err(e);
        }
        self.cached = Some(i);
        Ok(())
    }
}

/// `read_exact`, but a short input is `Truncated`.
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> Result<()> {
    r.read_exact(buf).map_err(|e| match e.kind() {
        io::ErrorKind::UnexpectedEof => CryptoError::Truncated,
        _ => CryptoError::Io(e),
    })
}

impl<R: Read + Seek> Read for StreamReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len || out.is_empty() {
            return Ok(0);
        }
        let i = self.pos / CHUNK_LEN as u64;
        let off = (self.pos % CHUNK_LEN as u64) as usize;
        self.load(i).map_err(to_io)?;
        let n = out.len().min(self.buf.len() - off);
        out[..n].copy_from_slice(&self.buf[off..off + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl<R: Read + Seek> Seek for StreamReader<R> {
    /// Seeking past the end is allowed and reads 0 bytes; before 0 or past u64 is an error.
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let pos = match to {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek out of range"))?;
        self.pos = pos;
        Ok(pos)
    }
}

/// The key epoch of an encrypted file, from its first 48 bytes.
pub fn header_epoch(head: &[u8]) -> Result<u32> {
    Ok(parse_header(head)?.epoch)
}

/// What `salvage` recovered from a possibly cut-off stream.
pub struct Salvaged {
    pub plaintext: Zeroizing<Vec<u8>>,
    /// True only if a valid last-flagged chunk ended the stream.
    pub complete: bool,
}

/// Decrypts consecutive chunks until one fails or the input ends (spec §4.2, recordings).
pub fn salvage<'k, R: Read>(
    mut inner: R,
    key_for_epoch: impl Fn(u32) -> Option<&'k Secret<32>>,
) -> Result<Salvaged> {
    let mut head = [0u8; HEADER_LEN];
    read_full(&mut inner, &mut head)?;
    let h = parse_header(&head)?;
    let key = key_for_epoch(h.epoch).ok_or(CryptoError::Authentication)?;
    let cipher = file_cipher(key, &h.salt);
    let mut out = Salvaged {
        plaintext: Zeroizing::new(Vec::new()),
        complete: false,
    };
    let mut buf = Zeroizing::new(vec![0u8; SEG as usize]);
    for i in 0u64.. {
        buf.resize(SEG as usize, 0);
        let n = read_up_to(&mut inner, &mut buf)?;
        if n == 0 {
            break;
        }
        buf.truncate(n);
        if open_chunk(&cipher, &h.bytes, i, false, &mut buf).is_ok() {
            append(&mut out.plaintext, &buf);
            continue;
        }
        if open_chunk(&cipher, &h.bytes, i, true, &mut buf).is_ok() {
            append(&mut out.plaintext, &buf);
            // Complete only if nothing follows the last chunk.
            out.complete = read_up_to(&mut inner, &mut [0u8; 1])? == 0;
        }
        break;
    }
    Ok(out)
}

/// Reads until `buf` is full or the input ends; returns the bytes read.
fn read_up_to(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

/// Appends without letting `Vec` reallocate: a reallocation would free plaintext unzeroized.
fn append(out: &mut Zeroizing<Vec<u8>>, data: &[u8]) {
    if out.capacity() - out.len() < data.len() {
        let mut bigger = Zeroizing::new(Vec::with_capacity((out.len() + data.len()) * 2));
        bigger.extend_from_slice(out);
        *out = bigger; // the old buffer is zeroized as it drops
    }
    out.extend_from_slice(data);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEG: usize = CHUNK_LEN + TAG_LEN;

    fn plaintext(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 31 + i / 251) as u8).collect()
    }

    fn encrypt(key: &Secret<32>, epoch: u32, pt: &[u8]) -> Vec<u8> {
        let mut w = StreamWriter::new(Vec::new(), key, epoch).unwrap();
        w.write_all(pt).unwrap();
        w.finish().unwrap()
    }

    fn open(key: &Secret<32>, epoch: u32, ct: &[u8]) -> Result<StreamReader<io::Cursor<Vec<u8>>>> {
        StreamReader::open(io::Cursor::new(ct.to_vec()), move |e| {
            (e == epoch).then_some(key)
        })
    }

    /// Opens and reads everything, mapping a read error back to its `CryptoError`.
    fn decrypt(key: &Secret<32>, epoch: u32, ct: &[u8]) -> Result<Vec<u8>> {
        let mut r = open(key, epoch, ct)?;
        let mut out = Vec::new();
        r.read_to_end(&mut out)?;
        Ok(out)
    }

    #[test]
    fn round_trip_sizes() {
        let key = Secret::random();
        for n in [0, 1, 65_535, 65_536, 65_537, 131_072, 200_000] {
            let pt = plaintext(n);
            let ct = encrypt(&key, 3, &pt);
            let r = open(&key, 3, &ct).unwrap();
            assert_eq!(r.len(), n as u64, "len for {n}");
            assert_eq!(r.epoch(), 3);
            assert_eq!(header_epoch(&ct).unwrap(), 3);
            assert_eq!(decrypt(&key, 3, &ct).unwrap(), pt, "size {n}");
        }
    }

    #[test]
    fn empty_is_one_empty_last_chunk() {
        let ct = encrypt(&Secret::random(), 0, &[]);
        assert_eq!(ct.len(), HEADER_LEN + TAG_LEN);
    }

    #[test]
    fn exact_chunk_multiples() {
        let key = Secret::random();
        for n in [1usize, 2] {
            let pt = plaintext(n * CHUNK_LEN);
            let ct = encrypt(&key, 1, &pt);
            assert_eq!(
                ct.len(),
                HEADER_LEN + n * SEG,
                "no extra empty chunk for {n} chunks"
            );
            assert_eq!(open(&key, 1, &ct).unwrap().len(), (n * CHUNK_LEN) as u64);
            assert_eq!(decrypt(&key, 1, &ct).unwrap(), pt);
        }
    }

    #[test]
    fn seek_and_read_matches_slice() {
        let key = Secret::random();
        let pt = plaintext(200_000);
        let ct = encrypt(&key, 1, &pt);
        let mut r = open(&key, 1, &ct).unwrap();
        let len = r.len();

        // Across the chunk 0 / chunk 1 boundary.
        assert_eq!(r.seek(SeekFrom::Start(65_535)).unwrap(), 65_535);
        let mut three = [0u8; 3];
        r.read_exact(&mut three).unwrap();
        assert_eq!(three, pt[65_535..65_538]);

        // At the end: reads nothing.
        assert_eq!(r.seek(SeekFrom::Start(len)).unwrap(), len);
        let mut rest = Vec::new();
        assert_eq!(r.read_to_end(&mut rest).unwrap(), 0);

        // Backwards after reading the end.
        r.seek(SeekFrom::Start(len - 10)).unwrap();
        r.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, pt[pt.len() - 10..]);
        assert_eq!(r.seek(SeekFrom::Current(-70_000)).unwrap(), len - 70_000);
        let mut buf = vec![0u8; 5_000];
        r.read_exact(&mut buf).unwrap();
        assert_eq!(buf, pt[(len - 70_000) as usize..(len - 65_000) as usize]);
        assert_eq!(r.seek(SeekFrom::End(-1)).unwrap(), len - 1);
        let mut one = Vec::new();
        r.read_to_end(&mut one).unwrap();
        assert_eq!(one, [pt[pt.len() - 1]]);

        // Past the end: allowed, reads 0 bytes.
        assert_eq!(r.seek(SeekFrom::Start(len + 1_000)).unwrap(), len + 1_000);
        let mut none = [0u8; 8];
        assert_eq!(r.read(&mut none).unwrap(), 0);
        assert_eq!(r.seek(SeekFrom::End(5)).unwrap(), len + 5);
        assert_eq!(r.read(&mut none).unwrap(), 0);

        // Before the start, or overflowing u64: an error, never a panic.
        assert!(r.seek(SeekFrom::Current(-(len as i64) - 6)).is_err());
        r.seek(SeekFrom::Start(u64::MAX)).unwrap();
        assert!(r.seek(SeekFrom::Current(1)).is_err());
        assert_eq!(r.read(&mut none).unwrap(), 0);

        // Whole read from the start still matches after all that seeking.
        r.seek(SeekFrom::Start(0)).unwrap();
        let mut all = Vec::new();
        r.read_to_end(&mut all).unwrap();
        assert_eq!(all, pt);
    }

    #[test]
    fn tamper_truncate_reorder_fail() {
        let key = Secret::random();
        let pt = plaintext(200_000);
        let ct = encrypt(&key, 1, &pt);
        assert_eq!(decrypt(&key, 1, &ct).unwrap(), pt);

        for pos in [0, 7, 47, 48, 100, 65_600, ct.len() - 1] {
            let mut bad = ct.clone();
            bad[pos] ^= 0x01;
            match decrypt(&key, 1, &bad) {
                Err(CryptoError::BadFormat(_) | CryptoError::Authentication) => {}
                other => panic!("flip at {pos}: {:?}", other.map(|v| v.len())),
            }
        }

        let cut = &ct[..HEADER_LEN + SEG];
        assert!(matches!(decrypt(&key, 1, cut), Err(CryptoError::Truncated)));
        for n in [
            0,
            10,
            HEADER_LEN,
            HEADER_LEN + 1,
            HEADER_LEN + SEG + TAG_LEN,
        ] {
            assert!(
                matches!(decrypt(&key, 1, &ct[..n]), Err(CryptoError::Truncated)),
                "cut at {n}"
            );
        }

        let mut swapped = ct[..HEADER_LEN].to_vec();
        swapped.extend_from_slice(&ct[HEADER_LEN + SEG..HEADER_LEN + 2 * SEG]);
        swapped.extend_from_slice(&ct[HEADER_LEN..HEADER_LEN + SEG]);
        swapped.extend_from_slice(&ct[HEADER_LEN + 2 * SEG..]);
        assert!(matches!(
            decrypt(&key, 1, &swapped),
            Err(CryptoError::Authentication)
        ));

        // The key for another epoch, or no key for this epoch.
        let other = Secret::random();
        let r = StreamReader::open(io::Cursor::new(ct.clone()), |_| Some(&other));
        assert!(matches!(r.map(|_| ()), Err(CryptoError::Authentication)));
        assert!(matches!(
            decrypt(&key, 2, &ct),
            Err(CryptoError::Authentication)
        ));
    }

    #[test]
    fn header_fields_are_checked() {
        let key = Secret::random();
        let ct = encrypt(&key, 9, b"hello");
        let with = |i: usize, v: u8| {
            let mut b = ct.clone();
            b[i] = v;
            b
        };
        assert!(matches!(
            header_epoch(&with(0, b'X')),
            Err(CryptoError::BadFormat(_))
        ));
        assert!(matches!(
            header_epoch(&with(5, 2)),
            Err(CryptoError::UnsupportedVersion(2))
        ));
        assert!(matches!(
            header_epoch(&with(6, 2)),
            Err(CryptoError::BadFormat(_))
        ));
        assert!(matches!(
            header_epoch(&with(7, 17)),
            Err(CryptoError::BadFormat(_))
        ));
        assert!(matches!(
            header_epoch(&with(44, 1)),
            Err(CryptoError::BadFormat(_))
        ));
        assert!(matches!(
            header_epoch(&ct[..47]),
            Err(CryptoError::Truncated)
        ));
        assert_eq!(&ct[..8], b"NIMWE\x01\x01\x10");
        assert_eq!(&ct[40..48], &[0, 0, 0, 9, 0, 0, 0, 0]);
    }

    #[test]
    fn fresh_salt_per_write() {
        let key = Secret::random();
        let pt = plaintext(1_000);
        let a = encrypt(&key, 1, &pt);
        let b = encrypt(&key, 1, &pt);
        assert_ne!(a[8..40], b[8..40]);
        assert_ne!(a[HEADER_LEN..], b[HEADER_LEN..]);
    }

    #[test]
    fn with_salt_is_deterministic() {
        let key = Secret::from_bytes([4; 32]);
        let run = || {
            let mut w = StreamWriter::with_salt(Vec::new(), &key, 2, [5; 32]).unwrap();
            w.write_all(b"vector").unwrap();
            w.finish().unwrap()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn salvage_recovers_complete_chunks() {
        let key = Secret::random();
        let pt = plaintext(3 * CHUNK_LEN + CHUNK_LEN / 2);
        let mut out = Vec::new();
        {
            let mut w = StreamWriter::new(&mut out, &key, 4).unwrap();
            w.write_all(&pt).unwrap();
        } // dropped without finish: a crash mid-recording
        assert_eq!(out.len(), HEADER_LEN + 3 * SEG);
        let s = salvage(&out[..], |e| (e == 4).then_some(&key)).unwrap();
        assert_eq!(*s.plaintext, pt[..3 * CHUNK_LEN]);
        assert!(!s.complete);

        // A chunk torn mid-write is dropped too.
        let s = salvage(&out[..out.len() - 100], |e| (e == 4).then_some(&key)).unwrap();
        assert_eq!(*s.plaintext, pt[..2 * CHUNK_LEN]);
        assert!(!s.complete);

        for n in [0, 5, CHUNK_LEN, 3 * CHUNK_LEN + 7] {
            let pt = plaintext(n);
            let ct = encrypt(&key, 4, &pt);
            let s = salvage(&ct[..], |e| (e == 4).then_some(&key)).unwrap();
            assert_eq!(*s.plaintext, pt, "size {n}");
            assert!(s.complete, "size {n}");
        }

        let s = salvage(&out[..HEADER_LEN], |e| (e == 4).then_some(&key)).unwrap();
        assert!(s.plaintext.is_empty() && !s.complete);
        assert!(matches!(
            salvage(&out[..], |_| None).map(|_| ()),
            Err(CryptoError::Authentication)
        ));
    }

    #[test]
    fn writer_never_seeks_and_emits_whole_chunks() {
        // Byte-at-a-time writes give the same chunk layout as one big write.
        let key = Secret::random();
        let pt = plaintext(CHUNK_LEN + 3);
        let mut w = StreamWriter::with_salt(Vec::new(), &key, 1, [1; 32]).unwrap();
        for b in &pt {
            w.write_all(std::slice::from_ref(b)).unwrap();
        }
        let a = w.finish().unwrap();
        let mut w = StreamWriter::with_salt(Vec::new(), &key, 1, [1; 32]).unwrap();
        w.write_all(&pt).unwrap();
        assert_eq!(a, w.finish().unwrap());
    }
}
