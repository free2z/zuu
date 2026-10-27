"""Structural guard: no view anywhere accepts a password in a header.

``REST_FRAMEWORK['DEFAULT_AUTHENTICATION_CLASSES']`` carried
``rest_framework.authentication.BasicAuthentication`` for years, so *every*
DRF view in the project also answered
``Authorization: Basic base64(username:password)``.

That is a complete parallel authentication path, and it is the one path that
never touched ``CreatorLoginSerializer`` -- the only code that checks reCAPTCHA
and the account's TOTP token. So an account with MFA enrolled was, on this
path, protected by its password alone: the second factor it had deliberately
turned on could not be reached, let alone required. It also reached
``POST /api/otp/setup/``, which at the time echoed the account's ACTIVE seed
back, promoting a leaked password to a permanent second-factor compromise.

The reason a *structural* test exists rather than one endpoint's regression
test: the vulnerability was never in a view. It was in a default, applying to
every view at once, including views written years later by people who never
read this file. So walk the live URLConf and assert the property for every
reachable view -- global default and per-view override alike -- the way
``test_permission_inventory.py`` does for the fail-closed permission default.

The companion facts asserted here:

* the two remaining authenticators are exactly session and Knox;
* drf-spectacular's ``AUTHENTICATION_WHITELIST`` mirrors the runtime list, so
  the published contract and the server agree;
* the committed ``f2z.yaml`` no longer advertises ``basicAuth`` to generated
  clients.
* ``rest_framework.authtoken`` stays uninstalled, and no view wires DRF's
  ``TokenAuthentication`` back in per-view.

What this file does NOT claim: that holding a session or a Knox token implies
the second factor was checked. Only ``/api/auth/login/`` runs
``CreatorLoginSerializer`` and its reCAPTCHA check. The alternate session and
Knox issuers use the shared TOTP gate covered by the  regression suite;
this structural inventory does not prove those behavioral checks.

MECHANICAL NOTE, learned the hard way: resolve the URLConf INSIDE test
functions, never in a ``@pytest.mark.parametrize`` argument. Parametrize
arguments are evaluated at collection time, which is before pytest-django's
``django_test_environment`` fixture forces ``settings.DEBUG = False`` -- so it
imports ``dj/free2z/urls.py`` while DEBUG is still True, and that module
appends a ``static('uploadz/')`` pattern under DEBUG. The urlpatterns list is
then permanently wrong for the whole session, and
``test_crawler_patterns_are_last_in_the_urlconf`` fails several thousand tests
later with no visible connection to this file.
"""
from pathlib import Path

import pytest
from django.conf import settings
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.authentication import (
    BaseAuthentication,
    BasicAuthentication,
    SessionAuthentication,
)
from rest_framework.views import APIView


# Any authenticator that takes a raw password out of the request is a login,
# and logins belong at /api/auth/login/ where the second factor is checked.
FORBIDDEN_AUTHENTICATORS = (BasicAuthentication,)

FORBIDDEN_AUTHENTICATOR_PATHS = (
    "rest_framework.authentication.BasicAuthentication",
    "rest_framework.authentication.RemoteUserAuthentication",
)

REPO_ROOT = Path(__file__).resolve().parents[4]


def _iter_view_classes():
    """Yield (route, view_class) for every pattern in the root URLconf."""
    seen = set()

    def walk(resolver, prefix=""):
        for pattern in resolver.url_patterns:
            if isinstance(pattern, URLResolver):
                yield from walk(pattern, prefix + str(pattern.pattern))
            elif isinstance(pattern, URLPattern):
                yield prefix + str(pattern.pattern), pattern.callback

    for route, callback in walk(get_resolver()):
        cls = getattr(callback, "cls", None) or getattr(
            callback, "view_class", None
        )
        if cls is None:
            continue
        key = (cls.__module__, cls.__qualname__, route)
        if key in seen:
            continue
        seen.add(key)
        yield route, cls


def _drf_views():
    return [
        (route, cls)
        for route, cls in _iter_view_classes()
        if isinstance(cls, type) and issubclass(cls, APIView)
    ]


def test_urlconf_exposes_drf_views():
    """Sanity check: the walker must actually find views to police."""
    assert len(_drf_views()) > 50


def test_global_default_authentication_never_accepts_a_password():
    configured = settings.REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"]
    for forbidden in FORBIDDEN_AUTHENTICATOR_PATHS:
        assert forbidden not in configured, (
            f"{forbidden} is back in DEFAULT_AUTHENTICATION_CLASSES. It "
            "authenticates on username+password alone, which bypasses the "
            "reCAPTCHA and TOTP checks that only CreatorLoginSerializer "
            "performs -- see #1048."
        )


