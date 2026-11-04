"""Fixtures shared by the ktauth tests.

The issuing key is installed directly rather than fetched: no test in this
package may reach GCP, and ``signing.install`` is the seam that guarantees it.
The seed is a fixed 32 bytes so the conformance vectors in
``test_conformance_vectors.py`` are reproducible byte-for-byte.
"""

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.urls import reverse

from dj.apps.ktauth import signing

#: The issuing key every test in this package signs with.
AUTHORITY_SEED = bytes(range(32))

#: A fixed log id, so an assertion built here is comparable across runs.
LOG_ID = bytes([0x9A] * 32)
LOG_ID_HEX = LOG_ID.hex()

#: A valid Ed25519 public key to be vouched for. Derived from a seed rather
#: than made up, because ``check_identity_key`` decodes it.
IDENTITY_SEED = bytes([0x42] * 32)


def identity_public_bytes() -> bytes:
    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        PublicFormat,
    )

    return (
        Ed25519PrivateKey.from_private_bytes(IDENTITY_SEED)
        .public_key()
        .public_bytes(Encoding.Raw, PublicFormat.Raw)
    )


@pytest.fixture
def authority():
    """An installed issuing key, removed again afterwards."""
    installed = signing.install(
        Ed25519PrivateKey.from_private_bytes(AUTHORITY_SEED)
    )
    yield installed
    signing.reset()


@pytest.fixture
def no_authority():
    """No issuing key at all, and no remembered failure to short-circuit it."""
    signing.reset()
    yield
    signing.reset()


@pytest.fixture
def kt_settings(settings):
    settings.KT_LOG_ID_HEX = LOG_ID_HEX
    settings.KT_ASSERTION_TTL_MS = signing.DEFAULT_TTL_MS
    return settings


@pytest.fixture
def url():
    return reverse('kt_handle_assertion')


@pytest.fixture
def identity_key_b64():
    return signing.b64u_encode(identity_public_bytes())
