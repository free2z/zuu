"""``/api/e2ee/handle/``, ``/api/e2ee/handle/claim/`` and ``/api/e2ee/authority/``."""

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.core.cache import cache
from django.urls import reverse
from knox.models import AuthToken

from dj.apps.handles.models import MessagingHandle
from dj.apps.ktauth import signing

pytestmark = pytest.mark.django_db

STATUS_URL = "/api/e2ee/handle/"
CLAIM_URL = "/api/e2ee/handle/claim/"
AUTHORITY_URL = "/api/e2ee/authority/"


@pytest.fixture(autouse=True)
def _empty_throttle_bucket():
    cache.clear()
    yield
    cache.clear()


def test_routes_are_mounted_where_clients_expect_them():
    assert reverse("e2ee_handle") == STATUS_URL
    assert reverse("e2ee_handle_claim") == CLAIM_URL
    assert reverse("e2ee_authority") == AUTHORITY_URL


# ------------------------------------------------------------------ auth


@pytest.mark.parametrize(
    ("method", "url"), [("get", STATUS_URL), ("post", CLAIM_URL)]
)
def test_anonymous_callers_are_refused(api_client, method, url):
    response = getattr(api_client, method)(url, {"handle": "anon"}, format="json")
    assert response.status_code in (401, 403)
    assert not MessagingHandle.objects.filter(handle="anon").exists()


def test_a_knox_token_is_accepted(api_client, creator_factory):
    user = creator_factory(username="tokened")
    _instance, raw = AuthToken.objects.create(user)
    api_client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
    response = api_client.get(STATUS_URL)
    assert response.status_code == 200, response.data
    assert response.data["handle"] == "tokened"


# ---------------------------------------------------------------- status


def test_a_new_eligible_account_is_bound_to_its_username(
    api_client, creator_factory
):
    user = creator_factory(username="Alice_7")
    api_client.force_authenticate(user=user)
    assert api_client.get(STATUS_URL).data == {
        "handle": "alice_7",
        "status": "bound",
        "source": "username",
        "candidate": "alice_7",
        "eligible": True,
        "reason": None,
        "can_claim": False,
    }


def test_an_ineligible_account_is_unclaimed_and_told_why(
    api_client, creator_factory
):
    api_client.force_authenticate(user=creator_factory(username="first.last"))
    assert api_client.get(STATUS_URL).data == {
        "handle": None,
        "status": "unclaimed",
        "source": None,
        "candidate": None,
        "eligible": False,
        "reason": "punctuation",
        "can_claim": True,
    }


def test_the_later_case_variant_account_is_told_its_candidate_is_taken(
    api_client, creator_factory
):
    creator_factory(username="Mallory")
    later = creator_factory(username="mallory", username_ci_legacy="mallory")
    api_client.force_authenticate(user=later)
    data = api_client.get(STATUS_URL).data
    assert data["status"] == "unclaimed"
    assert data["candidate"] == "mallory"
    assert data["reason"] == "taken"
    assert data["can_claim"] is True
    assert "Mallory" not in str(data)


def test_a_reserved_username_is_unclaimed(api_client, creator_factory):
    api_client.force_authenticate(user=creator_factory(username="Admin"))
    data = api_client.get(STATUS_URL).data
    assert (data["status"], data["reason"]) == ("unclaimed", "reserved")


def test_the_status_read_writes_nothing(api_client, creator_factory):
    """Rule B of test_url_write_guard: a GET never reserves."""
    user = creator_factory(username="lazy")
    MessagingHandle.objects.filter(user=user).delete()
    api_client.force_authenticate(user=user)
    data = api_client.get(STATUS_URL).data
    assert (data["status"], data["eligible"]) == ("unclaimed", True)
    assert not MessagingHandle.objects.filter(user=user).exists()


# ----------------------------------------------------------------- claim


@pytest.fixture
def unclaimed(api_client, creator_factory):
    user = creator_factory(username="first.last")
    api_client.force_authenticate(user=user)
    return user


