"""Structural guard: every route under ``/api/sdk/v1/`` answers errors in the
spec envelope (zuu errors.md §1, ).

The envelope comes from ``SdkAPIView.get_exception_handler``, so it holds
exactly as far as the views subclass it. A new SDK endpoint written as a
plain ``APIView`` (or a function view) would silently answer DRF's
``{"detail":...}`` to every SDK client; this walks the URLconf so it cannot.
The unknown-path catch-all must stay LAST, or it swallows real endpoints.

Resolve inside the test, never at collection time (see
``test_authentication_inventory.py`` for why).
"""
from django.urls import URLPattern, URLResolver, get_resolver

from dj.free2z.sdk_api import SdkAPIView, SdkNotFoundView

SDK_ROUTE = "api/sdk/v1/"


def _sdk_patterns():
    for pattern in get_resolver().url_patterns:
        if isinstance(pattern, URLResolver) and str(pattern.pattern) == SDK_ROUTE:
            flat = []

            def walk(resolver, prefix=""):
                for inner in resolver.url_patterns:
                    if isinstance(inner, URLResolver):
                        walk(inner, prefix + str(inner.pattern))
                    else:
                        flat.append((prefix + str(inner.pattern), inner))

            walk(pattern)
            return flat
    raise AssertionError(f"{SDK_ROUTE} is not mounted")


def _view_class(pattern: URLPattern):
    callback = pattern.callback
    return getattr(callback, "cls", None) or getattr(callback, "view_class", None)


def test_every_sdk_view_uses_the_envelope():
    offenders = [
        (route, pattern.callback)
        for route, pattern in _sdk_patterns()
        if not (isinstance(_view_class(pattern), type) and issubclass(_view_class(pattern), SdkAPIView))
    ]
    assert not offenders, f"not SdkAPIView subclasses: {offenders}"


def test_the_catch_all_is_last_and_only_last():
    patterns = _sdk_patterns()
    assert _view_class(patterns[-1][1]) is SdkNotFoundView
    assert all(_view_class(p) is not SdkNotFoundView for _, p in patterns[:-1])
    assert len(patterns) >= 3  # the purchase routes are reachable before it


def test_the_envelope_is_not_the_project_default():
    from django.conf import settings

    assert "sdk" not in settings.REST_FRAMEWORK["EXCEPTION_HANDLER"]


# --------------------------------------------------------------- CORS
import pytest  # noqa: E402

SDK_ORIGIN = "https://tutor.example.org"  # a third-party browser app
SAME_SITE_ORIGIN = "https://stage.free2z.cash"  # same SITE as prod, a different origin


@pytest.fixture
def same_site_app(creator_factory):
    """A registered browser app. Stripping credentials under the SDK prefix
    is the SECOND fence: a same-site origin cannot register at
    all (see ``legacy_same_site_app``), so this is an ordinary third-party
    origin and the header must still never be sent to it."""
    from dj.apps.oidc.models import F2ZApplication

    return F2ZApplication.objects.create(
        name="SDK browser app",
        user=creator_factory(username="same-site-dev"),
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://tutor.example.org/cb",
        allowed_origins=SDK_ORIGIN,
        allowed_scopes="openid purchase:create",
    )


@pytest.fixture
def legacy_same_site_app(creator_factory):
    """The reviewer's case from: a row registering a SAME-SITE origin.
    ``save()`` refuses it now, so it is written the way a row that
    predates the check would exist -- past ``clean()``."""
    from dj.apps.oidc.models import F2ZApplication

    app = F2ZApplication(
        name="Same site",
        user=creator_factory(username="legacy-same-site-dev"),
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://stage.free2z.cash/cb",
        allowed_origins=SAME_SITE_ORIGIN,
        allowed_scopes="openid purchase:create",
    )
    F2ZApplication.objects.bulk_create([app])
    return app


@pytest.mark.django_db
def test_a_same_site_origin_cannot_register(creator_factory):
    from django.core.exceptions import ValidationError

    from dj.apps.oidc.models import F2ZApplication

    with pytest.raises(ValidationError) as caught:
        F2ZApplication.objects.create(
            name="Same site",
            user=creator_factory(username="same-site-registrant"),
            client_type=F2ZApplication.CLIENT_PUBLIC,
            redirect_uris="https://stage.free2z.cash/cb",
            allowed_origins=SAME_SITE_ORIGIN,
        )
    assert "allowed_origins" in caught.value.message_dict


@pytest.mark.django_db
@pytest.mark.parametrize("path", ["/api/oauth/token", "/api/oauth/userinfo", "/api/sdk/v1/purchases"])
def test_a_same_site_origin_gets_no_cors_even_if_registered(legacy_same_site_app, path):
    """: ``_cors_allowed`` refuses a same-site origin per request, so a
    row that predates the registration check never gets CORS -- on the
    OAuth paths (which keep credentialed CORS) as well as the SDK's.
    NEGATIVE CONTROL: dropping the ``is_same_site_origin`` check in
    ``cors.origin_is_registered`` turns every case red."""
    from rest_framework.test import APIClient

    preflight = APIClient().options(
        path, HTTP_ORIGIN=SAME_SITE_ORIGIN,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
    )
    assert not preflight.has_header("Access-Control-Allow-Origin")
    assert not preflight.has_header("Access-Control-Allow-Credentials")


@pytest.mark.django_db
def test_sdk_cors_never_allows_credentials(same_site_app, creator_factory):
    from rest_framework.test import APIClient

    preflight = APIClient().options(
        "/api/sdk/v1/purchases",
        HTTP_ORIGIN=SDK_ORIGIN,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS="authorization, idempotency-key, content-type",
    )
    # The origin and the bearer header ARE allowed...
    assert preflight["Access-Control-Allow-Origin"] == SDK_ORIGIN
    assert "authorization" in preflight["Access-Control-Allow-Headers"]
    #...credentials are not, so the browser never sends or exposes cookies.
    assert not preflight.has_header("Access-Control-Allow-Credentials")

    # The actual response too -- here with a live session, the attack's shape.
    client = APIClient()
    client.force_login(creator_factory())
    actual = client.get(
        "/api/sdk/v1/purchases/00000000-0000-4000-8000-000000000000",
        HTTP_ORIGIN=SDK_ORIGIN,
    )
    assert actual["Access-Control-Allow-Origin"] == SDK_ORIGIN
    assert not actual.has_header("Access-Control-Allow-Credentials")
    assert "Retry-After" in actual["Access-Control-Expose-Headers"]


@pytest.mark.django_db
def test_credentials_are_untouched_outside_the_sdk_prefix(same_site_app):
    """Scope: the first-party SPA's credentialed CORS is unchanged."""
    from django.conf import settings
    from rest_framework.test import APIClient

    first_party = settings.CORS_ORIGIN_WHITELIST[0]
    response = APIClient().options(
        "/api/auth/user/", HTTP_ORIGIN=first_party,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET",
    )
    assert response["Access-Control-Allow-Credentials"] == "true"
    token = APIClient().options(
        "/api/oauth/token", HTTP_ORIGIN=SDK_ORIGIN,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
    )
    assert token["Access-Control-Allow-Origin"] == SDK_ORIGIN
