"""The wire format, the issuing key, and nothing else.

Two jobs, kept apart from the view so that both are readable on their own:

1. **Encode and sign a ``HandleAssertion``** exactly as the Rust verifier
   (``rs/crates/f2z-authority`` on ``free2z/zuu``, branch
   ``feature/kt-authority``) decodes it. Every structure below is the
   ``tls_codec`` encoding of the corresponding Rust type. The conformance test
   in ``tests/test_conformance_vectors.py`` pins the bytes.

2. **Hold the issuing key**, fetched once at boot from GCP Secret Manager and
   kept in memory only.

The wire format
---------------

``KT.md`` §1.3 fixes ``H(label, x) = BLAKE2b-256(label || x)`` with no separator
and no terminator, and structures are TLS presentation language encoded with
``tls_codec``. That gives, field by field::

    struct {
        opaque label<0..255>;      /* "free2z/kt/v1/handle-assertion" */
        opaque authority_id[32];   /* H("free2z/kt/v1/authority-id", authority_pk) */
        opaque log_id[32];
        opaque handle<1..30>;
        opaque handle_id[32];      /* H("free2z/kt/v1/handle-id", handle) */
        opaque identity_pk[32];
        uint8  intent;             /* bind(1), reset(2) */
        uint32 account_epoch;
        uint64 issued_ms;
        uint64 expires_ms;
        opaque nonce[16];
    } HandleAssertionTBS;

    struct {
        HandleAssertionTBS assertion;
        opaque             signature[64];   /* Ed25519 by authority_id's key */
    } HandleAssertion;

Fixed-width ``opaque`` fields carry no length prefix; the two variable ones
(``label``, ``handle``) carry a single length byte because both bounds fit in a
``uint8``. Integers are unsigned and big-endian. ``authority_id`` and
``handle_id`` are *derived*, never accepted, so an assertion cannot name one
authority and be signed by another, or name one handle and be indexed under
another.

Why the key comes over REST rather than through ``google-cloud-secret-manager``
------------------------------------------------------------------------------

The official client would be a new pinned production dependency, a new entry in
the ``pip-audit`` surface, and a new module that must land in the deployed image
(``py/BUILD.bazel``) — for one unauthenticated-by-us GET. ``google-auth`` and
``requests`` are already production dependencies (``google-cloud-pubsub``,
``django-storages[google]``), and the Secret Manager v1 ``:access`` endpoint is
one request with one base64 field in the response. The trade is deliberate: less
dependency surface, a few more lines here. If a second caller ever needs Secret
Manager, take the library instead — do not copy this module.

Failure is scoped
-----------------

Nothing here raises at import time and nothing here raises out of
:func:`prime` — a key that cannot be fetched makes *this endpoint* answer 503
with one of:data:`REASON_CODES` and leaves the rest of the platform untouched.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import re
import secrets
import struct
import threading
import time

from cryptography.exceptions import InvalidKey, UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
)
from django.conf import settings

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Domain separation. Every label this module signs under or hashes with.
#
# `KT.md` §1.3's H(label, x) is only unambiguous while no label is a prefix of
# another, which is a property of the *set*. `tests/test_wire_format.py` holds
# it mechanically across these and the labels KT.md v1 already spends.
# --------------------------------------------------------------------------

#The `label` field of a HandleAssertionTBS, and therefore the first bytes of
#everything this authority signs. An issuing key used elsewhere cannot have
#one of its other signatures reinterpreted as an assertion.
LABEL_ASSERTION_TBS = b"free2z/kt/v1/handle-assertion"

#``authority_id = H("free2z/kt/v1/authority-id", authority_pk)``. Derived, so
#an authority-set entry cannot name one key and carry another.
LABEL_AUTHORITY_ID = b"free2z/kt/v1/authority-id"

#``handle_id = H("free2z/kt/v1/handle-id", handle)``.
LABEL_HANDLE_ID = b"free2z/kt/v1/handle-id"

#Every label this module defines, so a test can hold the set prefix-free.
LABELS = (LABEL_ASSERTION_TBS, LABEL_AUTHORITY_ID, LABEL_HANDLE_ID)

#The labels ``KT.md`` v1 already spends, restated **only** so the prefix-free
#test can range over both sets. Nothing here reads it; the log's own crate
#owns those structures. It is here because "no label is a prefix of another"
#is a property of the whole ``free2z/kt/v1/`` namespace at once, and a test
#that sees half of it proves half of it.
KT_LABELS = (
    b"free2z/kt/v1/entry",
    b"free2z/kt/v1/rotation",
    b"free2z/kt/v1/reset",
    b"free2z/kt/v1/receipt",
    b"free2z/kt/v1/prev",
    b"free2z/kt/v1/value",
    b"free2z/kt/v1/handle:",
    b"free2z/kt/v1/assertion-binding",
    b"free2z/kt/v1/assertion-digest",
)


# --------------------------------------------------------------------------
# Handles and intents
# --------------------------------------------------------------------------

#``[a-z0-9_]{1,30}``, ASCII, compared as bytes (``WIRE.md`` §14.1, ``KT.md``
#§1.3). Matched against ``bytes`` on purpose: a handle is a byte string in
#the wire format and nothing here folds, normalizes or decodes it.
HANDLE_RE = re.compile(rb"^[a-z0-9_]{1,30}\Z")

#Wire codes for ``Intent``. ``bind`` is valid only at ``entry_version == 1``;
#``reset`` only above it. The log ties each to a position in the handle's
#entry sequence, so an assertion minted to claim a fresh handle cannot be
#re-presented to take over an established one.
INTENT_BIND = 1
INTENT_RESET = 2
INTENTS = {"bind": INTENT_BIND, "reset": INTENT_RESET}

#The verifier's own cap on ``expires_ms - issued_ms``
#(``f2z_authority::DEFAULT_MAX_VALIDITY_MS``). The log holds this
#independently of the issuer, which is the point — a compromised issuer
#cannot mint a long-lived assertion. We clamp to it so a misconfigured TTL
#produces a *usable* assertion rather than one every log refuses.
MAX_VALIDITY_MS = 900_000

#What we issue by default: five minutes. An assertion is presented to the log
#immediately by a device that has just enrolled, so the window only has to
#cover one round trip and a clock disagreement.
DEFAULT_TTL_MS = 300_000

#``KT.md`` §4.5.4 rule **A18a**: ``account_epoch`` is strictly below ``2^20``.
#
#The verifier's second independent bound, and it lives beside
#:data:`MAX_VALIDITY_MS` for the same reason — both are the log's to enforce,
#and both are applied here as well so a value no log will admit is refused at
#the issuer's own keyboard rather than at somebody else's log.
#``f2z_authority::ACCOUNT_EPOCH_CEILING`` is the same number, and
#``HandleAssertionTBS::new`` refuses on it in exactly this position.
#
#Unlike ``MAX_VALIDITY_MS`` this is a fixed published constant rather than a
#per-log policy number: the same bound on every log is one a client can apply
#without first fetching a policy document.
ACCOUNT_EPOCH_CEILING = 1 << 20


def kt_hash(label: bytes, data: bytes) -> bytes:
    """``H(label, x) = BLAKE2b-256(label || x)`` — ``KT.md`` §1.3."""
    digest = hashlib.blake2b(digest_size=32)
    digest.update(label)
    digest.update(data)
    return digest.digest()


def handle_id(handle: bytes) -> bytes:
    """``handle_id = H("free2z/kt/v1/handle-id", handle)``."""
    return kt_hash(LABEL_HANDLE_ID, handle)


def authority_id(authority_pk: bytes) -> bytes:
    """``authority_id = H("free2z/kt/v1/authority-id", authority_pk)``."""
    return kt_hash(LABEL_AUTHORITY_ID, authority_pk)


def b64u_encode(raw: bytes) -> str:
    """Unpadded base64url (RFC 4648 §5), which is what this API emits."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64u_decode_fixed(text: str, length: int) -> bytes:
    """Decode base64url to exactly ``length`` bytes, or raise ``ValueError``.

    Padding is optional — ``AAAA...`` and ``AAAA...=`` decode the same 32 bytes
    and there is no ambiguity between them — but nothing else is tolerated:
    standard base64's ``+`` and ``/`` are rejected, so is whitespace, and so is
    any input that does not decode to exactly ``length`` bytes. A key that
    arrives in the wrong alphabet is a client bug worth surfacing, not
    something to guess at.
    """
    if not isinstance(text, str) or not text:
        raise ValueError("expected a non-empty base64url string")
    if not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", text):
        raise ValueError("expected base64url (RFC 4648 section 5) characters")
    padded = text + "=" * (-len(text) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("not decodable as base64url") from exc
    if len(raw) != length:
        raise ValueError(f"expected {length} bytes, got {len(raw)}")
    return raw


def check_identity_key(raw: bytes) -> None:
    """Refuse an ``identity_pk`` that is not a decodable Ed25519 public key.

    This checks the encoding and stops there. It deliberately does **not**
    screen small-order or otherwise degenerate points, and the reason is worth
    writing down rather than leaving as an omission: an assertion authorizes
    nothing on its own. ``KT.md`` requires the submission carrying it to also
    be signed by this identity key, checked with ``verify_strict``, which
    rejects a small-order key outright. So an assertion naming a key nobody can
    hold produces no valid submission, and the only cost of minting one falls
    on the account that asked for it, whose own throttle bucket it spends. A
    curve-arithmetic screen here would buy nothing and would put constants
    nobody can check by eye on the request path.
    """
    if len(raw) != 32:
        raise ValueError("an identity key is 32 bytes")
    try:
        Ed25519PublicKey.from_public_bytes(raw)
    except (ValueError, InvalidKey, UnsupportedAlgorithm) as exc:
        raise ValueError("not a valid Ed25519 public key") from exc


# --------------------------------------------------------------------------
# Encoding
# --------------------------------------------------------------------------


def _opaque_u8(value: bytes) -> bytes:
    """``opaque x<0..255>``: one length byte, then the bytes."""
    if len(value) > 255:
        raise ValueError("value does not fit an 8-bit length prefix")
    return bytes((len(value),)) + value


def encode_assertion_tbs(
    *,
    authority_pk: bytes,
    log_id: bytes,
    handle: bytes,
    identity_pk: bytes,
    intent: int,
    account_epoch: int,
    issued_ms: int,
    expires_ms: int,
    nonce: bytes,
) -> bytes:
    """``tls_codec(HandleAssertionTBS)`` — the exact bytes the authority signs.

    ``authority_id`` and ``handle_id`` are derived here rather than accepted,
    for the reason the Rust constructor derives them: a hand-built assertion
    then cannot contradict itself.
    """
    if len(log_id) != 32:
        raise ValueError("log_id is 32 bytes")
    if len(identity_pk) != 32:
        raise ValueError("identity_pk is 32 bytes")
    if len(authority_pk) != 32:
        raise ValueError("authority_pk is 32 bytes")
    if len(nonce) != 16:
        raise ValueError("nonce is 16 bytes")
    if not HANDLE_RE.match(handle):
        raise ValueError("handle is outside [a-z0-9_]{1,30}")
    if intent not in (INTENT_BIND, INTENT_RESET):
        raise ValueError("intent is bind(1) or reset(2)")
    # The field is a `uint32`, but `KT.md` §4.5.4 A18a bounds it far tighter and
    # every log refuses the difference, so the tighter bound is the one applied
    # here. This is the check that makes  unrepeatable: Unix seconds is
    # ~1.79e9 and Unix milliseconds does not fit a uint32 at all, so an issuer
    # that reaches for a clock because a counter was inconvenient cannot even
    # build the bytes. `HandleAssertionTBS::new` refuses in the same position
    # for the same reason.
    if not 0 <= account_epoch < ACCOUNT_EPOCH_CEILING:
        raise ValueError(
            "account_epoch is not a counter: it must be in "
            f"[0, {ACCOUNT_EPOCH_CEILING}) -- KT.md 4.5.4 A18a"
        )
    for name, value in (("issued_ms", issued_ms), ("expires_ms", expires_ms)):
        if not 0 <= value <= 0xFFFFFFFFFFFFFFFF:
            raise ValueError(f"{name} does not fit a uint64")

    return b"".join(
        (
            _opaque_u8(LABEL_ASSERTION_TBS),
            authority_id(authority_pk),
            log_id,
            _opaque_u8(handle),
            handle_id(handle),
            identity_pk,
            struct.pack("!B", intent),
            struct.pack("!I", account_epoch),
            struct.pack("!Q", issued_ms),
            struct.pack("!Q", expires_ms),
            nonce,
        )
    )


# --------------------------------------------------------------------------
# The issuing key
# --------------------------------------------------------------------------

#Every reason this endpoint can be unavailable. Bounded and enumerated so a
#503 body carries a code a client can branch on and an operator can alert on,
#and never a Google error string, a resource name or anything else that
#describes our deployment to a caller.
REASON_UNCONFIGURED = "authority_unconfigured"
REASON_LOG_UNCONFIGURED = "log_unconfigured"
REASON_FETCH_FAILED = "authority_key_unavailable"
REASON_KEY_INVALID = "authority_key_invalid"

#No usable ``account_epoch`` for this account, so nothing was signed.
#
#``KT.md`` §4.5.4 requires an issuer that cannot read the durable counter to
#**refuse**, and this code is what that refusal looks like on the wire. It is
#a distinct code rather than a reuse of one above because the deployment is
#fine and the key is fine: it is this account's counter that is unusable, and
#an operator alerting on it needs to look at a row, not at Secret Manager.
REASON_EPOCH_UNAVAILABLE = "account_epoch_unavailable"

REASON_CODES = (
    REASON_UNCONFIGURED,
    REASON_LOG_UNCONFIGURED,
    REASON_FETCH_FAILED,
    REASON_KEY_INVALID,
    REASON_EPOCH_UNAVAILABLE,
)

#Secret Manager v1. ``:access`` returns the payload of one version.
_SECRET_ACCESS_URL = "https://secretmanager.googleapis.com/v1/{name}:access"
_SECRET_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_SECRET_TIMEOUT_SECONDS = 5


class AuthorityUnavailable(Exception):
    """The issuing key or the log identity is not usable.

    Carries one of:data:`REASON_CODES` and nothing else. The underlying cause
    is logged server-side; it is never returned to the caller.
    """

    def __init__(self, reason: str):
        if reason not in REASON_CODES:
            raise ValueError(f"unknown reason code {reason!r}")
        super().__init__(reason)
        self.reason = reason


class Authority:
    """A loaded issuing key. Private key material stays inside this object."""

    __slots__ = ("_private_key", "public_key", "authority_id")

    def __init__(self, private_key: Ed25519PrivateKey):
        self._private_key = private_key
        self.public_key = private_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw
        )
        self.authority_id = authority_id(self.public_key)

    def sign(self, message: bytes) -> bytes:
        return self._private_key.sign(message)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Authority {b64u_encode(self.authority_id)}>"


