"""Independent reader for the Liber Linteum v1 test vectors (spec §4.4), and for a vault E3 wrote.

It follows docs/security/vault-format-v1.md; "§n" in the comments below is a section of that doc.
Re-derives every value it checks with the standard library and the `cryptography` package,
never with the Rust code. X-Wing is not covered (`cryptography` has none): the vault header's
keyring slot and the keyring's public key are checked only by the Rust test.

Usage: python3 -I xcheck.py <vectors dir>
       python3 -I xcheck.py vault <vault dir> <passphrase> <expected.json>
The vault mode unlocks the vault with the passphrase (Argon2id: needs cryptography >= 44),
checks the header MAC, decrypts every name and file under d/ and compares the tree with
expected.json: {logical path: plaintext hex for a file, "dir" for a folder}.
Exit 0: all checks pass. Exit 77: `cryptography` (with AES-SIV, and Argon2id for a vault)
is not installed.
"""

import base64
import hashlib
import hmac
import json
import sys
import unicodedata
from pathlib import Path

try:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM, AESSIV
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
except ImportError as e:
    print(f"xcheck: cryptography unavailable: {e}", file=sys.stderr)
    sys.exit(77)
try:
    from cryptography.hazmat.primitives.kdf.argon2 import Argon2id  # cryptography >= 44
except ImportError:
    Argon2id = None

SHA256, SHA512 = hashes.SHA256(), hashes.SHA512()
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # §9
CHUNK = 65536  # §13.3
SEG = CHUNK + 16  # one chunk on disk: ciphertext plus GCM tag


def ok(cond, what):
    if not cond:
        raise SystemExit("xcheck: FAIL " + what)


def hkdf(alg, length, ikm, salt, info):
    return HKDF(algorithm=alg, length=length, salt=salt, info=info).derive(ikm)


def b64d(s):  # §1
    return base64.b64decode(s + "=" * (-len(s) % 4), altchars="-_", validate=True)


