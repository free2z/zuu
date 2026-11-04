"""Authoritative, atomic admission for public Zcash authentication.

These direct wallet endpoints have a narrower and better-defined proxy path
than the site's SSR traffic.  Google Cloud's external Application Load
Balancer appends exactly ``<client-ip>,<load-balancer-ip>`` to any supplied
``X-Forwarded-For`` value, and the four exact nginx locations forward that
header unchanged while overwriting a private peer header with their original
TCP source. Django accepts the suffix only when it is reached from the loopback
sidecar and nginx's captured peer is in Google's documented GFE request ranges
for the repository's zonal NEG backend.  The second XFF element from the right
is then the client identity; every preceding element is attacker-controlled
and ignored. This endpoint-local rule deliberately does not change DRF's
global proxy handling. Ordinary API locations use the normalized one-hop XFF
contract; these endpoints intentionally keep their suffix parser.

Challenge issuance first atomically charges a hashed client counter and forces
bounded parsing. Lazy authentication runs next. Only an authenticated or
anonymous request which parses to a checksum-valid address can then charge the
separate hashed address counter. This ordering makes malformed inputs and
invalid inherited credentials spend the fixed client budget without allocating
address-specific state. One source can therefore create at most its own client
allowance of address keys per fixed window. There is intentionally no global
bucket: a freely callable global ceiling is a sustained authentication kill
switch.

Login has a separate client-only bucket.  It runs before bounded body parsing,
authentication, database replay claiming, and secp256k1 recovery, bounding a
burst of accumulated live proofs without letting challenge traffic spend the
login budget (or vice versa). Once charged, it forces the endpoint parser
before lazy authentication so malformed credentials cannot bypass the body
cap. All attacker-influenced key material is SHA-256
hashed. Before hashing, native IPv4 remains host-specific, IPv4-mapped IPv6
folds into the same IPv4 identity, and native IPv6 is normalized to its /64
network so privacy-address rotation cannot buy a fresh bucket. Typed identity
prefixes prevent cross-family collisions. The deployment namespace is hashed
separately to preserve fixed key size without changing django-redis's
established global namespace.
"""

import hashlib
import ipaddress
import logging
import math
import threading
import time

from django.conf import settings
from django.core.cache import cache, caches
from django.core.cache.backends.dummy import DummyCache
from django.core.cache.backends.locmem import LocMemCache
from rest_framework.exceptions import APIException
from rest_framework.throttling import BaseThrottle

from .validation import is_valid_zcash_login_address


logger = logging.getLogger(__name__)
CHALLENGE_KEY_PREFIX = "zcashissue:"
LOGIN_KEY_PREFIX = "zcashlogin:"
ZCASH_XFF_MAX_CHARS = 1024
ZCASH_XFF_MAX_ELEMENTS = 16
_IP_LITERAL_MAX_CHARS = 45
_LOCAL_ADMISSION_LOCK = threading.Lock()
# GCE Ingress in this repository uses zonal GCE_VM_IP_PORT NEGs. Google
# documents these as the request-source networks for the GFE proxy connecting
# to that backend type. Keep the request IPv6 range distinct from the health-
# check-only 2600:2d00:1:b029::/64 range.
# https://cloud.google.com/load-balancing/docs/firewall-rules
_GCLB_GFE_REQUEST_NETWORKS = tuple(
    ipaddress.ip_network(value)
    for value in (
        "35.191.0.0/16",
        "130.211.0.0/22",
        "2600:2d00:1:1::/64",
    )
)


class ChallengeAdmissionUnavailable(APIException):
    status_code = 503
    default_detail = "Challenge service is temporarily unavailable."
    default_code = "challenge_service_unavailable"


class LoginAdmissionUnavailable(APIException):
    status_code = 503
    default_detail = "Zcash login service is temporarily unavailable."
    default_code = "zcash_login_service_unavailable"


class ZcashClientIdentityUnavailable(APIException):
    status_code = 503
    default_detail = "Zcash authentication service is temporarily unavailable."
    default_code = "zcash_client_identity_unavailable"


