"""Loading the issuing key, and every way it can fail.

The failure behaviour is the interesting half. A key that will not load must
produce a 503 on one endpoint with a bounded reason code, and must not: fail
boot, leak the resource name or the key store's error text to a caller, or make
one outbound request per inbound request.
"""

import base64
import time

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from dj.apps.ktauth import signing

SEED = bytes([0x11] * 32)


@pytest.fixture(autouse=True)
def _clean():
    signing.reset()
    yield
    signing.reset()


def _payload(raw):
    return {"payload": {"data": base64.b64encode(raw).decode()}}


class _Response:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self._body


@pytest.fixture
def secret_manager(mocker, settings):
    """Stand in for GCP. No test in this package may reach the network."""
    settings.KT_AUTHORITY_SECRET_NAME = (
        "projects/p/secrets/kt-authority/versions/latest"
    )
    credentials = mocker.Mock(token="a-token")
    mocker.patch(
        "google.auth.default", return_value=(credentials, "p")
    )
    return mocker.patch(
        "requests.get", return_value=_Response(_payload(SEED))
    )


# --------------------------------------------------------------- the good path


def test_a_raw_32_byte_payload_is_the_seed(secret_manager):
    authority = signing.load()
    expected = Ed25519PrivateKey.from_private_bytes(SEED)
    assert authority.public_key == signing.Authority(expected).public_key


def test_a_64_character_hex_payload_is_also_accepted(secret_manager, mocker):
    """``f2z-assert keygen`` writes hex, and so does a human in the console."""
    secret_manager.return_value = _Response(_payload(SEED.hex().encode()))
    assert signing.load().public_key == signing.Authority(
        Ed25519PrivateKey.from_private_bytes(SEED)
    ).public_key


def test_surrounding_whitespace_in_a_hex_payload_is_ignored(secret_manager):
    secret_manager.return_value = _Response(
        _payload(b"  " + SEED.hex().encode() + b"\n")
    )
    assert signing.load() is not None


@pytest.mark.parametrize(
    "seed",
    [
        b"\x20" + bytes([0x11] * 31),   # leading space
        bytes([0x11] * 31) + b"\n",     # trailing newline
        b"\t" + bytes([0x11] * 30) + b"\r",
        bytes([0x20] * 32),             # every byte is a space
    ],
)
def test_a_raw_seed_containing_whitespace_bytes_is_not_trimmed(
    secret_manager, seed
):
    """A seed is random bytes, and about 4.6% of them start or end with one
    that is ASCII whitespace.

    Stripping before the length check would shorten those to 30 or 31 bytes and
    reject them as invalid keys -- so a rotation storing a raw seed would fail
    on roughly one key in twenty-two, with a green boot, green probes, and a
    fleet stuck at 503 behind a key that is perfectly good.
    """
    assert len(seed) == 32
    secret_manager.return_value = _Response(_payload(seed))
    authority = signing.load()
    assert authority.public_key == signing.Authority(
        Ed25519PrivateKey.from_private_bytes(seed)
    ).public_key


def test_the_key_is_fetched_once_and_then_held_in_memory(secret_manager):
    first = signing.load()
    second = signing.load()
    assert first is second
    assert secret_manager.call_count == 1


def test_the_authority_id_is_derived_from_the_key_it_loaded(secret_manager):
    authority = signing.load()
    assert authority.authority_id == signing.authority_id(authority.public_key)


def test_the_secret_is_read_from_the_configured_resource_name(secret_manager,
                                                              settings):
    signing.load()
    url = secret_manager.call_args.args[0]
    assert url.endswith(f"{settings.KT_AUTHORITY_SECRET_NAME}:access")
    assert url.startswith("https://secretmanager.googleapis.com/v1/")
    assert secret_manager.call_args.kwargs["timeout"] > 0
    assert secret_manager.call_args.kwargs["headers"]["Authorization"] == (
        "Bearer a-token"
    )


# ------------------------------------------------------------------- the fails


def test_an_unconfigured_deployment_never_calls_out(settings, mocker):
    settings.KT_AUTHORITY_SECRET_NAME = ""
    outbound = mocker.patch("requests.get")
    with pytest.raises(signing.AuthorityUnavailable) as excinfo:
        signing.load()
    assert excinfo.value.reason == signing.REASON_UNCONFIGURED
    outbound.assert_not_called()


