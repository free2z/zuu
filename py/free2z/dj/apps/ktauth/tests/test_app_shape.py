"""What this app is allowed to be.

Small file, and every assertion in it is a boundary somebody could cross by
accident in a later change: adding a model, adding a second framework, loosening
the permission, moving the handle onto the request. The repo-wide guards in
``dj/apps/test_*.py`` cover the platform; this covers the ones specific to a
signing authority.
"""

from pathlib import Path

from django.apps import apps
from django.urls import get_resolver, reverse
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView

from dj.apps.ktauth import views
from dj.free2z.throttling import (
    AuthenticatedUserRateThrottle,
    HandleAssertionRateThrottle,
)

APP_DIR = Path(views.__file__).resolve().parent


def test_the_app_has_no_models_and_no_migrations():
    """Nothing here is persisted. An assertion is a signature over live state.

    A model would mean a table full of who asserted which key for which handle
    and when — a directory of exactly the metadata ``THREAT-MODEL.md`` §4.1
    bounds rather than removes, kept by the party the whole design assumes is
    the adversary. The log already publishes what is meant to be public.
    """
    assert not (APP_DIR / "models.py").exists()
    assert not (APP_DIR / "migrations").exists()
    assert apps.get_app_config("ktauth").models == {}


def test_the_endpoint_is_a_drf_view_that_spectacular_can_see():
    """``dj/apps/test_spec_coverage.py`` fails the gate on a non-DRF route.

    Pinned here as well so the reason is next to the code: a route
    drf-spectacular cannot see has no contract, no generated client, and
    nothing to detect a breaking change to it.
    """
    assert issubclass(views.HandleAssertionView, APIView)
    callback = _callback_for('kt_handle_assertion')
    assert hasattr(callback, "cls")
    assert issubclass(callback.cls, APIView)
    assert not callback.__module__.startswith("ninja")


def test_the_permission_is_declared_and_is_authenticated_only():
    assert views.HandleAssertionView.permission_classes == [IsAuthenticated]


def test_the_throttles_are_the_dedicated_bucket_plus_the_global_ceiling():
    assert views.HandleAssertionView.throttle_classes == [
        HandleAssertionRateThrottle,
        AuthenticatedUserRateThrottle,
    ]


def test_authentication_is_the_project_default():
    """Nothing custom, so the authentication inventory needs no exemption."""
    from rest_framework.settings import api_settings

    assert "authentication_classes" not in vars(views.HandleAssertionView)
    assert views.HandleAssertionView.authentication_classes == (
        api_settings.DEFAULT_AUTHENTICATION_CLASSES
    )


def test_the_view_never_reads_request_metadata():
    """Rule A of ``dj/apps/test_url_write_guard.py``, asserted at the source.

    That guard walks the AST for metadata reaching a *write*; this is stricter
    and narrower — the handle must come from ``request.user`` and there must be
    no other request-derived input at all, whether or not it reaches a write.
    """
    source = (APP_DIR / "views.py").read_text()
    body = source.split('"""', 2)[-1]  # skip the module docstring
    for forbidden in (
        "request.query_params",
        "request.GET",
        "request.headers",
        "request.COOKIES",
        "request.META",
        "request.get_host",
    ):
        assert forbidden not in body, f"{forbidden} must not reach this view"


def test_the_route_is_mounted_where_the_client_expects_it():
    assert reverse('kt_handle_assertion') == '/api/kt/handle-assertion/'


def _callback_for(name):
    for pattern in get_resolver().url_patterns:
        found = _find(pattern, name)
        if found is not None:
            return found
    raise AssertionError(f"{name} is not routed")


def _find(entry, name):
    if hasattr(entry, "url_patterns"):
        for child in entry.url_patterns:
            found = _find(child, name)
            if found is not None:
                return found
        return None
    return entry.callback if getattr(entry, "name", None) == name else None
