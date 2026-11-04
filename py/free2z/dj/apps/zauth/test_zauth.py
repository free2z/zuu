"""
Tests for "Login with Zcash" ("ZUULI Zcash Login v1").

Run against real Postgres (see conftest):

    cd py/free2z && python -m pytest dj/apps/zauth/ -x

Covers:
  - challenge -> login happy path (verifymessage mocked True)
  - REAL in-process verification against a genuine wallet-plugin signature
    (no mock, no node) -- both the unit check and the full view path
  - a bogus signature is rejected with 401
  - Creator + ZcashIdentity creation, then reuse on a second login
  - single-use / expired / mismatched challenge rejection
  - associate flow: linking an address to an already-authenticated Creator

NOTE: pytest.ini sets ``python_files = test_*.py`` so this file (not the
conventional ``tests.py``) is what actually gets collected.
"""
import pytest

from knox.models import AuthToken

from dj.apps.g12f.models import Creator
from dj.apps.zauth.models import ZcashIdentity
from dj.apps.zauth.views import username_for_address


# Checksum-valid mainnet P2PKH fixture. The old t1Kx... value was only
# address-shaped and strict challenge admission correctly rejects its checksum.
TADDR = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"

# A REAL "ZUULI Zcash Login v1" signature produced by the wallet plugin's Rust
# `sign_challenge` (tauri-plugin-zcash) for a fixed test seed. Pinned here so the
# backend's in-process verification is exercised against the *actual* bytes the
# client emits -- the cross-language interface that a node-only, mocked test
# could never catch. (Regenerate via the plugin's
# `sign_challenge_recovers_pubkey_and_address` test if the scheme ever changes.)
VECTOR_ADDRESS = "t1f3vC5hEbAwJdheoFbwaBYssj2Hwp3MFXX"
VECTOR_PUBKEY = (
    "026e8698de2c0d8eeedf93db25c808f271a5a9bf95191d2697fef4593281f815b1"
)
VECTOR_SIGNATURE = (
    "IP5b5GpnexctRgyoCK9DH/PVCEUpU1InZOOBEiao65wUHzgc2/"
    "Q9/xZGUeLlu+5AACX1QGd/TCbbeqB3ZefwZOU="
)
VECTOR_CHALLENGE = "ZUULI login challenge: 2026-07-18T00:00:00Z nonce=deadbeef"


def _get_challenge(api_client, address=TADDR):
    resp = api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": address},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    challenge = resp.data["challenge"]
    assert challenge.startswith("ZUULI-Login:")
    return challenge


@pytest.mark.django_db
def test_generated_username_avoids_case_insensitive_collision():
    base = username_for_address(TADDR)
    Creator.objects.create(username=base.upper())

    assert username_for_address(TADDR) == base + "1"


@pytest.mark.django_db
def test_login_creates_creator_and_identity_with_mocked_verify(api_client, mocker):
    """verifymessage mocked True: full node path without a real node."""
    mock_verify = mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True,
    )

    challenge = _get_challenge(api_client)

    resp = api_client.post(
        "/api/auth/zcash/login/",
        {
            "address": TADDR,
            "challenge": challenge,
            "signature": "IHVsaWduYXR1cmU=",  # opaque; verify is mocked
            "pubkey": "02abcdef",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content

    body = resp.data
    assert body["token"]
    assert body["expiry"]
    assert body["did"] == f"did:zcash:{TADDR}"
    assert body["created"] is True

    mock_verify.assert_called_once_with(TADDR, "IHVsaWduYXR1cmU=", challenge)

    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    creator = identity.creator
    assert creator.username == body["username"]
    assert creator.p2paddr == TADDR
    assert not creator.has_usable_password()

    # A real knox token row exists for this user.
    assert AuthToken.objects.filter(user=creator).count() == 1


@pytest.mark.django_db
def test_second_login_reuses_same_creator(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    # First login -> creates.
    challenge1 = _get_challenge(api_client)
    resp1 = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge1, "signature": "sig1"},
        format="json",
    )
    assert resp1.status_code == 200, resp1.content
    assert resp1.data["created"] is True
    creator_id = ZcashIdentity.objects.get(zcash_address=TADDR).creator_id

    # Second login -> reuses.
    challenge2 = _get_challenge(api_client)
    resp2 = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge2, "signature": "sig2"},
        format="json",
    )
    assert resp2.status_code == 200, resp2.content
    assert resp2.data["created"] is False

    assert ZcashIdentity.objects.filter(zcash_address=TADDR).count() == 1
    assert ZcashIdentity.objects.get(zcash_address=TADDR).creator_id == creator_id
    assert resp2.data["username"] == resp1.data["username"]


def test_verify_zcash_signature_accepts_real_wallet_signature():
    """
    The core regression guard: run the REAL, un-mocked verification against a
    genuine wallet-plugin signature. The old implementation called
    ``client.rpc.verifymessage`` -- an attribute that exists only on the
    retired zcashd proxy, not on the Zallet backend prod runs -- so this check
    returned False for every signature and every login 401'd. In-process
    verification must accept a valid signature and reject tampering.
    """
    from dj.apps.zauth.views import verify_zcash_signature

    assert verify_zcash_signature(
        VECTOR_ADDRESS, VECTOR_SIGNATURE, VECTOR_CHALLENGE) is True
    # Tampered challenge -> different digest -> recovered pubkey/address differ.
    assert verify_zcash_signature(
        VECTOR_ADDRESS, VECTOR_SIGNATURE, VECTOR_CHALLENGE + "!") is False
    # Right signature, wrong claimed address.
    assert verify_zcash_signature(
        TADDR, VECTOR_SIGNATURE, VECTOR_CHALLENGE) is False
    # Malformed signature must fail closed, never raise.
    assert verify_zcash_signature(
        VECTOR_ADDRESS, "not-base64!!", VECTOR_CHALLENGE) is False


