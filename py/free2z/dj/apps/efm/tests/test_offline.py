"""The EFM/FROST app is unrouted: nothing serves it over HTTP or WebSocket.

Taking an app offline by deleting route entries is exactly the kind of change
that silently comes back -- a merge resurrects an import, someone re-adds an
`include()` while debugging, a new project URLconf copies an old one. These
tests fail if any of that happens, which is the whole point:  (an
unauthenticated router where a `FrostGroup` UUID is enough to register as a
threshold signer) is *moot only while the app is unreachable*. Re-routing it
re-opens a real hole.

See `dj/apps/efm/__init__.py` for the full status note.
"""

import json

import pytest
from channels.routing import URLRouter
from django.core import checks
from django.test import Client
from django.urls import Resolver404, resolve

# Every path the ninja router defines, at the prefix it used to be mounted on.
EFM_HTTP_PATHS = [
    "/api/efm/start-group",
    "/api/efm/register-participant",
    "/api/efm/register-webauthn",
    "/api/efm/create-authentication-challenge",
    "/api/efm/authenticate-webauthn",
]

# The signalling consumer's route, as channels would see it (no leading slash).
EFM_WS_PATH = "ws/signaling/2b0d4d3e-0000-4000-8000-000000000000/"


@pytest.mark.parametrize("path", EFM_HTTP_PATHS)
def test_efm_http_paths_do_not_resolve(path):
    """Not merely 405/403 -- there is no view behind these at all."""
    with pytest.raises(Resolver404):
        resolve(path)


@pytest.mark.django_db
@pytest.mark.parametrize("path", EFM_HTTP_PATHS)
def test_efm_http_paths_return_404(path):
    """The same thing end to end, through the real middleware stack.

    Needs the DB because the middleware a real request passes through on its
    way to the 404 does.
    """
    response = Client().post(
        path, data=json.dumps({"max_participants": 3}),
        content_type="application/json",
    )
    assert response.status_code == 404, response.content


def _websocket_url_router(application):
    """Unwrap ProtocolTypeRouter -> AuthMiddlewareStack -> URLRouter."""
    node = application.application_mapping["websocket"]
    for _ in range(10):
        if isinstance(node, URLRouter):
            return node
        node = getattr(node, "inner", None)
        if node is None:
            break
    raise AssertionError("no URLRouter found under the websocket protocol")


def _assert_no_signaling_route(application):
    router = _websocket_url_router(application)
    for route in router.routes:
        assert route.resolve(EFM_WS_PATH) is None, (
            f"{route.pattern} still routes the EFM signalling socket"
        )


def test_free2z_asgi_has_no_signaling_route():
    from dj.free2z import asgi

    _assert_no_signaling_route(asgi.application)


def test_zuu_project_asgi_has_no_signaling_route():
    """The standalone open-source project mounted it too (dj/proj/free2z)."""
    from dj.proj.free2z import asgi as zuu_asgi

    _assert_no_signaling_route(zuu_asgi.application)


def test_zuu_project_urlconf_has_no_efm_routes():
    from dj.proj.free2z import urls as zuu_urls

    assert zuu_urls.urlpatterns == []


def test_webauthn_check_is_not_registered():
    """The relying-party config guards nothing while the app is unrouted.

    It emits `Error`s, so leaving it registered would make `manage.py check`
    -- CI, and every management command the deploy runs -- fail platform-wide
    the day someone tidies away the now-dead WEBAUTHN_* settings.
    """
    from dj.apps.efm.checks import check_webauthn_relying_party

    registered = checks.registry.registry.get_checks(include_deployment_checks=True)
    assert check_webauthn_relying_party not in registered


EFM_PACKAGE = "dj.apps.efm"

# The Django admin registers FrostGroup/Participant/WebAuthnChallenge at
# `adminzzz/efm/...`. That is deliberate and stays: it is staff-only, and it is
# how the retained data is looked at. Its URLResolvers carry a *list* of
# patterns as `urlconf_name`, never a `dj.apps.efm` module, so the detector
# below does not see them -- see `test_the_detector_ignores_the_admin`.


