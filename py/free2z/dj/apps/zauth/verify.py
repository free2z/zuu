"""
Stateless verification of Zcash Signed Messages over transparent P2PKH addresses.

Coincurve's native libsecp256k1 binding recovers the public key from the
signature and message digest. Its compressed P2PKH address must match the
claimed address. Verification runs in-process without a wallet, private key,
node connection or chain state.

The scheme is exactly what the ZUULI wallet plugin's ``sign_challenge``
("ZUULI Zcash Login v1") emits and what zcashd ``signmessage`` emitted:

  magic  = "Zcash Signed Message:\\n"
  data   = CompactSize(len(magic)) ++ magic
             ++ CompactSize(len(message)) ++ message
  digest = SHA256(SHA256(data))
  sig    = base64( header(1) ++ r(32) ++ s(32) )
           header = 27 + recovery_id (+4 when the pubkey is compressed)

  address = base58check([0x1C, 0xB8] ++ RIPEMD160(SHA256(compressed_pubkey)))
"""
import base64
import hashlib

from coincurve import PublicKey

MESSAGE_MAGIC = b"Zcash Signed Message:\n"
# Mainnet transparent P2PKH version bytes (base58 prefix "t1").
MAINNET_P2PKH_PREFIX = bytes([0x1C, 0xB8])
SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def _compact_size(n: int) -> bytes:
    """Bitcoin/Zcash CompactSize (varint) length prefix."""
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xFD" + n.to_bytes(2, "little")
    if n <= 0xFFFF_FFFF:
        return b"\xFE" + n.to_bytes(4, "little")
    return b"\xFF" + n.to_bytes(8, "little")


def message_digest(message: str) -> bytes:
    """The 32-byte double-SHA256 digest that the message signature is over."""
    body = message.encode("utf-8")
    data = (
        _compact_size(len(MESSAGE_MAGIC))
        + MESSAGE_MAGIC
        + _compact_size(len(body))
        + body
    )
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def _ripemd160(data: bytes) -> bytes:
    try:
        h = hashlib.new("ripemd160")
    except ValueError:  # pragma: no cover - OpenSSL without legacy provider
        return _ripemd160_pure(data)
    h.update(data)
    return h.digest()


def _hash160(data: bytes) -> bytes:
    return _ripemd160(hashlib.sha256(data).digest())


def _b58check(payload: bytes) -> str:
    checksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    n = int.from_bytes(payload + checksum, "big")
    alphabet = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    out = bytearray()
    while n > 0:
        n, rem = divmod(n, 58)
        out.append(alphabet[rem])
    # Leading zero bytes -> leading '1's.
    for byte in payload + checksum:
        if byte == 0:
            out.append(alphabet[0])
        else:
            break
    out.reverse()
    return out.decode("ascii")


def p2pkh_address(pubkey_compressed: bytes) -> str:
    """Mainnet transparent P2PKH t-address for a 33-byte compressed pubkey."""
    return _b58check(MAINNET_P2PKH_PREFIX + _hash160(pubkey_compressed))


def verify_message(address: str, signature_b64: str, message: str) -> bool:
    """
    Return True iff ``signature_b64`` is a valid Zcash message signature over
    ``message`` by the key controlling the mainnet transparent ``address``.

    Recovers the signing public key from the recoverable signature (as
    ``verifymessage`` does) and checks that its P2PKH address equals
    ``address``. Any malformed input returns False (never raises).
    """
    try:
        raw = base64.b64decode(signature_b64, validate=True)
    except Exception:
        return False
    if len(raw) != 65:
        return False

    header = raw[0]
    # 27..30 uncompressed, 31..34 compressed. recovery_id is the low 2 bits.
    if not (27 <= header <= 34):
        return False
    recovery_id = (header - 27) & 0x03

    # The wallet protocol supports the two recovery parities used by the
    # existing verifier. Do not broaden it to libsecp256k1's IDs 2 and 3.
    if recovery_id >= 2:
        return False

    # Public-key recovery alone is not signature validation: the former
    # Python implementation could recover a key for zero/out-of-range
    # scalars. Require valid ECDSA scalars, while preserving high-S signatures.
    r = int.from_bytes(raw[1:33], "big")
    s = int.from_bytes(raw[33:], "big")
    if not (0 < r < SECP256K1_ORDER and 0 < s < SECP256K1_ORDER):
        return False

    digest = message_digest(message)
    try:
        # Coincurve expects r || s || recovery_id; the wallet puts its header
        # first. The digest already includes Zcash framing and double SHA256.
        key = PublicKey.from_signature_and_message(
            raw[1:] + bytes([recovery_id]), digest, hasher=None,
        )
        # Retain compressed-address derivation for both accepted header forms.
        recovered = p2pkh_address(key.format(compressed=True))
    except Exception:
        return False
    return recovered == address


def _ripemd160_pure(data: bytes) -> bytes:  # pragma: no cover
    """Minimal pure-Python RIPEMD-160, used only if OpenSSL lacks it."""
    import struct

    def rol(x, n):
        return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF

    rl = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
        3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
        1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
        4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
    ]
    rr = [
        5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
        6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
        15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
        8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
        12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
    ]
    sl = [
        11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
        7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
        11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
        11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
        9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
    ]
    sr = [
        8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
        9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
        9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
        15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
        8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
    ]
    kl = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E]
    kr = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000]

    def f(j, x, y, z):
        if j < 16:
            return x ^ y ^ z
        if j < 32:
            return (x & y) | (~x & z)
        if j < 48:
            return (x | ~y) ^ z
        if j < 64:
            return (x & z) | (y & ~z)
        return x ^ (y | ~z)

    h0, h1, h2, h3, h4 = (
        0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0,
    )
    msg = bytearray(data)
    length = (8 * len(data)) & 0xFFFFFFFFFFFFFFFF
    msg.append(0x80)
    while len(msg) % 64 != 56:
        msg.append(0)
    msg += struct.pack("<Q", length)

    for off in range(0, len(msg), 64):
        x = list(struct.unpack("<16I", msg[off:off + 64]))
        al, bl, cl, dl, el = h0, h1, h2, h3, h4
        ar, br, cr, dr, er = h0, h1, h2, h3, h4
        for j in range(80):
            t = (al + f(j, bl, cl, dl) + x[rl[j]] + kl[j // 16]) & 0xFFFFFFFF
            t = (rol(t, sl[j]) + el) & 0xFFFFFFFF
            al, bl, cl, dl, el = el, t, bl, rol(cl, 10), dl
            t = (ar + f(79 - j, br, cr, dr) + x[rr[j]] + kr[j // 16]) & 0xFFFFFFFF
            t = (rol(t, sr[j]) + er) & 0xFFFFFFFF
            ar, br, cr, dr, er = er, t, br, rol(cr, 10), dr
        t = (h1 + cl + dr) & 0xFFFFFFFF
        h1 = (h2 + dl + er) & 0xFFFFFFFF
        h2 = (h3 + el + ar) & 0xFFFFFFFF
        h3 = (h4 + al + br) & 0xFFFFFFFF
        h4 = (h0 + bl + cr) & 0xFFFFFFFF
        h0 = t
    return struct.pack("<5I", h0, h1, h2, h3, h4)