@pytest.mark.django_db
def test_login_end_to_end_with_real_signature(api_client, settings, mocker):
    """
    Full challenge -> sign -> login path with NO verify mock and NO node: the
    server issues the (patched-to-fixed) challenge, the wallet's real signature
    verifies in-process, and a Creator + knox token are minted.
    """
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED = False
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED = False
    mocker.patch(
        "dj.apps.zauth.views.issue_challenge", return_value=VECTOR_CHALLENGE,
    )
    mocker.patch("dj.apps.zauth.views.store_legacy_compatible_challenge")
    # This pinned wallet vector predates the stateless v2 token envelope.  The
    # real HMAC format is covered in test_challenge_security; here we preserve
    # the cross-language wallet-signature regression through the full view.
    mocker.patch("dj.apps.zauth.views.validate_challenge", return_value=True)

    resp = api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": VECTOR_ADDRESS},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["challenge"] == VECTOR_CHALLENGE

    resp = api_client.post(
        "/api/auth/zcash/login/",
        {
            "address": VECTOR_ADDRESS,
            "challenge": VECTOR_CHALLENGE,
            "signature": VECTOR_SIGNATURE,
            "pubkey": VECTOR_PUBKEY,
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["created"] is True
    assert resp.data["did"] == f"did:zcash:{VECTOR_ADDRESS}"
    identity = ZcashIdentity.objects.get(zcash_address=VECTOR_ADDRESS)
    assert AuthToken.objects.filter(user=identity.creator).count() == 1


@pytest.mark.django_db
def test_login_rejects_bad_signature(api_client, settings, mocker):
    """A real (issued) challenge but a bogus signature -> 401, no account."""
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED = False
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED = False
    mocker.patch(
        "dj.apps.zauth.views.issue_challenge", return_value=VECTOR_CHALLENGE,
    )
    mocker.patch("dj.apps.zauth.views.store_legacy_compatible_challenge")
    mocker.patch("dj.apps.zauth.views.validate_challenge", return_value=True)
    api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": VECTOR_ADDRESS},
        format="json",
    )
    resp = api_client.post(
        "/api/auth/zcash/login/",
        {
            "address": VECTOR_ADDRESS,
            "challenge": VECTOR_CHALLENGE,
            "signature": "anything",
        },
        format="json",
    )
    assert resp.status_code == 401, resp.content
    assert not ZcashIdentity.objects.filter(
        zcash_address=VECTOR_ADDRESS).exists()


@pytest.mark.django_db
def test_challenge_is_single_use(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    challenge = _get_challenge(api_client)
    ok = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge, "signature": "sig"},
        format="json",
    )
    assert ok.status_code == 200, ok.content

    # Replay with the same (now consumed) challenge.
    replay = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge, "signature": "sig"},
        format="json",
    )
    assert replay.status_code == 400, replay.content


@pytest.mark.django_db
def test_mismatched_challenge_rejected(api_client, mocker):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    _get_challenge(api_client)
    resp = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": "ZUULI-Login:not-the-real-one", "signature": "sig"},
        format="json",
    )
    assert resp.status_code == 400, resp.content


@pytest.mark.django_db
def test_associate_links_address_to_authenticated_creator(
    api_client, creator_factory, mocker,
    recent_login,
):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    user = creator_factory()
    api_client.force_authenticate(user=user)
    recent_login(api_client, user)
    before_epoch = Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk)

    challenge = _get_challenge(api_client)
    resp = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge, "signature": "sig"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["created"] is False
    assert resp.data["username"] == user.username

    identity = ZcashIdentity.objects.get(zcash_address=TADDR)
    assert identity.creator_id == user.id

    #. Linking ADDS a principal and invalidates nothing, so the
    # ownership counter deliberately does not move. Removing a Zcash identity
    # has no self-service route; `ZcashIdentityAdmin` is what counts.
    assert Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk) == before_epoch


@pytest.mark.django_db
def test_associate_conflict_when_address_owned_by_other(
    api_client, creator_factory, mocker,
):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    # Owner already holds the address.
    owner = creator_factory()
    ZcashIdentity.objects.create(creator=owner, zcash_address=TADDR)

    other = creator_factory()
    api_client.force_authenticate(user=other)

    challenge = _get_challenge(api_client)
    resp = api_client.post(
        "/api/auth/zcash/login/",
        {"address": TADDR, "challenge": challenge, "signature": "sig"},
        format="json",
    )
    assert resp.status_code == 409, resp.content
    assert ZcashIdentity.objects.get(zcash_address=TADDR).creator_id == owner.id


@pytest.mark.django_db
def test_challenge_requires_address(api_client):
    resp = api_client.post("/api/auth/zcash/challenge/", {}, format="json")
    assert resp.status_code == 400, resp.content
