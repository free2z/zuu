"""Regression tests for the create_checkout_session boundary contract.

``quantity`` is client-supplied and feeds a Stripe charge. It arrives as
arbitrary JSON, so validate it as a bounded integer before pricing or creating
a provider Session; malformed and fractional values are 400s, not 500s or
silently truncated purchases.

Stripe's hosted URL is an external redirect consumed by both the browser and
native ZUULI. Only the exact HTTPS Checkout origin may cross that boundary, and
both documented success fields must be present; a bad provider payload is a
502, never a redirect response.

Note: this file is named ``test_*.py`` on purpose — pytest.ini's
``python_files = test_*.py`` does NOT collect the app's legacy ``tests.py``.
"""
import pytest
from unittest.mock import patch

from dj.apps.ztripe.models import CheckoutIntent
from dj.free2z.settings import _parse_stripe_checkout_allowed_hosts


STRIPE_TEST_SECRET_KEY = "sk_test_checkout_quantity"
CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_checkout#opaque"


def _mock_checkout_session(
    create,
    *,
    session_id="cs_test_checkout",
    url=CHECKOUT_URL,
    mode="payment",
    livemode=False,
    account=None,
):
    """Mock a Session that satisfies 's identity checks.

    ``mode``/``livemode``/``account`` must be set explicitly: the view reads
    them off the returned object, and an unset attribute on a MagicMock is a
    new MagicMock (never ``None``), which would fail the identity comparison
    for reasons that have nothing to do with the URL under test.
    """
    create.return_value.id = session_id
    create.return_value.url = url
    create.return_value.mode = mode
    create.return_value.livemode = livemode
    create.return_value.account = account


@pytest.fixture(autouse=True)
def stripe_identity(settings):
    settings.STRIPE_SECRET_KEY = STRIPE_TEST_SECRET_KEY
    settings.STRIPE_EXPECTED_ACCOUNT_ID = "acct_testCheckoutQuantity"
    settings.STRIPE_EXPECTED_LIVEMODE = "false"
    settings.STRIPE_CHECKOUT_ENABLED = "true"
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = "we_testCheckoutQuantity"
    with patch(
        "dj.apps.ztripe.views.stripe.Account.retrieve",
        return_value={"id": settings.STRIPE_EXPECTED_ACCOUNT_ID},
    ), patch(
        "dj.apps.ztripe.views.stripe.WebhookEndpoint.retrieve",
        side_effect=lambda *args, **kwargs: {
            "id": settings.STRIPE_WEBHOOK_ENDPOINT_ID,
            "status": "enabled",
            "livemode": False,
            "url": f"{settings.CANONICAL_ORIGIN.rstrip('/')}/api/stripe/webhook/",
            "enabled_events": ["checkout.session.completed"],
        },
    ), patch("dj.apps.ztripe.views.webhook_is_ready", return_value=True):
        yield


@pytest.fixture(autouse=True)
def expire_invalid_session():
    """ expires a Session whose response fails our contract.

    Every rejection path below therefore reaches ``Session.expire``. Left
    unpatched that is a real outbound Stripe call from the test suite, so
    patch it here and let a test ask for the mock by name when it wants to
    assert containment actually happened.
    """
    with patch("dj.apps.ztripe.views.stripe.checkout.Session.expire") as expire:
        yield expire


@pytest.mark.django_db
def test_string_quantity_is_400_not_500(api_client, creator_factory):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    response = api_client.post(
        "/api/stripe/create-checkout-session/",
        {"quantity": "not-a-number"},
        format="json",
    )

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_zero_quantity_is_400(api_client, creator_factory):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    response = api_client.post(
        "/api/stripe/create-checkout-session/", {"quantity": 0}, format="json"
    )

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_absurd_quantity_is_rejected(api_client, creator_factory):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    response = api_client.post(
        "/api/stripe/create-checkout-session/",
        {"quantity": 10**12},
        format="json",
    )

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_fractional_quantity_is_rejected_without_creating_session(
    api_client, creator_factory
):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 1.9},
            format="json",
        )

    assert response.status_code == 400, response.content
    create.assert_not_called()


@pytest.mark.django_db
def test_checkout_requires_auth(api_client):
    response = api_client.post(
        "/api/stripe/create-checkout-session/", {"quantity": 1}, format="json"
    )
    assert response.status_code in (401, 403), response.content


@pytest.mark.django_db
def test_checkout_uses_exact_trusted_origin_for_stripe_return_urls(
    api_client, creator_factory, settings
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    settings.ALLOWED_HOSTS = ["localhost"]
    settings.CSRF_TRUSTED_ORIGINS = ["https://free2z.cash"]

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        _mock_checkout_session(create)
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": "/alice/dashboard/billing?ref=ok"},
            format="json",
            HTTP_HOST="localhost",
            HTTP_X_FORWARDED_PROTO="https",
            HTTP_ORIGIN="https://free2z.cash",
        )

    assert response.status_code == 200, response.content
    kwargs = create.call_args.kwargs
    assert kwargs["success_url"] == (
        "https://free2z.cash/alice/dashboard/billing?ref=ok"
    )
    assert kwargs["cancel_url"] == kwargs["success_url"]