def test_global_default_authentication_is_exactly_session_knox_and_oauth():
    """Three authenticators, and the Knox one is the project's own subclass.

    ``AccountEpochTokenAuthentication`` is knox's, plus the use-time
    account-epoch check that refuses a bearer token the account has outlived
    . The equality is pinned on the string path deliberately: a change
    that dropped back to stock ``knox.auth.TokenAuthentication`` would restore
    the concurrent-issuance hole with no other visible symptom, and the
    subclass relationship alone would not catch it.

    ``OAuth2JWTAuthentication``  is the third: an ES256 access token
    issued by ``dj.apps.oidc``. It is listed globally AND is default-deny --
    the two tests after this one pin that a view which never declared
    ``required_scopes`` refuses every OAuth token, which is what makes a
    global listing safe.
    """
    assert settings.REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"] == [
        "rest_framework.authentication.SessionAuthentication",
        "dj.apps.ktauth.authentication.AccountEpochTokenAuthentication",
        "dj.apps.oidc.authentication.OAuth2JWTAuthentication",
    ]


def test_the_oauth_authenticator_is_default_deny_by_construction():
    """The refusal is in ``authenticate`` itself, before any token is parsed.

    Asserted on a synthetic request against a view with no
    ``required_scopes`` and a syntactically valid-looking bearer, so the
    property holds whatever the token is: the view never opted in, so no
    token can open it.
    """
    from rest_framework import exceptions
    from rest_framework.request import Request
    from rest_framework.test import APIRequestFactory
    from rest_framework.views import APIView

    from dj.apps.oidc.authentication import OAuth2JWTAuthentication

    class Undeclared(APIView):
        permission_classes = []

    factory = APIRequestFactory()
    request = Request(factory.get("/", HTTP_AUTHORIZATION="Bearer eyJ.eyJ.sig"))
    request.parser_context = {"view": Undeclared()}
    with pytest.raises(exceptions.AuthenticationFailed) as excinfo:
        OAuth2JWTAuthentication().authenticate(request)
    assert excinfo.value.get_codes() == "oauth_not_accepted"
    # Negative control: without a bearer it steps aside for the other
    # authenticators rather than refusing the request.
    quiet = Request(factory.get("/"))
    quiet.parser_context = {"view": Undeclared()}
    assert OAuth2JWTAuthentication().authenticate(quiet) is None


def test_no_reachable_view_opens_itself_to_oauth_without_scopes():
    """A view that lists ``required_scopes`` must list real, non-empty scopes.

    An empty list would mean "any OAuth token", which no endpoint here may
    say; an unknown scope would be one no token can ever carry, i.e. a view
    that looks OAuth-enabled and is not.
    """
    from dj.apps.oidc.scopes import ALL_SCOPES

    offenders = sorted(
        f"{view.__module__}.{view.__qualname__} (at /{route}) declares "
        f"required_scopes={getattr(view, 'required_scopes', None)!r}"
        for route, view in _drf_views()
        if hasattr(view, "required_scopes")
        and (
            not list(view.required_scopes)
            or not set(view.required_scopes) <= set(ALL_SCOPES)
        )
    )
    assert not offenders, "\n  ".join(["bad required_scopes:", *offenders])


def test_the_project_knox_authenticator_enforces_the_account_epoch():
    """The subclass must actually be knox's, and must override the hook.

    Both halves matter. Losing the base class silently drops the digest
    comparison and the expiry sweep; losing the override silently drops the
    revocation and leaves a class whose name still promises it.
    """
    from knox.auth import TokenAuthentication

    from dj.apps.ktauth.authentication import AccountEpochTokenAuthentication

    assert issubclass(AccountEpochTokenAuthentication, TokenAuthentication)
    assert (
        AccountEpochTokenAuthentication.validate_user
        is not TokenAuthentication.validate_user
    )


def test_spectacular_whitelist_mirrors_the_runtime_authenticators():
    """A spec that advertises an authenticator the server dropped is a lie."""
    assert list(settings.SPECTACULAR_SETTINGS["AUTHENTICATION_WHITELIST"]) == list(
        settings.REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"]
    )


def test_committed_openapi_spec_does_not_advertise_basic_auth():
    spec = (REPO_ROOT / "py/free2z/dj/free2z/openapi/f2z.yaml").read_text(encoding="utf-8")
    # Compare a bool, not the string: pytest would otherwise print the whole
    # 9000-line spec into the failure report.
    advertises_basic_auth = "basicAuth" in spec
    assert advertises_basic_auth is False, (
        "f2z.yaml still publishes the basicAuth security scheme; regenerate "
        "it with ./bin/gen-openapi.sh after changing the authentication "
        "classes."
    )