def _efm_http_offenders(patterns):
    """Every route that leads into `dj.apps.efm`, at any prefix.

    Checking `callback.__module__` alone is NOT enough and was the first
    version of this test: django-ninja wraps every operation in
    `ninja.operation.PathView._sync_view`, so a re-mount of the router at
    `/api/frost/` left the callbacks looking like ninja's own and the guard
    silently passed. The load-bearing signal is the URLResolver created by
    `include('dj.apps.efm.urls')`, whose `urlconf_name` is the efm module.
    """
    offenders = []
    for entry in patterns:
        sub = getattr(entry, "url_patterns", None)
        if sub is not None:
            urlconf = getattr(entry, "urlconf_name", None)
            name = getattr(urlconf, "__name__", None)
            if name is None and isinstance(urlconf, str):
                name = urlconf
            if isinstance(name, str) and name.startswith(EFM_PACKAGE):
                offenders.append(entry)
                continue
            offenders.extend(_efm_http_offenders(sub))
        elif getattr(entry.callback, "__module__", "").startswith(EFM_PACKAGE):
            offenders.append(entry)
    return offenders


def _targets_efm(callback):
    """`SignalingConsumer.as_asgi()` is a closure defined inside channels."""
    if getattr(callback, "__module__", "").startswith(EFM_PACKAGE):
        return True
    for cell in getattr(callback, "__closure__", None) or ():
        try:
            value = cell.cell_contents
        except ValueError:  # pragma: no cover - empty cell
            continue
        module = getattr(value, "__module__", "")
        if isinstance(module, str) and module.startswith(EFM_PACKAGE):
            return True
    return False


def test_no_url_in_the_project_routes_efm_at_any_prefix():
    """Prefix-independent: re-mounting the router at `/api/frost/` fails too.

    The path-by-path tests above would stay green if someone re-included the
    ninja router under a different prefix, which re-opens  just as
    thoroughly.
    """
    from django.urls import get_resolver

    offenders = _efm_http_offenders(get_resolver().url_patterns)
    assert offenders == [], f"EFM is routed: {offenders}"


def test_the_http_detector_actually_detects_a_remount():
    """Positive control -- otherwise the test above proves only that it is quiet.

    This is the exact evasion the first version of this guard missed.
    """
    from django.urls import include, path

    remounted = [path("api/frost/", include("dj.apps.efm.urls"))]
    assert _efm_http_offenders(remounted), "detector is blind to a re-mount"


def test_the_detector_ignores_the_admin():
    """The staff-only admin for the retained data is not a re-routing."""
    from django.contrib import admin

    assert _efm_http_offenders(admin.site.urls[0]) == []


def test_no_websocket_route_points_at_the_signaling_consumer():
    """Same reasoning for the socket: check the target, not the path."""
    from dj.free2z import asgi
    from dj.proj.free2z import asgi as zuu_asgi

    for application in (asgi.application, zuu_asgi.application):
        for route in _websocket_url_router(application).routes:
            assert not _targets_efm(route.callback), route


def test_the_websocket_detector_actually_detects_the_consumer():
    """Positive control for `_targets_efm`."""
    from dj.apps.efm.routing import websocket_urlpatterns

    assert websocket_urlpatterns, "efm routing.py lost its patterns"
    assert all(_targets_efm(r.callback) for r in websocket_urlpatterns)


def test_the_app_is_still_installed_and_its_models_still_exist():
    """Offline is a routing change, not a data change ( cleanup).

    If this fails, someone removed the app or its tables -- which is a much
    harder thing to undo than re-adding a route, and is not what was asked
    for.
    """
    from django.apps import apps as django_apps

    assert django_apps.is_installed("dj.apps.efm")
    model_names = {m.__name__ for m in django_apps.get_app_config("efm").get_models()}
    assert {"FrostGroup", "Participant", "WebAuthnChallenge"} <= model_names