@pytest.mark.django_db
def test_checkout_uses_canonical_origin_without_browser_origin(
    api_client, creator_factory, settings
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    settings.ALLOWED_HOSTS = ["localhost"]
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash"

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        _mock_checkout_session(create)
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": "/alice/dashboard/billing"},
            format="json",
            HTTP_HOST="localhost",
            HTTP_X_FORWARDED_PROTO="https",
        )

    assert response.status_code == 200, response.content
    kwargs = create.call_args.kwargs
    assert kwargs["success_url"] == (
        "https://stage.free2z.cash/alice/dashboard/billing"
    )
    assert kwargs["cancel_url"] == kwargs["success_url"]


@pytest.mark.django_db
def test_checkout_returns_required_session_id_and_hosted_url(
    api_client, creator_factory
):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        _mock_checkout_session(create)
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": "/buy"},
            format="json",
        )

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["id"] == "cs_test_checkout"
    assert body["url"] == CHECKOUT_URL
    # The server-owned quote  rides along; the URL contract must not
    # have replaced it.
    assert body["quote"]["tuzis"] == 100


@pytest.mark.django_db
def test_checkout_accepts_only_an_explicitly_configured_custom_domain(
    api_client, creator_factory, settings
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset({"checkout.free2z.cash"})
    custom_url = "https://checkout.free2z.cash/c/pay/cs_test_checkout"

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        _mock_checkout_session(create, url=custom_url)
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": "/buy"},
            format="json",
        )

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["id"] == "cs_test_checkout"
    assert body["url"] == custom_url
    assert body["quote"]["tuzis"] == 100


@pytest.mark.django_db
@pytest.mark.parametrize(
    "checkout_url",
    [
        "https://CHECKOUT.STRIPE.COM/c/pay/cs_test_checkout",
        "https://Checkout.Stripe.Com/c/pay/cs_test_checkout",
    ],
)
def test_checkout_accepts_case_variant_trusted_host(
    api_client, creator_factory, checkout_url
):
    """DNS hostnames are case-insensitive, so a case variant IS the trusted host.

    Negative control for the *other* direction: comparing ``parsed.netloc``
    (which preserves case) instead of ``parsed.hostname`` (which lowercases)
    would reject a legitimate Stripe response and take card checkout down.
    """
    user = creator_factory()
    api_client.force_authenticate(user=user)

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        _mock_checkout_session(create, url=checkout_url)
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": "/buy"},
            format="json",
        )

    assert response.status_code == 200, response.content
    assert response.json()["url"] == checkout_url


@pytest.mark.parametrize(
    "raw",
    [
        "",
        " ",
        ",",
        "checkout.stripe.com,",
        ",checkout.stripe.com",
        "checkout.stripe.com,,checkout.free2z.cash",
        "https://checkout.stripe.com",
        "checkout.stripe.com:443",
        "checkout.stripe.com/path",
        "user@checkout.stripe.com",
        "*.stripe.com",
    ],
)
def test_checkout_host_setting_rejects_malformed_or_empty_entries(raw, capsys):
    assert _parse_stripe_checkout_allowed_hosts(raw) == frozenset()
    assert "disabling Stripe Checkout" in capsys.readouterr().err


def test_checkout_host_setting_defaults_only_when_unset():
    assert _parse_stripe_checkout_allowed_hosts(None) == frozenset(
        {"checkout.stripe.com"}
    )
    assert _parse_stripe_checkout_allowed_hosts(
        " checkout.stripe.com,checkout.free2z.cash "
    ) == frozenset({"checkout.stripe.com", "checkout.free2z.cash"})


