"""Independent reader for the Liber Linteum v1 test vectors (spec §4.4).

Re-derives every value it checks with the standard library and the `cryptography` package,
never with the Rust code. X-Wing is not covered (`cryptography` has none): the vault header's
keyring slot and the keyring's public key are checked only by the Rust test.

Usage: python3 -I xcheck.py <vectors dir>
Exit 0: all checks pass. Exit 77: `cryptography` (with AES-SIV) is not installed.
"""

import base64
import hashlib
import hmac
import json
import sys
import unicodedata
from pathlib import Path

try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM, AESSIV
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
except ImportError:
    sys.exit(77)
try:
    from cryptography.hazmat.primitives.kdf.argon2 import Argon2id  # cryptography >= 44
except ImportError:
    Argon2id = None

SHA256, SHA512 = hashes.SHA256(), hashes.SHA512()
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
SEG = 65536 + 16  # one chunk on disk: ciphertext plus GCM tag


def ok(cond, what):
    if not cond:
        raise SystemExit("xcheck: FAIL " + what)


def hkdf(alg, length, ikm, salt, info):
    return HKDF(algorithm=alg, length=length, salt=salt, info=info).derive(ikm)


def b64d(s):
    return base64.b64decode(s + "=" * (-len(s) % 4), altchars="-_", validate=True)