def test_no_reachable_view_accepts_basic_authentication():
    """Covers per-view overrides, not just the global default.

    A view may legitimately set ``authentication_classes``; what it may not do
    is put a password-in-a-header authenticator in that list. This is the test
    that would catch someone "fixing" a broken integration by re-adding Basic
    to the one endpoint that integration calls.
    """
    offenders = sorted(
        f"{view.__module__}.{view.__qualname__} (at /{route}) accepts "
        f"{authenticator.__name__}"
        for route, view in _drf_views()
        for authenticator in view.authentication_classes
        if isinstance(authenticator, type)
        and issubclass(authenticator, FORBIDDEN_AUTHENTICATORS)
    )
    assert not offenders, (
        "These views authenticate on a password carried in a request header, "
        "which bypasses the reCAPTCHA and TOTP checks that only "
        "CreatorLoginSerializer performs (#1048). Use a Knox token from "
        "/api/auth/login/ instead.\n  " + "\n  ".join(offenders)
    )


def test_every_declared_authenticator_is_a_real_authenticator():
    """Cheap typo guard, in the spirit of the ``permissions`` trap in.

    A misspelled or non-authenticator entry either explodes at request time or
    is silently inert; both are worse than failing here.
    """
    offenders = sorted(
        f"{view.__module__}.{view.__qualname__} (at /{route}) lists "
        f"{authenticator!r}"
        for route, view in _drf_views()
        for authenticator in view.authentication_classes
        if not (
            isinstance(authenticator, type)
            and issubclass(authenticator, BaseAuthentication)
        )
    )
    assert not offenders, (
        "These entries in `authentication_classes` are not DRF authentication "
        "classes.\n  " + "\n  ".join(offenders)
    )


def test_no_reachable_view_uses_stock_knox_authentication():
    """The per-view override is how a revoked credential keeps one door open.

    ``AccountEpochTokenAuthentication`` refuses a bearer token the account has
    outlived. It is the global default, so the *only* way to get the
    unchecked behaviour is a per-view ``authentication_classes`` naming knox's
    class directly — which is not hypothetical: ``knox.views.LogoutView`` and
    ``LogoutAllView`` both ship exactly that line, and both are routed here.
    Each is overridden in ``dj/free2z/urls.py``; this test is what notices when
    a third one arrives, from a knox upgrade or from a view written by someone
    who copied the pattern.

    Same shape and same reason as the Basic-auth guard above: the defect is
    never in a view, it is in one line that reintroduces a parallel path.
    """
    from knox.auth import TokenAuthentication as StockKnoxAuthentication

    from dj.apps.ktauth.authentication import AccountEpochTokenAuthentication

    offenders = sorted(
        f"{view.__module__}.{view.__qualname__} (at /{route})"
        for route, view in _drf_views()
        for authenticator in view.authentication_classes
        if isinstance(authenticator, type)
        and issubclass(authenticator, StockKnoxAuthentication)
        and not issubclass(authenticator, AccountEpochTokenAuthentication)
    )
    assert not offenders, (
        "These views authenticate Knox tokens WITHOUT the account-epoch check, "
        "so a bearer token an ownership event revoked still reaches them "
        "(#1570). Subclass the view and set `authentication_classes` to the "
        "project default (see LogoutAllView in dj/free2z/urls.py), routing it "
        "above the knox include.\n  " + "\n  ".join(offenders)
    )


def test_session_authentication_is_still_available():
    """Guard the other direction: the SPA must keep working."""
    assert any(
        authenticator is SessionAuthentication
        for _route, view in _drf_views()
        for authenticator in view.authentication_classes
    )


def test_drf_authtoken_stays_uninstalled():
    """``rest_framework.authtoken`` is gone for good.

    Until  dj-rest-auth minted a permanent, never-rotated key in it on
    every password login. g12f migration 0113 purged every row and detached
    the table from Creator. Reinstalling the app would bring back a model
    whose table still exists on prod with no foreign key -- and, the moment
    someone also wired its authenticator in, a credential family that
    ``ktauth.epoch`` no longer revokes on a password change.
    """
    assert "rest_framework.authtoken" not in settings.INSTALLED_APPS
    assert settings.REST_AUTH["TOKEN_MODEL"] is None


def test_no_reachable_view_uses_drf_token_authentication():
    """The per-view half of the check above, same shape as the Basic guard.

    ``rest_framework.authentication.TokenAuthentication`` looks keys up in the
    uninstalled ``authtoken`` model. Globally it is excluded by the equality
    test above; this catches the one-endpoint override that equality cannot
    see, which is how a dormant credential becomes a live one.
    """
    from rest_framework.authentication import TokenAuthentication

    offenders = sorted(
        f"{view.__module__}.{view.__qualname__} (at /{route})"
        for route, view in _drf_views()
        for authenticator in view.authentication_classes
        if isinstance(authenticator, type)
        and issubclass(authenticator, TokenAuthentication)
    )
    assert not offenders, (
        "These views authenticate with DRF's TokenAuthentication, whose model "
        "(rest_framework.authtoken) was purged and uninstalled in #2209. Use "
        "the project's Knox authenticator instead.\n  " + "\n  ".join(offenders)
    )
