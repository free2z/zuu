"""Deployed Django cookies must be transport-bound at the issuer."""

import runpy

import pytest
from django.conf import global_settings
from django.contrib.sessions.middleware import SessionMiddleware
from django.http import HttpResponse
from django.middleware.csrf import CsrfViewMiddleware, get_token
from django.test import RequestFactory, override_settings


@pytest.mark.parametrize("localdev", [False, True])
@pytest.mark.parametrize("secure_request", [False, True])
def test_deployment_cookie_transport(localdev, secure_request, monkeypatch):
    # Import the actual deployment settings without connecting to a database
    # or replacing pytest's configured settings module. All values are fixtures.
    monkeypatch.setenv("DBPASS", "unused-test-value")
    monkeypatch.delenv("DB_POOLER_NAMESPACES", raising=False)
    monkeypatch.delenv("DB_POOLER_BYPASS", raising=False)
    if localdev:
        monkeypatch.setenv("LOCALDEV", "1")
    else:
        monkeypatch.delenv("LOCALDEV", raising=False)
    deployed = runpy.run_module("dj.free2z.prod_settings")
    names = ("SESSION_COOKIE_SECURE", "CSRF_COOKIE_SECURE")
    cookie_settings = {
        name: deployed.get(name, getattr(global_settings, name))
        for name in names
    }

    def issue_cookies(request):
        request.session["test-session"] = "established"
        get_token(request)
        return HttpResponse("ok")

    # Signed-cookie storage exercises Django's real issuing middleware without
    # a database. HTTP here also models the internal TLS-terminated proxy hop:
    # public deployment flags must not depend on request.is_secure().
    with override_settings(
        **cookie_settings,
        SESSION_ENGINE="django.contrib.sessions.backends.signed_cookies",
    ):
        response = SessionMiddleware(CsrfViewMiddleware(issue_cookies))(
            RequestFactory().get("/", secure=secure_request),
        )

    session = response.cookies["sessionid"]
    csrf = response.cookies["csrftoken"]
    assert bool(session["secure"]) is not localdev
    assert bool(csrf["secure"]) is not localdev
    assert session["httponly"]
    # Browser API requests read the CSRF token; it is not an auth credential.
    assert not csrf["httponly"]
    assert session["samesite"] == csrf["samesite"] == "Lax"
    assert session["domain"] == csrf["domain"] == ""