#How long a failed load is remembered before the next request retries, in
#seconds.
#
#A remembered failure exists so an unconfigured or broken deployment does not
#make one outbound request per inbound request. It must NOT be permanent, and
#the reason is a rolling deployment: a Secret Manager or metadata-server blip
#lasting seconds, hit at boot, would otherwise latch ``503`` for the life of
#every pod that started during it. Startup probes still pass — this app never
#fails boot — so the healthy old pods are retired behind the broken new ones
#and enrollment stays down after Google recovers until somebody restarts the
#fleet by hand. One minute is short enough that a transient fault self-heals
#within a deploy and long enough that a genuinely misconfigured deployment
#makes at most one call a minute per process.
FAILURE_RETRY_SECONDS = 60

_lock = threading.Lock()
_authority = None
#``(reason, monotonic deadline)`` for the last failure, or ``None``.
_failure = None


def _secret_name() -> str:
    return getattr(settings, "KT_AUTHORITY_SECRET_NAME", "") or ""


def _fetch_secret_payload(name: str) -> bytes:
    """GET the Secret Manager version payload. Raises on any failure."""
    # Imported here, not at module scope: this module is imported by the
    # URLconf, and the deployed-image import guard runs that import with no
    # credentials and no network. Nothing about loading the module should need
    # either.
    import google.auth
    import requests
    from google.auth.transport.requests import Request as GoogleAuthRequest

    credentials, _ = google.auth.default(scopes=[_SECRET_SCOPE])
    credentials.refresh(GoogleAuthRequest())
    response = requests.get(
        _SECRET_ACCESS_URL.format(name=name),
        headers={"Authorization": f"Bearer {credentials.token}"},
        timeout=_SECRET_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()["payload"]["data"]
    return base64.b64decode(payload)


def _parse_seed(payload: bytes) -> Ed25519PrivateKey:
    """A secret payload is 32 raw bytes, or 64 hex characters.

    Hex is accepted because that is what ``f2z-assert keygen`` writes and what
    a human pastes into the Secret Manager console; raw bytes are accepted
    because that is what a scripted rotation is likely to store. Nothing else
    is, and a payload that is neither is a configuration error, not a key.

    **The raw case is checked first, and it is never stripped.** A seed is
    uniformly random, so about 4.6% of them begin or end with a byte that
    happens to be ASCII whitespace — ``1 - (250/256)**2`` — and stripping first
    would shorten those to 30 or 31 bytes and reject them as invalid. A rotation
    that stored a raw seed would then fail on roughly one key in twenty-two,
    with a green boot, green probes and a fleet stuck at 503 behind a key that
    is perfectly good. Whitespace is only meaningful around *text*, so it is
    only trimmed on the branch that is treating the payload as text. The two
    branches cannot collide: 32 hex characters would be a 16-byte seed, which is
    not a thing.
    """
    if len(payload) == 32:
        return Ed25519PrivateKey.from_private_bytes(payload)

    text = payload.strip()
    if len(text) == 64:
        try:
            seed = binascii.unhexlify(text)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("64-character payload is not hex") from exc
        return Ed25519PrivateKey.from_private_bytes(seed)

    raise ValueError("expected 32 raw bytes or 64 hex characters")


def _authority_from(payload: bytes) -> "Authority":
    """Parse a secret payload into an:class:`Authority`.

    A separate function so that key material never shares a lexical scope with
    a logging call. ``dj/apps/test_credential_logging_guard.py`` treats a
    ``logger.exception`` anywhere in a scope that holds a credential-named
    value as a finding — a deliberately blunt rule, and the right one: an
    exception's traceback carries local variables into the log formatter, so
    "the log call does not name the key" is not the property that matters.
    Nothing in this function logs, and nothing in the function that does log
    holds the key.
    """
    return Authority(_parse_seed(payload))


def prime() -> None:
    """Fetch the issuing key once, at boot. Never raises.

    Called from ``KtauthConfig.ready``. A failure here is recorded and turned
    into a 503 on this endpoint alone: an app registry that refuses to load
    because a secret is missing takes the whole site down, which is a global
    fail-closed and exactly the thing not to do.
    """
    try:
        load()
    except AuthorityUnavailable as exc:
        logger.warning(
            "kt authority unavailable at boot: %s", exc.reason, exc_info=False
        )
    except Exception:  # pragma: no cover - belt and braces around boot
        logger.exception("kt authority priming raised unexpectedly")


def _remember(reason: str) -> AuthorityUnavailable:
    """Record a failure for:data:`FAILURE_RETRY_SECONDS` and build the error."""
    global _failure
    _failure = (reason, time.monotonic() + FAILURE_RETRY_SECONDS)
    return AuthorityUnavailable(reason)


def _remembered_failure() -> "str | None":
    """The remembered reason, if it has not expired yet."""
    global _failure
    if _failure is None:
        return None
    reason, deadline = _failure
    if time.monotonic() >= deadline:
        _failure = None
        return None
    return reason


def load() -> Authority:
    """Return the in-memory issuing key, fetching it on first use.

    Raises:class:`AuthorityUnavailable`. A failure is remembered for
    :data:`FAILURE_RETRY_SECONDS` so a broken deployment does not make one
    outbound request per inbound request, and then retried so a transient one
    heals without a restart;:func:`reset` clears it immediately.
    """
    global _authority

    if _authority is not None:
        return _authority

    with _lock:
        if _authority is not None:
            return _authority
        remembered = _remembered_failure()
        if remembered is not None:
            raise AuthorityUnavailable(remembered)

        name = _secret_name()
        if not name:
            raise _remember(REASON_UNCONFIGURED)

        try:
            payload = _fetch_secret_payload(name)
        except Exception:
            # The cause is logged, never returned: it can carry a project id, a
            # secret resource name or a Google error body.
            logger.exception("kt authority key fetch failed")
            raise _remember(REASON_FETCH_FAILED) from None

        try:
            authority = _authority_from(payload)
        except Exception:
            logger.exception("kt authority key payload is not an Ed25519 seed")
            raise _remember(REASON_KEY_INVALID) from None
        finally:
            del payload

        _authority = authority
        logger.info(
            "kt authority loaded, authority_id=%s",
            b64u_encode(authority.authority_id),
        )
        return authority


def peek() -> Authority:
    """The loaded issuing key, **without ever fetching it**.

    For the anonymous ``GET /api/e2ee/authority/``: a public request must not
    be able to start (or queue behind) a Secret Manager round trip. When no
    key is in memory this raises with the remembered failure if there is one,
    ``authority_unconfigured`` if this process is not an authority, and
    ``authority_key_unavailable`` otherwise; the next assertion request, or
    the boot-time:func:`prime`, is what loads it.
    """
    authority = _authority
    if authority is not None:
        return authority
    remembered = _remembered_failure()
    if remembered is not None:
        raise AuthorityUnavailable(remembered)
    if not _secret_name():
        raise AuthorityUnavailable(REASON_UNCONFIGURED)
    raise AuthorityUnavailable(REASON_FETCH_FAILED)


def install(private_key: Ed25519PrivateKey) -> Authority:
    """Install an issuing key directly, bypassing Secret Manager.

    For tests and for the conformance harness. Production reaches the key only
    through:func:`load`.
    """
    global _authority, _failure
    with _lock:
        _authority = Authority(private_key)
        _failure = None
        return _authority


def reset() -> None:
    """Forget the loaded key and any remembered failure."""
    global _authority, _failure
    with _lock:
        _authority = None
        _failure = None


def log_id() -> bytes:
    """The 32-byte ``log_id`` this authority issues for (``KT.md`` §6.1).

    An assertion naming a different log says nothing about the handle on this
    one, so a deployment with no configured log id cannot issue at all — it
    would be signing a claim about a log that does not exist.
    """
    configured = getattr(settings, "KT_LOG_ID_HEX", "") or ""
    try:
        raw = binascii.unhexlify(configured.strip())
    except (binascii.Error, ValueError):
        raise AuthorityUnavailable(REASON_LOG_UNCONFIGURED) from None
    if len(raw) != 32:
        raise AuthorityUnavailable(REASON_LOG_UNCONFIGURED)
    return raw


def ttl_ms() -> int:
    """The validity window to issue, clamped to the verifier's own cap.

    Clamped rather than rejected: a deployment that asks for a longer window
    than every log will accept should still mint usable assertions, and the cap
    is the log's to enforce regardless of what we sign.
    """
    configured = getattr(settings, "KT_ASSERTION_TTL_MS", DEFAULT_TTL_MS)
    try:
        value = int(configured)
    except (TypeError, ValueError):
        value = DEFAULT_TTL_MS
    if value <= 0:
        value = DEFAULT_TTL_MS
    return min(value, MAX_VALIDITY_MS)


def preflight() -> None:
    """Raise:class:`AuthorityUnavailable` unless this deployment can issue.

    Exists so the view can answer 503 **before** it touches the database. The
    ordering matters twice over. Today no manifest configures an authority, so
    the endpoint is inert — and an inert endpoint should not be reading (or,
    once per account, writing) the messaging-handle table per request. And
    when it is configured, refusing on the cheap check first is the same shape
    the Rust verifier uses for the same reason: cheap and flood-resistant
    first, expensive last.
    """
    load()
    log_id()


def issue(
    *,
    handle: bytes,
    identity_pk: bytes,
    intent: int,
    account_epoch: int,
    now_ms: "int | None" = None,
    nonce: "bytes | None" = None,
) -> dict:
    """Mint one signed assertion.

    Returns ``{"assertion": bytes, "issued_ms": int, "expires_ms": int}`` where
    ``assertion`` is ``tls_codec(HandleAssertion)`` — the TBS bytes followed by
    the 64-byte Ed25519 signature over them.

    ``account_epoch`` is the authority's **durable counter** for the account
    behind the handle (``KT.md`` §4.5.4). It is a required argument, and the
    only supplier is:func:`dj.apps.ktauth.epoch.account_epoch_for`, which reads
    the column and refuses when it cannot. There is no default and no fallback,
    which is the point.

    Why it is required rather than defaulted
    ------------------------------------------------

    It used to default to ``now_ms // 1000``, and this docstring used to argue
    that the two ways a clock under-delivers — two issuances inside one second
    colliding, and a backwards clock correction — were "refusals, never
    acceptances", so the placeholder was harmless.

    **That argument was wrong, and a confident comment justifying a bug is
    harder to find than the bug.** It enumerated the cases where a clock
    produces a value that is *not larger* and stopped there. The case A15 exists
    for is the opposite one: two assertions minted for a **single** ownership
    event, more than a second apart, carry two distinct increasing epochs, and
    the log admits **both**. That is an acceptance, and it is precisely the
    replay the rule is meant to prevent — a monotonic clock satisfies a
    monotonicity check unconditionally and forever, so A15 ran on every
    submission, always passed, and enforced nothing.

    ``tests/test_account_epoch.py`` pins that case directly. The log now also
    refuses a clock on its face (A18, free2z/zuu#651) and so does
    :func:`encode_assertion_tbs`.
    """
    authority = load()
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    expires_ms = now_ms + ttl_ms()
    tbs = encode_assertion_tbs(
        authority_pk=authority.public_key,
        log_id=log_id(),
        handle=handle,
        identity_pk=identity_pk,
        intent=intent,
        account_epoch=account_epoch,
        issued_ms=now_ms,
        expires_ms=expires_ms,
        nonce=secrets.token_bytes(16) if nonce is None else nonce,
    )
    return {
        "assertion": tbs + authority.sign(tbs),
        "issued_ms": now_ms,
        "expires_ms": expires_ms,
    }
