"""Each deployment signs for the log deployed beside it.

A wrong ``log_id`` is refused by the log as ``WrongLog`` while every health
check stays green, so the per-namespace mapping and its path into the signed
bytes are both pinned.
"""

import pytest

from dj.apps.ktauth import signing
from dj.free2z.kt_logs import KT_LOG_IDS_BY_NAMESPACE, resolve_kt_log_id_hex

from .conftest import identity_public_bytes

#: docs/k8s/f2z-servers.md §1.7 (free2z/zuu#1022 workstream 9).
EXPECTED = {
    "prod": "05b5dc5aa07ecae55442b8b32b6b8bebcc6490031112caa30adefa84070dc7e9",
    "stage": "5d84130eb8004c1ee642ca0e0accb53e2a17b721febea68ac60de9b43c134f61",
    "test": "3d8fbbad4948f525a9036206463407cc9f80da21b5e7bb7d5746afdf5d9e665a",
}


def test_every_deployed_namespace_has_its_own_log():
    assert KT_LOG_IDS_BY_NAMESPACE == EXPECTED
    assert len(set(EXPECTED.values())) == 3


@pytest.mark.parametrize(
    ("namespace", "override", "expected"),
    [
        ("prod", "", EXPECTED["prod"]),
        ("stage", "", EXPECTED["stage"]),
        ("test", "", EXPECTED["test"]),
        ("stage", "ab" * 32, "ab" * 32),
        (None, "", ""),
        ("", "", ""),
        ("dev", "", ""),
    ],
)
def test_the_log_id_resolves_per_namespace(namespace, override, expected):
    assert resolve_kt_log_id_hex(namespace, override) == expected


@pytest.mark.parametrize("namespace", sorted(EXPECTED))
def test_an_assertion_carries_the_namespaces_log_id(namespace, authority, settings):
    settings.KT_LOG_ID_HEX = resolve_kt_log_id_hex(namespace, "")
    raw = signing.issue(
        handle=b"alice",
        identity_pk=identity_public_bytes(),
        intent=signing.INTENT_BIND,
        account_epoch=1,
    )["assertion"]
    offset = 1 + len(signing.LABEL_ASSERTION_TBS) + 32
    assert raw[offset:offset + 32].hex() == EXPECTED[namespace]