def _parse_ip(
    value: object,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if not isinstance(value, str):
        raise ZcashClientIdentityUnavailable
    candidate = value.strip()
    if not candidate or len(candidate) > _IP_LITERAL_MAX_CHARS:
        raise ZcashClientIdentityUnavailable
    try:
        parsed = ipaddress.ip_address(candidate)
    except ValueError as exc:
        raise ZcashClientIdentityUnavailable from exc
    # Link-local zone identifiers are meaningful only on one machine and are
    # not valid GCLB client/load-balancer identities.
    if getattr(parsed, "scope_id", None) is not None:
        raise ZcashClientIdentityUnavailable
    return parsed


def _client_admission_identity(value: object) -> str:
    """Return typed, stable admission identity for one validated client IP."""
    parsed = _parse_ip(value)
    if isinstance(parsed, ipaddress.IPv4Address):
        return f"ipv4:{parsed}"

    mapped = parsed.ipv4_mapped
    if mapped is not None:
        return f"ipv4:{mapped}"

    network = ipaddress.ip_network((parsed, 64), strict=False)
    return f"ipv6-prefix:{network.with_prefixlen}"


def zcash_client_identity(request) -> str:
    """Return the normalized client identity for the direct GCLB wallet path.

    Google documents the suffix contract at
    https://cloud.google.com/load-balancing/docs/https#x-forwarded-for_header.
    Bound the raw header before splitting or parsing it, prove the nginx/GFE
    hop, validate both suffix elements, and ignore all attacker-supplied prefix
    elements. The validated client IP is then normalized using the same typed
    IPv4-host/native-IPv6-/64 policy as local development. A missing or
    malformed production topology fails closed instead of merging unrelated
    clients into a shared fallback key.
    """
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded_for is not None:
        if (
            not isinstance(forwarded_for, str)
            or not forwarded_for
            or len(forwarded_for) > ZCASH_XFF_MAX_CHARS
            or forwarded_for.count(",") + 1 > ZCASH_XFF_MAX_ELEMENTS
        ):
            raise ZcashClientIdentityUnavailable
        elements = forwarded_for.split(",")
        if len(elements) < 2:
            raise ZcashClientIdentityUnavailable

        # Header syntax cannot prove the final network hop. The four exact
        # nginx locations overwrite X-Free2Z-Proxy-Peer with their original
        # socket peer via $realip_remote_addr.
        # Django must itself be reached from the loopback sidecar and that
        # captured edge peer must be a documented GFE request source. This
        # closes direct pod-port and ClusterIP calls even when they forge both
        # headers. Ordinary API locations use nginx's normalized one-hop XFF
        # with DRF's ``NUM_PROXIES=1``; this endpoint keeps its suffix parser
        # because its admission contract is intentionally stricter.
        django_peer = _parse_ip(request.META.get("REMOTE_ADDR"))
        if not django_peer.is_loopback:
            raise ZcashClientIdentityUnavailable
        proxy_peer = _parse_ip(request.META.get("HTTP_X_FREE2Z_PROXY_PEER"))
        if not any(
            proxy_peer.version == network.version and proxy_peer in network
            for network in _GCLB_GFE_REQUEST_NETWORKS
        ):
            raise ZcashClientIdentityUnavailable

        client_identity = _client_admission_identity(elements[-2])
        # Validating the final GCLB-added element closes on a truncated or
        # otherwise unexpected suffix rather than accepting a forged tail.
        _parse_ip(elements[-1])
        return client_identity

    # Unit tests and explicit local development do not run behind GCLB.  This
    # opt-in is disabled by production settings; malformed XFF never falls
    # through to REMOTE_ADDR even when the local fallback is enabled.
    if getattr(settings, "ZCASH_AUTH_ALLOW_REMOTE_ADDR_FALLBACK", False):
        return _client_admission_identity(request.META.get("REMOTE_ADDR"))
    raise ZcashClientIdentityUnavailable


_SINGLE_BUCKET_ADMISSION_SCRIPT = """
local now = tonumber(redis.call('TIME')[1])
local window = tonumber(ARGV[1])
local window_end = now - (now % window) + window
local count = redis.call('GET', KEYS[1])
if count and tonumber(count) >= tonumber(ARGV[2]) then
  return {0, window_end - now}
end
count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIREAT', KEYS[1], window_end)
end
return {count <= tonumber(ARGV[2]) and 1 or 0, window_end - now}
"""


def _configured_limits(setting_name: str, names: tuple[str, ...], exc_type):
    configured = getattr(settings, setting_name, None)
    try:
        values = tuple(int(configured[name]) for name in names)
    except (KeyError, TypeError, ValueError) as exc:
        raise exc_type from exc
    if any(value <= 0 for value in values):
        raise exc_type
    return values


def _challenge_limits() -> tuple[int, int, int]:
    return _configured_limits(
        "ZCASH_CHALLENGE_ADMISSION_LIMITS",
        ("window_seconds", "client", "address"),
        ChallengeAdmissionUnavailable,
    )


def _login_limits() -> tuple[int, int]:
    return _configured_limits(
        "ZCASH_LOGIN_ADMISSION_LIMITS",
        ("window_seconds", "client"),
        LoginAdmissionUnavailable,
    )


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).hexdigest()