def test_an_unclaimed_account_claims_a_handle(api_client, unclaimed):
    response = api_client.post(CLAIM_URL, {"handle": "firstlast"}, format="json")
    assert response.status_code == 201, response.data
    assert response.data["handle"] == "firstlast"
    assert response.data["source"] == "claimed"
    assert response.data["can_claim"] is False
    row = MessagingHandle.objects.get(user=unclaimed)
    assert (row.handle, row.status, row.source) == ("firstlast", "bound", "claimed")


def test_a_claim_is_permanent(api_client, unclaimed):
    assert api_client.post(
        CLAIM_URL, {"handle": "firstlast"}, format="json"
    ).status_code == 201
    response = api_client.post(CLAIM_URL, {"handle": "another"}, format="json")
    assert response.status_code == 409
    assert response.data["code"] == "already_bound"
    assert MessagingHandle.objects.get(user=unclaimed).handle == "firstlast"


def test_an_account_bound_from_its_username_cannot_claim_another(
    api_client, creator_factory
):
    api_client.force_authenticate(user=creator_factory(username="bound_one"))
    response = api_client.post(CLAIM_URL, {"handle": "other"}, format="json")
    assert (response.status_code, response.data["code"]) == (409, "already_bound")


@pytest.mark.parametrize(
    "handle",
    ["", "Upper", "has.dot", "a" * 31, " padded", "padded ", "trail\n",
     "K", "ａ", 12, None, ["x"]],
)
def test_a_malformed_handle_is_refused_not_folded(api_client, unclaimed, handle):
    response = api_client.post(CLAIM_URL, {"handle": handle}, format="json")
    assert response.status_code == 400, response.data
    assert response.data["code"] == "invalid"
    assert not MessagingHandle.objects.filter(user=unclaimed).exists()


def test_a_missing_body_is_invalid(api_client, unclaimed):
    response = api_client.post(CLAIM_URL, {}, format="json")
    assert (response.status_code, response.data["code"]) == (400, "invalid")


@pytest.mark.parametrize("handle", ["support", "free2z", "admin", "e2e2z"])
def test_a_reserved_handle_cannot_be_claimed(api_client, unclaimed, handle):
    response = api_client.post(CLAIM_URL, {"handle": handle}, format="json")
    assert (response.status_code, response.data["code"]) == (400, "reserved")


def test_a_handle_held_by_another_account_is_taken(
    api_client, creator_factory, unclaimed
):
    creator_factory(username="victim")
    response = api_client.post(CLAIM_URL, {"handle": "victim"}, format="json")
    assert (response.status_code, response.data["code"]) == (409, "taken")
    assert MessagingHandle.objects.get(handle="victim").user.username == "victim"


def test_another_accounts_unreserved_username_is_protected(
    api_client, creator_factory, unclaimed
):
    """An eligible account with no row yet (created mid-deploy) keeps its name."""
    other = creator_factory(username="Latecomer")
    MessagingHandle.objects.filter(user=other).delete()
    response = api_client.post(CLAIM_URL, {"handle": "latecomer"}, format="json")
    assert (response.status_code, response.data["code"]) == (409, "taken")


def test_a_retired_handle_is_never_reissued(api_client, creator_factory, unclaimed):
    gone = creator_factory(username="departed")
    gone.delete()
    row = MessagingHandle.objects.get(handle="departed")
    assert (row.status, row.user_id) == ("retired", None)
    response = api_client.post(CLAIM_URL, {"handle": "departed"}, format="json")
    assert (response.status_code, response.data["code"]) == (409, "taken")


def test_a_case_collision_loser_can_claim_its_way_out(api_client, creator_factory):
    creator_factory(username="Trent")
    later = creator_factory(username="trent", username_ci_legacy="trent")
    api_client.force_authenticate(user=later)
    assert api_client.post(
        CLAIM_URL, {"handle": "trent"}, format="json"
    ).data["code"] == "taken"
    response = api_client.post(CLAIM_URL, {"handle": "trent_2"}, format="json")
    assert response.status_code == 201, response.data
    assert response.data["handle"] == "trent_2"