def b64e(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def canonical(v):
    # serde_json writes raw UTF-8: ensure_ascii=True would escape "é" and break the MAC.
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def crockford(b):
    bits = len(b) * 8
    n = -(-bits // 5)
    x = int.from_bytes(b, "big") << (n * 5 - bits)
    return "".join(CROCKFORD[(x >> (5 * i)) & 31] for i in reversed(range(n)))


def recovery_secret(code):
    """`LIBER-` + 13 groups of Crockford base32 (256 bits) + a checksum group."""
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


def unwrap(kek, slot, aad):
    return AESGCM(kek).decrypt(b64d(slot["nonce"]), b64d(slot["wrapped"]), aad)


def passphrase_kek(pw, kdf):
    ok(kdf["alg"] == "argon2id", "kdf alg")
    k = Argon2id(salt=b64d(kdf["salt"]), length=32, iterations=kdf["t"], lanes=kdf["p"],
                 memory_cost=kdf["m_kib"])
    return k.derive(unicodedata.normalize("NFC", pw).encode())


def be32(n):
    return n.to_bytes(4, "big")


def load(path, fmt):
    raw = path.read_bytes()
    v = json.loads(raw)
    ok(canonical(v) == raw, path.name + " is canonical JSON")
    ok(v["format"] == fmt and v["version"] == 1, path.name + " format")
    return v, {s["type"]: s for s in v["slots"]}


def check_mac(v, key, what):
    v = dict(v)
    mac = b64d(v.pop("mac"))
    ok(hmac.compare_digest(mac, hmac.new(key, canonical(v), hashlib.sha256).digest()), what)


def open_header(path, code, pw):
    """Unwraps the VK from the recovery (and passphrase) slot, then checks the header MAC."""
    h, slots = load(path, "liber-vault")
    vid, epoch = b64d(h["vault_id"]), h["epoch"]

    def aad(s):
        return b"liber/v1/slot" + vid + be32(epoch) + b64d(s["id"]) + s["type"].encode()

    rec = slots["recovery"]
    vk = unwrap(hkdf(SHA256, 32, recovery_secret(code), vid, b"liber/v1/slot/recovery"),
                rec, aad(rec))
    check_mac(h, hkdf(SHA512, 32, vk, vid, b"liber/v1/header"), path.name + " mac")
    if Argon2id:
        p = slots["passphrase"]
        ok(unwrap(passphrase_kek(pw, p["kdf"]), p, aad(p)) == vk, path.name + " passphrase")
    return h, slots, vid, epoch, vk, aad


def main(d):
    v = json.loads((d / "vectors.json").read_bytes())
    vid, epoch, vk = bytes.fromhex(v["vault_id"]), v["epoch"], bytes.fromhex(v["vk"])
    pw = v["passphrase"]

    sub = {n: hkdf(SHA512, 64 if n == "name" else 32, vk, vid, b"liber/v1/" + n.encode())
           for n in ("content", "name", "header", "index")}
    ok({n: k.hex() for n, k in sub.items()} == v["subkeys"], "subkeys")

    h, slots, hvid, hepoch, hvk, aad = open_header(d / "header.json", v["recovery_code"], pw)
    ok((hvid, hepoch, hvk) == (vid, epoch, vk), "header opens to the vectors' vault key")
    kdf = slots["passphrase"]["kdf"]
    ok({p: kdf[p] for p in ("m_kib", "t", "p")} == v["params"], "argon2 params")
    dev = slots["device"]
    ok(dev["device_id"] == v["device"]["device_id"], "device id")
    kek = hkdf(SHA256, 32, bytes.fromhex(v["device"]["secret"]), vid, b"liber/v1/slot/device")
    ok(unwrap(kek, dev, aad(dev)) == vk, "device slot")
    rm = h["removed"]
    ok(rm and rm == sorted(rm, key=b64d) and not set(rm) & {s["id"] for s in h["slots"]},
       "removed tombstones")

    siv = AESSIV(sub["name"])
    for n in v["names"]:
        kind = {"file": b"f", "folder": b"d"}[n["kind"]]
        enc = n["on_disk"]
        if kind == b"f":
            ok(enc.endswith(".libere"), "file suffix")
            enc = enc[:-len(".libere")]
        pt = siv.decrypt(b64d(enc), [vid, be32(epoch), bytes.fromhex(n["parent"]), kind])
        want = unicodedata.normalize("NFC", n["name"]).encode()
        if kind == b"d":
            want = bytes.fromhex(n["folder_id"]) + want
        ok(pt == want, "name " + n["name"])
        ok((len(n["on_disk"]) > 200) == ("short" in n), "long-name threshold")
        if "short" in n:
            stem = base64.b32encode(hashlib.sha256(n["on_disk"].encode()).digest())
            stem = stem.decode()[:32].lower()
            ok(n["short"] == {"on_disk": stem + ".liberl", "side_file": stem + ".libern"},
               "short name")
    ok(any("short" in n for n in v["names"]), "a long name is covered")
    ok(any(unicodedata.normalize("NFC", n["name"]) != n["name"] for n in v["names"]),
       "an NFD name is covered")

    for f in v["files"]:
        raw = (d / f["name"]).read_bytes()
        head, body = raw[:48], raw[48:]
        ok(head[:8] == b"LIBER\x01\x01\x10" and head[44:] == bytes(4), f["name"] + " header")
        salt = head[8:40]
        ok(salt.hex() == f["salt"] and head[40:44] == be32(epoch), f["name"] + " salt, epoch")
        gcm = AESGCM(hkdf(SHA256, 32, sub["content"], salt, b"liber/v1/file"))
        segs = [body[i:i + SEG] for i in range(0, len(body), SEG)]
        ok(len(segs) > 0, f["name"] + " has a last chunk")
        plain = b"".join(
            gcm.decrypt(bytes(3) + i.to_bytes(8, "big") + bytes([i == len(segs) - 1]), s, head)
            for i, s in enumerate(segs))
        ok(plain == bytes(i % 251 for i in range(f["len"])), f["name"] + " plaintext")

    r = v["rotated"]
    rh, _, rvid, repoch, rvk, _ = open_header(d / "header-rotated.json", r["recovery_code"], pw)
    ok(rvid == vid and repoch == r["epoch"] == epoch + 1 and rvk.hex() == r["vk"], "rotated")
    ret = rh["retiring"]
    ok(ret["epoch"] == epoch, "retiring epoch")
    old = AESGCM(hkdf(SHA256, 32, rvk, vid, b"liber/v1/retiring")).decrypt(
        b64d(ret["nonce"]), b64d(ret["wrapped"]), b"liber/v1/retiring" + vid + be32(epoch))
    ok(old == vk, "retiring key")

    k, ks = load(d / "keyring.liberk", "liber-keyring")
    kid = b64d(k["keyring_id"])

    def kaad(s):
        return b"liber/v1/keyring-slot" + kid + b64d(s["id"]) + s["type"].encode()

    code = recovery_secret(v["keyring"]["recovery_code"])
    seed = unwrap(hkdf(SHA256, 32, code, kid, b"liber/v1/keyring-slot/recovery"),
                  ks["recovery"], kaad(ks["recovery"]))
    if Argon2id:
        p = ks["passphrase"]
        ok(unwrap(passphrase_kek(pw, p["kdf"]), p, kaad(p)) == seed, "keyring passphrase")
    check_mac(k, hkdf(SHA256, 32, seed, kid, b"liber/v1/keyring/mac"), "keyring mac")
    commit_key = hkdf(SHA256, 32, seed, kid, b"liber/v1/keyring/commit")
    commit = hmac.new(commit_key, vid + sub["header"], hashlib.sha256).digest()
    ok(k["enrolled"] == [{"vault_id": b64e(vid), "commit": b64e(commit)}], "keyring enrolment")
    ok(slots["keyring"]["keyring_id"] == k["keyring_id"], "the vault's keyring slot")

    print(f"xcheck: subkeys ok, names ok ({len(v['names'])}), files ok ({len(v['files'])}), "
          "header mac ok, recovery ok, "
          + ("passphrase ok" if Argon2id else "passphrase not covered (cryptography < 44)")
          + ", device ok, retiring ok, keyring file ok; "
          "x-wing not covered (vault keyring slot, keyring public key)")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