@pytest.mark.django_db
def test_empty_checkout_host_policy_fails_before_creating_provider_session(
    api_client, creator_factory, settings
):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset()

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": "/buy"},
            format="json",
        )

    # 500, not 503: a broken host policy is a real outage, and 503 on this
    # endpoint is reserved for the designed refusals.
    assert response.status_code == 500, response.content
    assert response.json() == {
        "error": "Card checkout is temporarily unavailable.",
        "code": "checkout_host_policy_unavailable",
    }
    create.assert_not_called()
    # Nor may it leave a  CheckoutIntent behind for a Session that was
    # never created.
    assert not CheckoutIntent.objects.exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "checkout_url",
    [
        None,
        "",
        "not-a-url",
        "http://checkout.stripe.com/c/pay/cs_test_checkout",
        "https://evil.example/c/pay/cs_test_checkout",
        "https://checkout.stripe.com.evil.example/c/pay/cs_test_checkout",
        "https://checkout.stripe.com@evil.example/c/pay/cs_test_checkout",
        "https://checkout.stripe.com:444/c/pay/cs_test_checkout",
        # An explicit:443 is origin-equivalent, but Stripe has never emitted
        # one and  already rejected any port. Keep the stricter rule:
        # on a money path an unexpected-but-equivalent form is still
        # unexpected, and nothing legitimate is lost.
        "https://checkout.stripe.com:443/c/pay/cs_test_checkout",
        # A bare origin is not a Checkout Session.
        "https://checkout.stripe.com/",
        # Scheme-relative: a browser resolves this against the *current* origin,
        # so it must never survive as a "checkout URL".
        "//checkout.stripe.com/c/pay/cs_test_checkout",
        # Non-navigational schemes must not reach window.location.assign().
        "javascript:alert(1)//checkout.stripe.com/c/pay/cs_test_checkout",
        "data:text/html,<script></script>",
        # Userinfo, even when the *host* is trusted: the trusted name in the
        # credential slot is exactly the shape that fools a human reading the
        # address bar, and there is no legitimate Stripe URL that carries it.
        "https://evil.example@checkout.stripe.com/c/pay/cs_test_checkout",
        # Trusted host parked in userinfo with a port, which defeats a naive
        # "split on the last colon" host extraction.
        "https://checkout.stripe.com:443@evil.example/c/pay/cs_test_checkout",
        # Backslash authority terminator: Python's urlsplit and the WHATWG URL
        # parser disagree about `\`, so this must fail closed.
        "https://checkout.stripe.com\\@evil.example/c/pay/cs_test_checkout",
        # Suffix/substring near-misses. These are the negative controls for
        # exact-set membership: any refactor to `endswith`/`in` on the string
        # turns each of these into an open redirect.
        "https://notcheckout.stripe.com/c/pay/cs_test_checkout",
        "https://evilcheckout.stripe.com/c/pay/cs_test_checkout",
        # Trailing-dot (fully qualified) form of a trusted host. DNS resolves
        # it to the same place, but it is not the configured exact string, and
        # fail-closed is the correct direction on a money path.
        "https://checkout.stripe.com./c/pay/cs_test_checkout",
        # Homograph: Cyrillic о in "com".
        "https://checkout.stripe.cоm/c/pay/cs_test_checkout",
        # Raw IP and IPv6 literals are never a Stripe Checkout host.
        "https://127.0.0.1/c/pay/cs_test_checkout",
        "https://[::1]/c/pay/cs_test_checkout",
    ],
)
def test_checkout_rejects_missing_malformed_or_untrusted_provider_url(
    api_client, creator_factory, checkout_url, expire_invalid_session
):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        _mock_checkout_session(create, url=checkout_url)
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": "/buy"},
            format="json",
        )

    assert response.status_code == 502, response.content
    assert response.json() == {
        "error": "Stripe returned an invalid checkout session.",
        "code": "stripe_invalid_session",
    }
    # 's containment must still run on the URL-rejection path: the
    # provider Session is expired and the intent is not left OPEN, so a
    # rejected redirect can never be fulfilled later.
    expire_invalid_session.assert_called_once_with(
        "cs_test_checkout",
        api_key=STRIPE_TEST_SECRET_KEY,
        max_network_retries=0,
    )
    intent = CheckoutIntent.objects.get()
    assert intent.state == CheckoutIntent.State.PROVIDER_FAILED
    assert intent.stripe_checkout_session_id is None


@pytest.mark.django_db
@pytest.mark.parametrize("session_id", [None, ""])
def test_checkout_rejects_missing_provider_session_id(
    api_client, creator_factory, session_id
):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        _mock_checkout_session(create, session_id=session_id)
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": "/buy"},
            format="json",
        )

    assert response.status_code == 502, response.content
    assert response.json() == {
        "error": "Stripe returned an invalid checkout session.",
        "code": "stripe_invalid_session",
    }


@pytest.mark.django_db
def test_checkout_rejects_provider_session_without_url_attribute(
    api_client, creator_factory
):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        create.return_value.id = "cs_test_checkout"
        del create.return_value.url
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": "/buy"},
            format="json",
        )

    assert response.status_code == 502, response.content
    assert response.json() == {
        "error": "Stripe returned an invalid checkout session.",
        "code": "stripe_invalid_session",
    }


@pytest.mark.django_db
@pytest.mark.parametrize(
    "return_path",
    ["https://evil.example/steal", "//evil.example/steal", "/safe#fragment"],
)
def test_checkout_rejects_unsafe_return_paths(
    api_client, creator_factory, return_path
):
    user = creator_factory()
    api_client.force_authenticate(user=user)

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "currentPath": return_path},
            format="json",
        )

    assert response.status_code == 400, response.content
    create.assert_not_called()