def b64e(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def canonical(v):  # §5
    # serde_json writes raw UTF-8: ensure_ascii=True would escape "é" and break the MAC.
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def crockford(b):
    bits = len(b) * 8
    n = -(-bits // 5)
    x = int.from_bytes(b, "big") << (n * 5 - bits)
    return "".join(CROCKFORD[(x >> (5 * i)) & 31] for i in reversed(range(n)))


def recovery_secret(code):
    """§9: `LIBER-` + 13 groups of Crockford base32 (256 bits) + a checksum group."""
    body = code.replace("-", "")[5:]
    ok(code == "LIBER-" + "-".join(body[i:i + 4] for i in range(0, 56, 4)), "recovery shape")
    x = 0
    for c in body[:52]:
        x = x << 5 | CROCKFORD.index(c)
    ok(x & 0xF == 0, "recovery trailing bits")
    secret = (x >> 4).to_bytes(32, "big")
    check = crockford(hashlib.sha256(b"liber/v1/recovery-check" + secret).digest()[:3])[:4]
    ok(body[52:] == check, "recovery checksum")
    return secret


def unwrap(kek, slot, aad):  # §7.1
    return AESGCM(kek).decrypt(b64d(slot["nonce"]), b64d(slot["wrapped"]), aad)


def passphrase_kek(pw, kdf):  # §7.2, §8
    ok(kdf["alg"] == "argon2id", "kdf alg")
    k = Argon2id(salt=b64d(kdf["salt"]), length=32, iterations=kdf["t"], lanes=kdf["p"],
                 memory_cost=kdf["m_kib"])
    return k.derive(unicodedata.normalize("NFC", pw).encode())


def be32(n):
    return n.to_bytes(4, "big")


def load(path, fmt):  # §5, §6, §12.1
    raw = path.read_bytes()
    v = json.loads(raw)
    ok(canonical(v) == raw, path.name + " is canonical JSON")
    ok(v["format"] == fmt and v["version"] == 1, path.name + " format")
    return v, {s["type"]: s for s in v["slots"]}


def check_mac(v, key, what):  # §5
    v = dict(v)
    mac = b64d(v.pop("mac"))
    ok(hmac.compare_digest(mac, hmac.new(key, canonical(v), hashlib.sha256).digest()), what)


def open_header(path, code, pw):
    """§7.7: unwraps the VK from the recovery (and passphrase) slot, then checks the header MAC."""
    h, slots = load(path, "liber-vault")
    vid, epoch = b64d(h["vault_id"]), h["epoch"]

    def aad(s):  # §7.1
        return b"liber/v1/slot" + vid + be32(epoch) + b64d(s["id"]) + s["type"].encode()

    rec = slots["recovery"]  # §7.3
    vk = unwrap(hkdf(SHA256, 32, recovery_secret(code), vid, b"liber/v1/slot/recovery"),
                rec, aad(rec))
    check_mac(h, hkdf(SHA512, 32, vk, vid, b"liber/v1/header"), path.name + " mac")  # §4.1
    if Argon2id:
        p = slots["passphrase"]
        ok(unwrap(passphrase_kek(pw, p["kdf"]), p, aad(p)) == vk, path.name + " passphrase")
    return h, slots, vid, epoch, vk, aad


def stream_plain(raw, content_key, epoch, what):
    """§13: the plaintext of a STREAM file at `epoch`, every chunk authenticated."""
    head, body = raw[:48], raw[48:]  # §13.1
    ok(len(head) == 48 and head[:8] == b"LIBER\x01\x01\x10" and head[44:] == bytes(4),
       what + " header")
    ok(head[40:44] == be32(epoch), what + " epoch")
    full, rem = divmod(len(body), SEG)  # §13.4
    ok((rem == 0 and full > 0) or (rem == 16 and full == 0) or rem > 16, what + " length")
    gcm = AESGCM(hkdf(SHA256, 32, content_key, head[8:40], b"liber/v1/file"))  # §13.2
    segs = [body[i:i + SEG] for i in range(0, len(body), SEG)]
    try:
        return b"".join(  # §13.3: nonce = 11-byte BE counter ‖ last flag, AAD = header
            gcm.decrypt(bytes(3) + i.to_bytes(8, "big") + bytes([i == len(segs) - 1]), s, head)
            for i, s in enumerate(segs))
    except InvalidTag:
        raise SystemExit("xcheck: FAIL " + what + " content authentication")


def main(d):
    v = json.loads((d / "vectors.json").read_bytes())
    vid, epoch, vk = bytes.fromhex(v["vault_id"]), v["epoch"], bytes.fromhex(v["vk"])
    pw = v["passphrase"]

    # §4.1
    sub = {n: hkdf(SHA512, 64 if n == "name" else 32, vk, vid, b"liber/v1/" + n.encode())
           for n in ("content", "name", "header", "index")}
    ok({n: k.hex() for n, k in sub.items()} == v["subkeys"], "subkeys")

    h, slots, hvid, hepoch, hvk, aad = open_header(d / "header.json", v["recovery_code"], pw)
    ok((hvid, hepoch, hvk) == (vid, epoch, vk), "header opens to the vectors' vault key")
    kdf = slots["passphrase"]["kdf"]
    ok({p: kdf[p] for p in ("m_kib", "t", "p")} == v["params"], "argon2 params")
    dev = slots["device"]  # §7.4
    ok(dev["device_id"] == v["device"]["device_id"], "device id")
    kek = hkdf(SHA256, 32, bytes.fromhex(v["device"]["secret"]), vid, b"liber/v1/slot/device")
    ok(unwrap(kek, dev, aad(dev)) == vk, "device slot")
    rm = h["removed"]  # §6, §11
    ok(rm and rm == sorted(rm, key=b64d) and not set(rm) & {s["id"] for s in h["slots"]},
       "removed tombstones")

    siv = AESSIV(sub["name"])  # §14.1
    for n in v["names"]:
        kind = {"file": b"f", "folder": b"d"}[n["kind"]]
        enc = n["on_disk"]
        if kind == b"f":
            ok(enc.endswith(".libere"), "file suffix")
            enc = enc[:-len(".libere")]
        # §14.2, §14.3
        pt = siv.decrypt(b64d(enc), [vid, be32(epoch), bytes.fromhex(n["parent"]), kind])
        want = unicodedata.normalize("NFC", n["name"]).encode()
        if kind == b"d":
            want = bytes.fromhex(n["folder_id"]) + want
        ok(pt == want, "name " + n["name"])
        ok((len(n["on_disk"]) > 200) == ("short" in n), "long-name threshold")
        if "short" in n:  # §14.5
            stem = base64.b32encode(hashlib.sha256(n["on_disk"].encode()).digest())
            stem = stem.decode()[:32].lower()
            ok(n["short"] == {"on_disk": stem + ".liberl", "side_file": stem + ".libern"},
               "short name")
    ok(any("short" in n for n in v["names"]), "a long name is covered")
    ok(any(unicodedata.normalize("NFC", n["name"]) != n["name"] for n in v["names"]),
       "an NFD name is covered")

    for f in v["files"]:  # §13
        ok(f["name"] == Path(f["name"]).name and f["name"] not in ("", ".", "..")
           and "\\" not in f["name"], "vector file name " + repr(f["name"]))
        raw = (d / f["name"]).read_bytes()
        ok(raw[8:40].hex() == f["salt"], f["name"] + " salt")
        ok(len(raw) == 48 + f["len"] + 16 * max(1, -(-f["len"] // CHUNK)),  # §13.3
           f["name"] + " chunk count")
        plain = stream_plain(raw, sub["content"], epoch, f["name"])
        ok(plain == bytes(i % 251 for i in range(f["len"])), f["name"] + " plaintext")

    r = v["rotated"]  # §10
    rh, _, rvid, repoch, rvk, _ = open_header(d / "header-rotated.json", r["recovery_code"], pw)
    ok(rvid == vid and repoch == r["epoch"] == epoch + 1 and rvk.hex() == r["vk"], "rotated")
    ret = rh["retiring"]
    ok(ret["epoch"] == epoch, "retiring epoch")
    old = AESGCM(hkdf(SHA256, 32, rvk, vid, b"liber/v1/retiring")).decrypt(
        b64d(ret["nonce"]), b64d(ret["wrapped"]), b"liber/v1/retiring" + vid + be32(epoch))
    ok(old == vk, "retiring key")

    k, ks = load(d / "keyring.liberk", "liber-keyring")  # §12
    kid = b64d(k["keyring_id"])

    def kaad(s):  # §12.3
        return b"liber/v1/keyring-slot" + kid + b64d(s["id"]) + s["type"].encode()

    code = recovery_secret(v["keyring"]["recovery_code"])
    seed = unwrap(hkdf(SHA256, 32, code, kid, b"liber/v1/keyring-slot/recovery"),
                  ks["recovery"], kaad(ks["recovery"]))
    if Argon2id:
        p = ks["passphrase"]
        ok(unwrap(passphrase_kek(pw, p["kdf"]), p, kaad(p)) == seed, "keyring passphrase")
    check_mac(k, hkdf(SHA256, 32, seed, kid, b"liber/v1/keyring/mac"), "keyring mac")  # §12.4
    commit_key = hkdf(SHA256, 32, seed, kid, b"liber/v1/keyring/commit")  # §12.5
    commit = hmac.new(commit_key, vid + sub["header"], hashlib.sha256).digest()
    ok(k["enrolled"] == [{"vault_id": b64e(vid), "commit": b64e(commit)}], "keyring enrolment")
    ok(slots["keyring"]["keyring_id"] == k["keyring_id"], "the vault's keyring slot")  # §7.5

    print(f"xcheck: subkeys ok, names ok ({len(v['names'])}), files ok ({len(v['files'])}), "
          "header mac ok, recovery ok, "
          + ("passphrase ok" if Argon2id else "passphrase not covered (cryptography < 44)")
          + ", device ok, retiring ok, keyring file ok; "
          "x-wing not covered (vault keyring slot, keyring public key)")


def decode_name(siv, enc, vid, epoch, parent, kind):  # §14.4
    ok(len(enc) <= 1024, "encoded name length")
    try:
        pt = siv.decrypt(b64d(enc), [vid, be32(epoch), parent, kind])  # §14.2
    except InvalidTag:
        raise SystemExit("xcheck: FAIL name authentication: " + enc)
    folder_id = None
    if kind == b"d":
        ok(len(pt) >= 16, "folder name holds its id")
        folder_id, pt = pt[:16], pt[16:]
    name = pt.decode()
    ok(name not in ("", ".", "..") and not set(name) & set("/\\\0"), "name " + repr(name))
    ok(unicodedata.normalize("NFC", name) == name, "name is NFC: " + repr(name))  # §14.3
    return name, folder_id


def vault(root, pw, expected):
    """Unlocks an E3 vault with its passphrase (§7.2, §7.7) and decrypts its whole tree."""
    if Argon2id is None:
        print("xcheck: cryptography has no Argon2id (needs >= 44)", file=sys.stderr)
        sys.exit(77)
    h, _ = load(root / "liber-vault.json", "liber-vault")  # §5, §6
    vid, epoch = b64d(h["vault_id"]), h["epoch"]
    ok(h["retiring"] is None, "no rotation in progress (the vault mode reads one epoch)")
    vk = None
    for s in h["slots"]:  # §7.7: passphrase slots in array order, first unwrap wins
        if s["type"] != "passphrase":
            continue
        aad = b"liber/v1/slot" + vid + be32(epoch) + b64d(s["id"]) + b"passphrase"  # §7.1
        try:
            vk = unwrap(passphrase_kek(pw, s["kdf"]), s, aad)
            break
        except InvalidTag:
            continue
    ok(vk is not None and len(vk) == 32, "a passphrase slot opens the vault")
    sub = {n: hkdf(SHA512, 64 if n == "name" else 32, vk, vid, b"liber/v1/" + n.encode())
           for n in ("content", "name", "header")}  # §4.1
    check_mac(h, sub["header"], "liber-vault.json mac")
    top = sorted(p.name for p in root.iterdir())
    ok(top == ["README.txt", "d", "liber-vault.json"], "vault top level " + repr(top))

    siv, found, stack = AESSIV(sub["name"]), {}, [(root / "d", "", bytes(16))]
    while stack:
        here, logical, parent = stack.pop()
        for p in sorted(here.iterdir()):
            on_disk, what = p.name, str(p.relative_to(root))
            if on_disk.endswith(".libern"):  # read with its .liberl entry
                ok((here / (on_disk[:-7] + ".liberl")).exists(), what + " orphan side file")
                continue
            ok(not on_disk.startswith("."), what + " leftover temp file")
            if on_disk.endswith(".liberl"):  # §14.5
                stem = on_disk[:-7]
                on_disk = (here / (stem + ".libern")).read_bytes().decode("ascii")
                h32 = base64.b32encode(hashlib.sha256(on_disk.encode()).digest()).decode()
                ok(len(on_disk) > 200 and h32[:32].lower() == stem, what + " long name hash")
            if p.is_dir():
                name, fid = decode_name(siv, on_disk, vid, epoch, parent, b"d")
                path = logical + name
                found[path] = "dir"
                stack.append((p, path + "/", fid))
            else:
                ok(on_disk.endswith(".libere"), what + " file suffix")
                name, _ = decode_name(siv, on_disk[:-7], vid, epoch, parent, b"f")
                path = logical + name
                found[path] = stream_plain(p.read_bytes(), sub["content"], epoch, path).hex()
    want = json.loads(expected.read_bytes())
    for path in sorted(set(want) | set(found)):
        ok(want.get(path) == found.get(path), "vault entry " + repr(path) + (
            " missing" if path not in found else " unexpected" if path not in want
            else " differs"))
    files = sum(v != "dir" for v in found.values())
    print(f"xcheck vault: header mac ok, passphrase ok, {len(found) - files} folders and "
          f"{files} files decrypted and equal to expected.json")


if __name__ == "__main__":
    if sys.argv[1] == "vault":
        vault(Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]))
    else:
        main(Path(sys.argv[1]))