def test_a_fetch_failure_is_one_bounded_reason_code(secret_manager):
    secret_manager.side_effect = RuntimeError(
        "project free2z secret kt-authority: PERMISSION_DENIED"
    )
    with pytest.raises(signing.AuthorityUnavailable) as excinfo:
        signing.load()
    assert excinfo.value.reason == signing.REASON_FETCH_FAILED
    # The cause is logged, never carried on the exception a caller sees.
    assert "PERMISSION_DENIED" not in str(excinfo.value)
    assert "free2z" not in str(excinfo.value)


@pytest.mark.parametrize(
    "payload", [b"", b"\x00" * 31, b"\x00" * 33, b"z" * 64, b"not a key"]
)
def test_a_payload_that_is_not_a_seed_is_refused(secret_manager, payload):
    secret_manager.return_value = _Response(_payload(payload))
    with pytest.raises(signing.AuthorityUnavailable) as excinfo:
        signing.load()
    assert excinfo.value.reason == signing.REASON_KEY_INVALID


def test_a_failure_is_remembered_rather_than_retried_per_request(
    secret_manager,
):
    secret_manager.side_effect = RuntimeError("down")
    for _ in range(5):
        with pytest.raises(signing.AuthorityUnavailable):
            signing.load()
    assert secret_manager.call_count == 1

    signing.reset()
    with pytest.raises(signing.AuthorityUnavailable):
        signing.load()
    assert secret_manager.call_count == 2


def test_a_transient_failure_heals_without_a_restart(secret_manager):
    """The remembered failure expires, and it must.

    A Secret Manager blip lasting seconds, hit during a rolling deployment,
    would otherwise latch 503 for the life of every pod that started inside it
    — boot succeeds either way, so the healthy old pods are retired behind the
    broken new ones and enrollment stays down after Google has recovered.
    """
    secret_manager.side_effect = RuntimeError("a blip")
    with pytest.raises(signing.AuthorityUnavailable):
        signing.load()

    # Still inside the retry window: no second call.
    with pytest.raises(signing.AuthorityUnavailable):
        signing.load()
    assert secret_manager.call_count == 1

    # Age the remembered failure out rather than patching ``time.monotonic``,
    # which is global and would be patched under pytest's own feet.
    reason, _deadline = signing._failure
    signing._failure = (reason, time.monotonic() - 1)

    secret_manager.side_effect = None
    assert signing.load() is not None
    assert secret_manager.call_count == 2


def test_the_retry_window_is_short_enough_to_clear_a_deploy():
    assert 0 < signing.FAILURE_RETRY_SECONDS <= 300


def test_every_reason_code_is_enumerated():
    """The 503 body's ``reason`` is a closed set, checked against the
    serializer's declared choices so the two cannot drift apart."""
    from dj.apps.ktauth.serializers import AuthorityUnavailableSerializer

    declared = AuthorityUnavailableSerializer().fields["reason"].choices
    assert set(declared) == set(signing.REASON_CODES)

    with pytest.raises(ValueError):
        signing.AuthorityUnavailable("something_else")


# ---------------------------------------------------------------------- boot


def test_priming_never_raises(settings, mocker):
    """``AppConfig.ready`` calling this must not be able to stop a pod."""
    settings.KT_AUTHORITY_SECRET_NAME = "projects/p/secrets/s/versions/1"
    mocker.patch(
        "google.auth.default", side_effect=RuntimeError("no credentials")
    )
    signing.prime()  # must not raise

    settings.KT_AUTHORITY_SECRET_NAME = ""
    signing.reset()
    signing.prime()


def test_priming_leaves_the_key_ready_for_the_first_request(secret_manager):
    signing.prime()
    assert secret_manager.call_count == 1
    signing.load()
    assert secret_manager.call_count == 1


# ------------------------------------------------------------------- hygiene


def test_the_private_key_is_not_in_the_repr(secret_manager):
    authority = signing.load()
    text = repr(authority)
    assert SEED.hex() not in text
    assert base64.b64encode(SEED).decode() not in text
    assert not hasattr(authority, "__dict__"), (
        "Authority uses __slots__ so the private key cannot be picked up by "
        "generic attribute dumping"
    )


def test_a_signature_is_over_the_message_and_nothing_else(secret_manager):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PublicKey,
    )

    authority = signing.load()
    signature = authority.sign(b"the message")
    public = Ed25519PublicKey.from_public_bytes(authority.public_key)
    public.verify(signature, b"the message")
    with pytest.raises(Exception):
        public.verify(signature, b"the messagf")
