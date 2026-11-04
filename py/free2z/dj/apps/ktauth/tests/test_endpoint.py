"""``POST /api/kt/handle-assertion/`` end to end.

The rule this file exists to hold is the second one in ``views.py``: **the
handle comes from ``request.user``.** Several tests below do nothing but try to
name a handle from the outside, in every place a request can carry a value, and
assert that none of them changes what gets signed.
"""

import pytest
from django.core.cache import cache

from dj.apps.ktauth import signing
from dj.apps.handles.models import MessagingHandle
from dj.apps.ktauth.views import REASON_UNCLAIMED

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _empty_throttle_bucket():
    """The endpoint allows 10/hour per account; tests must not inherit a bucket."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def body(identity_key_b64):
    return {"identity_key": identity_key_b64, "intent": "bind"}


@pytest.fixture
def caller(api_client, creator_factory):
    user = creator_factory(username="alice")
    api_client.force_authenticate(user=user)
    return user


def assertion_bytes(response):
    """The raw ``tls_codec(HandleAssertion)`` out of a 200 response."""
    import base64

    text = response.data["assertion"]
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# ------------------------------------------------------------------ happy path


def test_an_authenticated_caller_gets_a_signed_assertion(
    api_client, caller, url, body, authority, kt_settings
):
    response = api_client.post(url, body, format="json")
    assert response.status_code == 200, response.data
    assert response.data["handle"] == "alice"
    assert response.data["expires_ms"] > response.data["issued_ms"]

    raw = assertion_bytes(response)
    assert len(raw) == 201 + 64  # the fixed fields, a 5-byte handle, a signature
    assert raw[1:1 + len(signing.LABEL_ASSERTION_TBS)] == (
        signing.LABEL_ASSERTION_TBS
    )


def test_the_signature_verifies_under_the_loaded_authority_key(
    api_client, caller, url, body, authority, kt_settings
):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PublicKey,
    )

    raw = assertion_bytes(api_client.post(url, body, format="json"))
    Ed25519PublicKey.from_public_bytes(authority.public_key).verify(
        raw[-64:], raw[:-64]
    )


def test_the_assertion_carries_the_configured_log_and_the_requested_key(
    api_client, caller, url, body, authority, kt_settings, identity_key_b64
):
    from .conftest import LOG_ID, identity_public_bytes

    raw = assertion_bytes(api_client.post(url, body, format="json"))
    label = 1 + len(signing.LABEL_ASSERTION_TBS)
    assert raw[label + 32:label + 64] == LOG_ID
    assert identity_public_bytes() in raw


def test_the_validity_window_is_inside_the_verifiers_cap(
    api_client, caller, url, body, authority, kt_settings
):
    response = api_client.post(url, body, format="json")
    window = response.data["expires_ms"] - response.data["issued_ms"]
    assert 0 < window <= signing.MAX_VALIDITY_MS


def test_a_reset_intent_is_signed_as_reset(
    api_client, caller, url, body, authority, kt_settings
):
    body["intent"] = "reset"
    raw = assertion_bytes(api_client.post(url, body, format="json"))
    # intent sits directly after label, authority_id, log_id, handle, handle_id
    # and identity_pk.
    offset = 1 + len(signing.LABEL_ASSERTION_TBS) + 32 + 32 + 1 + 5 + 32 + 32
    assert raw[offset] == signing.INTENT_RESET


def test_two_assertions_for_the_same_account_differ(
    api_client, caller, url, body, authority, kt_settings
):
    """The nonce is fresh per assertion, so no two are the same bytes."""
    first = assertion_bytes(api_client.post(url, body, format="json"))
    second = assertion_bytes(api_client.post(url, body, format="json"))
    assert first != second


# ------------------------------------------- the handle comes from the session


@pytest.mark.parametrize(
    "extra",
    [
        {"handle": "victim"},
        {"username": "victim"},
        {"user": "victim"},
        {"identity_key": None, "handle": "victim"},  # replaced below
    ],
)
def test_a_handle_in_the_body_is_ignored(
    api_client, caller, url, body, authority, kt_settings, extra
):
    payload = dict(body)
    payload.update({k: v for k, v in extra.items() if v is not None})
    response = api_client.post(url, payload, format="json")
    assert response.status_code == 200, response.data
    assert response.data["handle"] == "alice"
    assert b"victim" not in assertion_bytes(response)


def test_a_handle_in_the_query_string_is_ignored(
    api_client, caller, url, body, authority, kt_settings
):
    response = api_client.post(
        url + "?handle=victim&username=victim", body, format="json"
    )
    assert response.status_code == 200, response.data
    assert response.data["handle"] == "alice"


def test_the_handle_follows_the_authenticated_account(
    api_client, creator_factory, url, body, authority, kt_settings
):
    api_client.force_authenticate(user=creator_factory(username="bob_2"))
    response = api_client.post(url, body, format="json")
    assert response.data["handle"] == "bob_2"


def test_an_uppercase_username_is_folded_to_its_handle(
    api_client, creator_factory, url, body, authority, kt_settings
):
    """``WIRE.md`` §14.3: eligibility is ``lowercase(username)``."""
    api_client.force_authenticate(user=creator_factory(username="Alice2"))
    response = api_client.post(url, body, format="json")
    assert response.status_code == 200, response.data
    assert response.data["handle"] == "alice2"


# ------------------------------------------------------------- who has no handle


@pytest.mark.parametrize(
    "username",
    [
        "has.dot",
        "has-dash",
        "has+plus",
        "user@example.com",
        "a" * 31,
        "ünicode",
        "ＡＬＩＣＥ",
        "support",  # a reserved word is never assigned automatically
    ],
)
def test_an_account_without_a_bound_handle_is_refused_not_mangled(
    api_client, creator_factory, url, body, authority, kt_settings, username
):
    api_client.force_authenticate(user=creator_factory(username=username))
    response = api_client.post(url, body, format="json")
    assert response.status_code == 409, response.data
    assert response.data["reason"] == REASON_UNCLAIMED


def test_a_kelvin_sign_username_cannot_fold_into_someone_elses_handle(
    api_client, creator_factory, url, body, authority, kt_settings
):
    """``str.lower`` is Unicode-aware: U+212A lowercases to ASCII ``k``.

    The ASCII gate in ``handles.policy.eligibility`` is what keeps this account
    from being given (or signed for) the handle ``k``, which another account
    owns.
    """
    creator_factory(username="k")
    kelvin = creator_factory(username="\u212a", username_ci_legacy="\u212a")
    api_client.force_authenticate(user=kelvin)
    response = api_client.post(url, body, format="json")
    assert response.status_code == 409, response.data
    assert response.data["reason"] == REASON_UNCLAIMED
    assert MessagingHandle.objects.get(handle="k").user.username == "k"


def test_of_two_case_variant_accounts_only_the_earliest_is_vouched_for(
    api_client, creator_factory, url, body, authority, kt_settings
):
    """``WIRE.md`` §14.3's 2026-08-23 correction, resolved rather than refused.

    Production holds case-variant duplicates. The earliest account owns the
    lowercase handle; the later one (exempt from the username index because it
    predates it) owns nothing until it claims, and the refusal says nothing
    about the other account.
    """
    earliest = creator_factory(username="Carol")
    later = creator_factory(username="carol", username_ci_legacy="carol")

    api_client.force_authenticate(user=later)
    response = api_client.post(url, body, format="json")
    assert response.status_code == 409, response.data
    assert response.data["reason"] == REASON_UNCLAIMED
    assert "Carol" not in response.data["detail"]

    api_client.force_authenticate(user=earliest)
    response = api_client.post(url, body, format="json")
    assert response.status_code == 200, response.data
    assert response.data["handle"] == "carol"


def test_a_claimed_handle_is_the_one_signed(
    api_client, creator_factory, url, body, authority, kt_settings
):
    user = creator_factory(username="has.dot")
    MessagingHandle.objects.create(
        handle="dotless", user=user, source="claimed"
    )
    api_client.force_authenticate(user=user)
    response = api_client.post(url, body, format="json")
    assert response.status_code == 200, response.data
    assert response.data["handle"] == "dotless"
    assert b"\x07dotless" in assertion_bytes(response)
    assert b"has.dot" not in assertion_bytes(response)


def test_a_renamed_account_keeps_its_bound_handle(
    api_client, caller, url, body, authority, kt_settings
):
    """Handles are permanent: the username moving does not move the handle."""
    caller.username = "alice_renamed"
    caller.save(update_fields=["username"])
    response = api_client.post(url, body, format="json")
    assert response.status_code == 200, response.data
    assert response.data["handle"] == "alice"


def test_an_eligible_account_with_no_row_yet_is_reserved_on_first_use(
    api_client, caller, url, body, authority, kt_settings
):
    """An account created by a pre-migration pod mid-deploy has no row."""
    MessagingHandle.objects.filter(user=caller).delete()
    response = api_client.post(url, body, format="json")
    assert response.status_code == 200, response.data
    assert response.data["handle"] == "alice"
    assert MessagingHandle.objects.get(user=caller).source == "username"


def test_a_retired_binding_is_not_vouched_for(
    api_client, caller, url, body, authority, kt_settings
):
    MessagingHandle.objects.filter(user=caller).update(status="retired")
    response = api_client.post(url, body, format="json")
    assert response.status_code == 409, response.data
    assert response.data["reason"] == REASON_UNCLAIMED


def test_the_refusal_reasons_the_view_raises_are_the_ones_documented():
    from dj.apps.ktauth.serializers import HandleIneligibleSerializer
    from dj.apps.ktauth.views import INELIGIBLE_REASONS

    declared = HandleIneligibleSerializer().fields["reason"].choices
    assert set(declared) == set(INELIGIBLE_REASONS)


# ------------------------------------------------------------------ bad input


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"intent": "bind"},
        {"identity_key": "not base64!"},
        {"identity_key": "AAAA", "intent": "bind"},          # too short
        {"identity_key": "A" * 43, "intent": "sideways"},     # unknown intent
        {"identity_key": "A" * 43},                           # no intent
        {"identity_key": "", "intent": "bind"},
        {"identity_key": None, "intent": "bind"},
    ],
)
def test_a_malformed_request_is_a_400(
    api_client, caller, url, authority, kt_settings, payload
):
    response = api_client.post(url, payload, format="json")
    assert response.status_code == 400, response.data


def test_a_standard_base64_key_is_refused_rather_than_guessed_at(
    api_client, caller, url, authority, kt_settings
):
    import base64

    from .conftest import identity_public_bytes

    standard = base64.b64encode(identity_public_bytes()).decode()
    response = api_client.post(
        url, {"identity_key": standard, "intent": "bind"}, format="json"
    )
    if "+" in standard or "/" in standard:
        assert response.status_code == 400, response.data
    else:  # the fixed test key happens to have no distinguishing character
        assert response.status_code == 200, response.data


def test_padding_on_the_identity_key_is_accepted(
    api_client, caller, url, authority, kt_settings, identity_key_b64
):
    response = api_client.post(
        url,
        {"identity_key": identity_key_b64 + "=", "intent": "bind"},
        format="json",
    )
    assert response.status_code == 200, response.data


# ------------------------------------------------------------ auth and method


def test_an_anonymous_caller_is_refused(
    api_client, url, body, authority, kt_settings
):
    response = api_client.post(url, body, format="json")
    assert response.status_code in (401, 403)


def test_an_anonymous_caller_is_refused_before_anything_is_signed(
    api_client, url, body, authority, kt_settings, mocker
):
    issue = mocker.spy(signing, "issue")
    api_client.post(url, body, format="json")
    issue.assert_not_called()


@pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
def test_only_post_is_allowed(
    api_client, caller, url, authority, kt_settings, method
):
    response = getattr(api_client, method)(url)
    assert response.status_code == 405


# ------------------------------------------------------------- fail closed 503


def test_no_issuing_key_is_a_503_with_a_bounded_reason(
    api_client, caller, url, body, no_authority, kt_settings, settings
):
    settings.KT_AUTHORITY_SECRET_NAME = ""
    response = api_client.post(url, body, format="json")
    assert response.status_code == 503, response.data
    assert response.data["reason"] == signing.REASON_UNCONFIGURED
    assert set(response.data) == {"detail", "reason"}


def test_no_configured_log_is_a_503_and_not_a_default_log(
    api_client, caller, url, body, authority, settings
):
    settings.KT_LOG_ID_HEX = ""
    response = api_client.post(url, body, format="json")
    assert response.status_code == 503, response.data
    assert response.data["reason"] == signing.REASON_LOG_UNCONFIGURED


def test_a_503_says_nothing_about_the_deployment(
    api_client, caller, url, body, no_authority, kt_settings, settings, mocker
):
    settings.KT_AUTHORITY_SECRET_NAME = "projects/free2z/secrets/kt/versions/9"
    mocker.patch(
        "google.auth.default",
        side_effect=RuntimeError("projects/free2z: PERMISSION_DENIED"),
    )
    response = api_client.post(url, body, format="json")
    assert response.status_code == 503
    body_text = str(response.data)
    assert "free2z" not in body_text
    assert "PERMISSION_DENIED" not in body_text
    assert response.data["reason"] == signing.REASON_FETCH_FAILED


def test_an_endpoint_that_cannot_issue_never_touches_the_database(
    api_client, caller, url, body, no_authority, kt_settings, settings,
    django_assert_num_queries,
):
    """No authority means 503 before the eligibility query, not after it.

    ``handle_for`` reads, and may write, the messaging-handle table. Every
    deployment is unconfigured today, so an endpoint that answered 503 *after*
    that would be a publicly routed, permanently inert route that still hits
    the database once per request -- and the global user ceiling fails open
    during a Redis outage.
    """
    settings.KT_AUTHORITY_SECRET_NAME = ""
    with django_assert_num_queries(0):
        response = api_client.post(url, body, format="json")
    assert response.status_code == 503, response.data


def test_the_rest_of_the_api_is_unaffected_by_a_missing_issuing_key(
    api_client, caller, url, body, no_authority, kt_settings, settings
):
    """Fail closed and SCOPED. A 503 here is not a 503 anywhere else."""
    settings.KT_AUTHORITY_SECRET_NAME = ""
    assert api_client.post(url, body, format="json").status_code == 503
    assert api_client.get("/api/auth/user/").status_code == 200


# ------------------------------------------------------------------- throttle


def test_the_endpoint_has_its_own_tight_bucket(
    api_client, caller, url, body, authority, kt_settings
):
    """Ten an hour. Enrollment is rare; nothing here bursts."""
    from rest_framework.throttling import SimpleRateThrottle

    from dj.free2z.throttling import HandleAssertionRateThrottle

    rate = SimpleRateThrottle.THROTTLE_RATES["kt-assertion"]
    assert rate == "10/hour"
    assert HandleAssertionRateThrottle.scope == "kt-assertion"

    codes = [
        api_client.post(url, body, format="json").status_code
        for _ in range(12)
    ]
    assert codes[:10] == [200] * 10
    assert codes[10:] == [429, 429]


def test_the_bucket_is_per_account_not_shared(
    api_client, creator_factory, url, body, authority, kt_settings
):
    api_client.force_authenticate(user=creator_factory(username="dave"))
    for _ in range(10):
        assert api_client.post(url, body, format="json").status_code == 200
    assert api_client.post(url, body, format="json").status_code == 429

    api_client.force_authenticate(user=creator_factory(username="erin"))
    assert api_client.post(url, body, format="json").status_code == 200


def test_the_throttle_never_falls_back_to_an_ip_bucket():
    """DRF's ``UserRateThrottle`` buckets anonymous callers by address.

    The view is ``IsAuthenticated`` so the path is unreachable today; this is
    what keeps it unreachable if that ever changes — a silent per-IP budget is
    the  failure, and behind the SSR pod it is one bucket for the whole
    internet.
    """
    from django.contrib.auth.models import AnonymousUser
    from rest_framework.request import Request
    from rest_framework.test import APIRequestFactory

    from dj.free2z.throttling import HandleAssertionRateThrottle

    request = Request(APIRequestFactory().post("/api/kt/handle-assertion/"))
    request.user = AnonymousUser()
    assert HandleAssertionRateThrottle().get_cache_key(request, view=None) is None


def test_the_dedicated_bucket_is_separate_from_the_global_user_ceiling():
    """Both throttles derive from the same class; only the scope keeps them
    apart, so a copy-paste that dropped the scope would silently merge them."""
    from dj.free2z.throttling import (
        AuthenticatedUserRateThrottle,
        HandleAssertionRateThrottle,
    )

    assert issubclass(HandleAssertionRateThrottle, AuthenticatedUserRateThrottle)
    assert HandleAssertionRateThrottle.scope != AuthenticatedUserRateThrottle().scope


def test_handle_for_only_reads(creator_factory):
    """Other code (the chat-request API) calls ``handle_for`` from read paths.

    ``dj/apps/test_url_write_guard.py`` Rule B forbids a GET reaching a write,
    so the reservation fallback lives in the POST view, never in here.
    """
    from dj.apps.ktauth.views import HandleIneligible, handle_for

    user = creator_factory(username="unreserved")
    MessagingHandle.objects.filter(user=user).delete()
    with pytest.raises(HandleIneligible):
        handle_for(user)
    assert not MessagingHandle.objects.filter(user=user).exists()
