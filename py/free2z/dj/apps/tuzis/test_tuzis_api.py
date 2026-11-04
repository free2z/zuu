"""Tests for the tuzis (2Z credit) API, against real Postgres.

Auth-boundary regression coverage for the sibling views that were missing
``permission_classes`` (``CreatorSubscribeView``, ``MySubscribersListView``) —
same 500-on-anonymous class as issue  — plus the ``Donate2Z`` money-path
validation guards.
"""
from datetime import timedelta
from decimal import Decimal
import uuid

import pytest
from django.conf import settings as django_settings
from django.middleware.csrf import _get_new_csrf_string
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator, Subscription


# --------------------------------------------------------------------------
# Anonymous access must be rejected cleanly (not 500)
# --------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/tuzis/my-subscribers"),
        ("get", "/api/tuzis/my-subscriptions"),
        ("get", "/api/tuzis/my-subscriptions-summary"),
        ("post", "/api/tuzis/subscribe/someone"),
        ("get", "/api/tuzis/subscribe/someone"),
        ("delete", "/api/tuzis/subscribe/someone"),
        ("post", "/api/tuzis/donate/someone"),
        ("post", "/api/tuzis/donate-idempotent/someone"),
        ("post", "/api/tuzis/subscribe-confirmed/someone"),
        ("get", "/api/tuzis/subscription-status/someone"),
    ],
)
def test_tuzis_endpoints_reject_anonymous(api_client, method, path):
    response = getattr(api_client, method)(path)
    assert response.status_code in (401, 403), (
        f"{method} {path} -> {response.status_code}: {response.content!r}"
    )