def _namespace_digest(exc_type) -> str:
    """Hash the operator-controlled deployment namespace to a fixed size."""
    namespace = getattr(settings, "ZCASH_AUTH_ADMISSION_NAMESPACE", None)
    if not isinstance(namespace, str) or not namespace:
        raise exc_type
    return _digest(namespace)


def challenge_admission_keys(client_identity: str, address: str) -> tuple[str, str]:
    """Return fixed-shape client/address issuance keys (never a global key)."""
    return (
        challenge_client_admission_key(client_identity),
        challenge_address_admission_key(address),
    )


def challenge_client_admission_key(client_identity: str) -> str:
    """Return the fixed-shape issuance key for one authoritative client."""
    namespace = _namespace_digest(ChallengeAdmissionUnavailable)
    prefix = f"{CHALLENGE_KEY_PREFIX}{namespace}:"
    return f"{prefix}client:{_digest(client_identity)}"


def challenge_address_admission_key(address: str) -> str:
    """Return the fixed-shape issuance key for one validated address."""
    namespace = _namespace_digest(ChallengeAdmissionUnavailable)
    prefix = f"{CHALLENGE_KEY_PREFIX}{namespace}:"
    return f"{prefix}address:{_digest(address)}"


def login_admission_key(client_identity: str) -> str:
    """Return the independent fixed-shape login-verification counter key."""
    prefix = f"{LOGIN_KEY_PREFIX}{_namespace_digest(LoginAdmissionUnavailable)}:"
    return f"{prefix}client:{_digest(client_identity)}"


def _fixed_window_retry(window_seconds: int) -> int:
    now = int(time.time())
    return max(1, window_seconds - (now % window_seconds))


def _local_increment(key: str, retry_seconds: int) -> int:
    if cache.add(key, 1, timeout=retry_seconds):
        return 1
    try:
        return int(cache.incr(key))
    except ValueError:
        # The fixed window can expire between add() and incr().  Recreate the
        # new window without extending an existing key.
        if cache.add(key, 1, timeout=retry_seconds):
            return 1
        return int(cache.incr(key))


def _local_backend(exc_type):
    backend = caches["default"]
    if not isinstance(backend, (LocMemCache, DummyCache)):
        return None
    if not getattr(settings, "ZCASH_CHALLENGE_ALLOW_LOCAL_CACHE", False) or isinstance(
        backend, DummyCache
    ):
        raise exc_type
    return backend