def test_a_claim_ignores_any_user_named_in_the_body(
    api_client, creator_factory, unclaimed
):
    victim = creator_factory(username="has.dot.too")
    api_client.post(
        CLAIM_URL,
        {"handle": "mine", "user": victim.pk, "user_id": victim.pk},
        format="json",
    )
    assert MessagingHandle.objects.get(handle="mine").user == unclaimed
    assert not MessagingHandle.objects.filter(user=victim).exists()


def test_claims_are_rate_limited_per_account(api_client, unclaimed, creator_factory):
    """Twenty an hour, refusals included: each one answers "is this held"."""
    from rest_framework.throttling import SimpleRateThrottle

    from dj.free2z.throttling import HandleClaimRateThrottle

    assert SimpleRateThrottle.THROTTLE_RATES["e2ee-handle-claim"] == "20/hour"
    assert HandleClaimRateThrottle.scope == "e2ee-handle-claim"

    codes = [
        api_client.post(CLAIM_URL, {"handle": "support"}, format="json").status_code
        for _ in range(21)
    ]
    assert codes == [400] * 20 + [429]

    # Another account has its own bucket.
    api_client.force_authenticate(user=creator_factory(username="x.y"))
    assert api_client.post(
        CLAIM_URL, {"handle": "xy"}, format="json"
    ).status_code == 201


# ------------------------------------------------------------- authority


def test_the_authority_endpoint_serves_the_loaded_public_key(api_client, settings):
    settings.KT_LOG_ID_HEX = "9a" * 32
    installed = signing.install(Ed25519PrivateKey.from_private_bytes(bytes(range(32))))
    try:
        response = api_client.get(AUTHORITY_URL)
    finally:
        signing.reset()
    assert response.status_code == 200, response.data
    # The same values `f2z-assert authority --key <00..1f>` prints.
    assert response.data == {
        "public_key": "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",
        "authority_id": "cce6793eba2365b6641231ad67a2d4e4faaaa6589329eadcf4de09016c377fd6",
        "log_id": "9a" * 32,
        "validity_ms": signing.DEFAULT_TTL_MS,
    }
    assert installed.public_key.hex() == response.data["public_key"]
    assert "seed" not in str(response.data).lower()


def test_an_unconfigured_authority_is_a_bounded_503(api_client, settings):
    settings.KT_AUTHORITY_SECRET_NAME = ""
    signing.reset()
    try:
        response = api_client.get(AUTHORITY_URL)
    finally:
        signing.reset()
    assert response.status_code == 503
    assert response.data["reason"] == signing.REASON_UNCONFIGURED


def test_the_authority_endpoint_never_fetches_the_key(api_client, settings, mocker):
    """An anonymous request must not start a Secret Manager round trip."""
    settings.KT_AUTHORITY_SECRET_NAME = "projects/p/secrets/s/versions/1"
    settings.KT_LOG_ID_HEX = "9a" * 32
    signing.reset()
    fetch = mocker.patch.object(signing, "_fetch_secret_payload")
    try:
        response = api_client.get(AUTHORITY_URL)
    finally:
        signing.reset()
    assert response.status_code == 503
    assert response.data["reason"] == signing.REASON_FETCH_FAILED
    fetch.assert_not_called()


def test_a_handle_is_not_reused_when_its_username_is_freed(
    api_client, creator_factory
):
    """A delivered ``#peer=olivia`` link must keep meaning the same person.

    Olivia renames; somebody else registers ``olivia``. The handle stays with
    Olivia, the newcomer gets no handle automatically and cannot claim it.
    """
    olivia = creator_factory(username="olivia")
    olivia.username = "olivia_new"
    olivia.save(update_fields=["username"])

    newcomer = creator_factory(username="Olivia")
    assert MessagingHandle.objects.get(handle="olivia").user_id == olivia.pk
    assert not MessagingHandle.objects.filter(user=newcomer).exists()

    api_client.force_authenticate(user=newcomer)
    status_body = api_client.get(STATUS_URL).data
    assert (status_body["status"], status_body["reason"]) == ("unclaimed", "taken")
    response = api_client.post(CLAIM_URL, {"handle": "olivia"}, format="json")
    assert (response.status_code, response.data["code"]) == (409, "taken")

    api_client.force_authenticate(user=olivia)
    assert api_client.get(STATUS_URL).data["handle"] == "olivia"