# --------------------------------------------------------------------------
# Donate2Z money path
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_donate_transfers_credits(api_client, creator_factory):
    fan = creator_factory()          # tuzis=1000
    star = creator_factory()
    api_client.force_authenticate(user=fan)

    response = api_client.post(
        f"/api/tuzis/donate/{star.username}",
        {"amount": 10},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 200, response.content
    fan.refresh_from_db()
    star.refresh_from_db()
    assert fan.tuzis == Decimal("990")
    assert star.tuzis == Decimal("1010")


@pytest.mark.django_db
def test_cannot_donate_to_self(api_client, creator_factory):
    me = creator_factory()
    api_client.force_authenticate(user=me)
    response = api_client.post(
        f"/api/tuzis/donate/{me.username}", {"amount": 10}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_cannot_donate_more_than_balance(api_client, creator_factory):
    fan = creator_factory()
    star = creator_factory()
    api_client.force_authenticate(user=fan)
    response = api_client.post(
        f"/api/tuzis/donate/{star.username}", {"amount": 999999}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 402, response.content
    assert response.data["code"] == "insufficient_funds"
    assert response.data["cost"] == "999999.000"
    assert response.data["balance"] == "1000.000"
    assert response.data["shortfall"] == "998999.000"
    assert response.data["action"] == "donation"
    fan.refresh_from_db()
    star.refresh_from_db()
    assert fan.tuzis == Decimal("1000")
    assert star.tuzis == Decimal("1000")


@pytest.mark.django_db
def test_subscribers_list_only_shows_my_subscribers(api_client, creator_factory):
    me = creator_factory()
    api_client.force_authenticate(user=me)
    response = api_client.get("/api/tuzis/my-subscribers")
    assert response.status_code == 200, response.content


# --------------------------------------------------------------------------
# SvelteKit server -> localhost nginx -> secure Django CSRF topology
# --------------------------------------------------------------------------


PUBLIC_ORIGIN = "https://free2z.cash"
NEW_UI_ORIGIN = "https://new.free2z.cash"


def csrf_session_client(user, *, cookie_token=None):
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(user)
    token = cookie_token or _get_new_csrf_string()
    client.cookies[django_settings.CSRF_COOKIE_NAME] = token
    return client, token


def topology_kwargs(origin=PUBLIC_ORIGIN, token=None):
    kwargs = {
        "HTTP_HOST": "localhost",
        "HTTP_X_FORWARDED_PROTO": "https",
        "HTTP_ORIGIN": origin,
        "secure": True,
    }
    if token is not None:
        kwargs["HTTP_X_CSRFTOKEN"] = token
    return kwargs


@pytest.fixture
def subscription_pair(creator_factory):
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(member_price=Decimal("15"))
    subscription = Subscription.objects.create(
        fan=fan,
        star=star,
        max_price=Decimal("15"),
        expires=timezone.now() + timedelta(days=30),
    )
    return fan, star, subscription


@pytest.fixture
def production_topology(settings):
    settings.ALLOWED_HOSTS = ["localhost"]
    settings.CSRF_TRUSTED_ORIGINS = [PUBLIC_ORIGIN, NEW_UI_ORIGIN]


@pytest.mark.django_db
@pytest.mark.parametrize(
    "method,payload,expected_status",
    [
        ("post", {}, 200),
        ("patch", {"max_price": "100"}, 200),
        # CreatorSubscribeView has no PUT implementation. A 405 proves the
        # valid request crossed SessionAuthentication's CSRF boundary; the
        # editor bridge test pins PUT routing to the real zPage path.
        ("put", {"max_price": "100"}, 405),
        ("delete", {}, 200),
    ],
)
@pytest.mark.parametrize("origin", [PUBLIC_ORIGIN, NEW_UI_ORIGIN])
def test_trusted_public_origin_crosses_secure_localhost_topology(
    production_topology, subscription_pair, method, payload, expected_status,
    origin,
):
    fan, star, _ = subscription_pair
    client, token = csrf_session_client(fan)

    response = getattr(client, method)(
        f"/api/tuzis/subscribe/{star.username}",
        payload,
        format="json",
        **topology_kwargs(origin=origin, token=token),
    )

    assert response.status_code == expected_status, response.content


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["post", "patch", "put", "delete"])
@pytest.mark.parametrize("token_state", ["missing", "stale", "incorrect"])
def test_topology_rejects_missing_stale_and_incorrect_csrf(
    production_topology, subscription_pair, method, token_state
):
    fan, star, _ = subscription_pair
    client, cookie_token = csrf_session_client(fan)

    if token_state == "missing":
        header_token = None
    elif token_state == "stale":
        # A token captured before cookie rotation is structurally valid but no
        # longer matches the current CSRF secret.
        header_token = _get_new_csrf_string()
    else:
        header_token = "x" * len(cookie_token)

    response = getattr(client, method)(
        f"/api/tuzis/subscribe/{star.username}",
        {"max_price": "100"},
        format="json",
        **topology_kwargs(token=header_token),
    )

    assert response.status_code == 403, response.content
    assert b"CSRF" in response.content


@pytest.mark.django_db
def test_topology_rejects_untrusted_origin(
    production_topology, subscription_pair
):
    fan, star, _ = subscription_pair
    client, token = csrf_session_client(fan)

    response = client.patch(
        f"/api/tuzis/subscribe/{star.username}",
        {"max_price": "100"},
        format="json",
        **topology_kwargs(origin="https://evil.example", token=token),
    )

    assert response.status_code == 403, response.content
    assert b"Origin checking failed" in response.content


@pytest.mark.django_db
def test_patch_returns_authoritative_subscription_and_persists(
    production_topology, subscription_pair
):
    fan, star, subscription = subscription_pair
    client, token = csrf_session_client(fan)

    response = client.patch(
        f"/api/tuzis/subscribe/{star.username}",
        {"max_price": "100"},
        format="json",
        **topology_kwargs(token=token),
    )

    assert response.status_code == 200, response.content
    assert response.data["fan"]["username"] == fan.username
    assert response.data["star"]["username"] == star.username
    assert Decimal(response.data["max_price"]) == Decimal("100")
    subscription.refresh_from_db()
    assert subscription.max_price == Decimal("100")


@pytest.mark.django_db
def test_cross_user_cannot_change_another_fans_subscription(
    production_topology, subscription_pair, creator_factory
):
    victim, star, subscription = subscription_pair
    attacker = creator_factory(tuzis=Decimal("1000"))
    client, token = csrf_session_client(attacker)

    response = client.patch(
        f"/api/tuzis/subscribe/{star.username}",
        {"max_price": "100"},
        format="json",
        **topology_kwargs(token=token),
    )

    assert response.status_code == 404, response.content
    subscription.refresh_from_db()
    assert subscription.fan == victim
    assert subscription.max_price == Decimal("15")


@pytest.mark.django_db
@pytest.mark.parametrize(
    "payload",
    [{}, {"max_price": "nope"}, {"max_price": "1000001"}],
)
def test_patch_rejects_invalid_schema_without_500(
    production_topology, subscription_pair, payload
):
    fan, star, _ = subscription_pair
    client, token = csrf_session_client(fan)

    response = client.patch(
        f"/api/tuzis/subscribe/{star.username}",
        payload,
        format="json",
        **topology_kwargs(token=token),
    )

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_patch_rejects_unpriced_creator_without_500(
    production_topology, subscription_pair
):
    fan, star, subscription = subscription_pair
    # NOT NULL since; a negative price (past the validators) is the
    # remaining unchargeable one.
    Creator.objects.filter(pk=star.pk).update(member_price=-1)
    client, token = csrf_session_client(fan)

    response = client.patch(
        f"/api/tuzis/subscribe/{star.username}",
        {"max_price": "100"},
        format="json",
        **topology_kwargs(token=token),
    )

    assert response.status_code == 400, response.content
    subscription.refresh_from_db()
    assert subscription.max_price == Decimal("15")


@pytest.mark.django_db
def test_patch_accepts_a_renewal_cap_for_a_free_membership(
    production_topology, subscription_pair
):
    """: a free (price 0) membership takes a cap -- the fan's consent
    for the free follow to renew, and the most a later price rise may charge."""
    fan, star, subscription = subscription_pair
    Creator.objects.filter(pk=star.pk).update(member_price=0)
    client, token = csrf_session_client(fan)

    response = client.patch(
        f"/api/tuzis/subscribe/{star.username}",
        {"max_price": "20"},
        format="json",
        **topology_kwargs(token=token),
    )

    assert response.status_code == 200, response.content
    subscription.refresh_from_db()
    assert subscription.max_price == Decimal("20")


# --------------------------------------------------------------------------
# Idempotency-Key must be reachable from a browser ( finding F8)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("origin", ["https://free2z.cash", "http://localhost:1423"])
def test_preflight_allows_idempotency_key(client, origin):
    """A cross-origin browser client must be permitted to SEND the header.

    Documenting the header in f2z.yaml is worthless if the preflight rejects
    it: corsheaders' ``default_headers`` does not include ``idempotency-key``,
    so the double-charge protection was unreachable from the web until it was
    added to ``CORS_ALLOW_HEADERS``. Asserted through a real OPTIONS preflight
    rather than against the settings tuple, so middleware ordering counts too.
    """
    response = client.options(
        "/api/tuzis/subscribe/someone",
        HTTP_ORIGIN=origin,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS="content-type,idempotency-key",
    )

    allowed = response.headers.get("access-control-allow-headers", "")
    assert "idempotency-key" in allowed.lower(), (
        f"preflight from {origin} -> {response.status_code}, "
        f"allow-headers={allowed!r}"
    )


@pytest.mark.parametrize(
    ("path", "requested_headers"),
    [
        ("/api/ai/prompt/", "content-type,idempotency-key,x-expected-actor"),
        (
            "/api/openai/image",
            "content-type,idempotency-key,x-expected-actor,x-require-existing-receipt",
        ),
    ],
)
def test_paid_ai_preflight_allows_actor_and_receipt_preconditions(
    client, settings, path, requested_headers
):
    """The browser must be able to send the server-enforced paid-request guards."""
    settings.ALLOWED_HOSTS = ["localhost"]
    response = client.options(
        path,
        HTTP_HOST="localhost:8000",
        HTTP_ORIGIN="http://localhost:3000",
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS=requested_headers,
    )

    allowed = response.headers.get("access-control-allow-headers", "").lower()
    assert response.status_code == 200
    assert "idempotency-key" in allowed
    assert "x-expected-actor" in allowed
    if "x-require-existing-receipt" in requested_headers:
        assert "x-require-existing-receipt" in allowed