def _admit_single_bucket(
    key: str,
    *,
    window: int,
    limit: int,
    exc_type,
    failure_label: str,
) -> tuple[bool, int]:
    """Atomically charge one fixed-window logical cache key."""
    backend = caches["default"]

    if _local_backend(exc_type) is not None:
        retry_seconds = _fixed_window_retry(window)
        try:
            with _LOCAL_ADMISSION_LOCK:
                if int(cache.get(key, 0)) >= limit:
                    return False, retry_seconds
                _local_increment(key, retry_seconds)
        except Exception as exc:
            logger.exception("Zcash local %s admission failed", failure_label)
            raise exc_type from exc
        return True, retry_seconds

    try:
        redis_client = backend.client.get_client(write=True)
        result = redis_client.eval(
            _SINGLE_BUCKET_ADMISSION_SCRIPT,
            1,
            backend.make_key(key),
            window,
            limit,
        )
        allowed, retry_seconds = int(result[0]), int(result[1])
    except Exception as exc:
        logger.exception("Zcash shared %s admission failed", failure_label)
        raise exc_type from exc
    return allowed == 1, max(1, retry_seconds)


def admit_challenge(client_identity: str) -> tuple[bool, int]:
    """Atomically charge issuance admission for one authoritative client."""
    window, client_limit, _address_limit = _challenge_limits()
    return _admit_single_bucket(
        challenge_client_admission_key(client_identity),
        window=window,
        limit=client_limit,
        exc_type=ChallengeAdmissionUnavailable,
        failure_label="challenge-client",
    )


def admit_challenge_address(address: str) -> tuple[bool, int]:
    """Atomically charge issuance admission for one validated address."""
    window, _client_limit, address_limit = _challenge_limits()
    return _admit_single_bucket(
        challenge_address_admission_key(address),
        window=window,
        limit=address_limit,
        exc_type=ChallengeAdmissionUnavailable,
        failure_label="challenge-address",
    )


def admit_login(client_identity: str) -> tuple[bool, int]:
    """Atomically charge the independent pre-verification login bucket."""
    window, client_limit = _login_limits()
    return _admit_single_bucket(
        login_admission_key(client_identity),
        window=window,
        limit=client_limit,
        exc_type=LoginAdmissionUnavailable,
        failure_label="login-client",
    )


class _RetryAfterThrottle(BaseThrottle):
    def wait(self):
        return math.ceil(getattr(self, "_retry_seconds", 1))


class ZcashChallengeAdmissionThrottle(_RetryAfterThrottle):
    """Charge the fixed client key and force bounded parsing before auth."""

    def allow_request(self, request, view):
        client_identity = zcash_client_identity(request)
        allowed, retry_seconds = admit_challenge(client_identity)
        self._retry_seconds = retry_seconds
        if not allowed:
            return False

        # Accessing request.data invokes the endpoint's bounded parser.  The
        # independent client charge deliberately happens first, so malformed,
        # oversized, and unsupported-media requests cannot bypass it.
        _ = request.data

        return True


class ZcashChallengeAddressAdmissionThrottle(_RetryAfterThrottle):
    """Charge a validated address only after lazy authentication succeeds."""

    def allow_request(self, request, view):
        data = request.data
        address = data.get("address") if hasattr(data, "get") else None
        # Serializer validation owns the 400 response. Invalid input spends
        # only the fixed client key and must never allocate an address key.
        if not is_valid_zcash_login_address(address):
            return True

        allowed, retry_seconds = admit_challenge_address(address)
        self._retry_seconds = retry_seconds
        return allowed


class ZcashLoginAdmissionThrottle(_RetryAfterThrottle):
    """Charge the client, then enforce bounded parsing before auth/DB work."""

    def allow_request(self, request, view):
        client_identity = zcash_client_identity(request)
        allowed, retry_seconds = admit_login(client_identity)
        self._retry_seconds = retry_seconds
        if not allowed:
            return False

        # Force the endpoint-local bounded parser after the fixed-size client
        # charge but before lazy authentication. Malformed credentials cannot
        # therefore bypass the request body ceiling.
        _ = request.data
        return allowed
