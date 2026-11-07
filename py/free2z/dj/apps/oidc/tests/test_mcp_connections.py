"""Real OAuth, account linking and revocation boundaries for hosted MCP."""
from datetime import timedelta
import hashlib
from urllib.parse import parse_qs, urlsplit

import pytest
from django.utils import timezone
from rest_framework.exceptions import APIException
from rest_framework.test import APIClient

from dj.apps.oidc.authentication import verify_bearer
from dj.apps.oidc.consent import revoke_authorization
from dj.apps.oidc.mcp import authenticate_mcp, authorized_actor, create_link_intent, list_accounts
from dj.apps.oidc.models import F2ZApplication, MCPAccountGrant, MCPConnection, MCPLinkIntent
from dj.apps.oidc.scopes import MCP_SCOPES, mcp_resource
from .conftest import Flow, WEB_REDIRECT, form_post, query_of

pytestmark = pytest.mark.django_db
SCOPES = " ".join((*MCP_SCOPES, "offline_access"))


def register():
    result = APIClient().post("/api/oauth/register", {
        "client_name": "Desktop Agent", "redirect_uris": [WEB_REDIRECT],
        "token_endpoint_auth_method": "none", "scope": SCOPES,
    }, format="json")
    assert result.status_code == 201, result.content
    return F2ZApplication.objects.get(client_id=result.json()["client_id"])


def issue(signed_in, user, app=None):
    app = app or register()
    flow = Flow(signed_in, user, app, redirect_uri=WEB_REDIRECT, scope=SCOPES)
    code = flow.authorize(resource=mcp_resource())
    result = flow.exchange(code, extra={"resource": mcp_resource()})
    assert result.status_code == 200, result.content
    return app, flow, result.json()


def link(token, target, *, scopes=None):
    intent = create_link_intent(token, target.username, scopes)
    assert not urlsplit(intent["url"]).query
    opaque = parse_qs(urlsplit(intent["url"]).fragment)["intent"][0]
    client = APIClient()
    client.force_login(target)
    result = client.post("/api/oauth/mcp/link/", {"intent": opaque, "allow": True, **({"scopes": scopes} if scopes else {})}, format="json")
    assert result.status_code == 200, result.content
    return result.json()["account"], opaque


def test_registration_pkce_resource_connection_refresh_and_issuer(signed_in, user):
    app, flow, tokens = issue(signed_in, user)
    token = tokens["access_token"]
    primary = authenticate_mcp(token)
    assert primary.user_id == user.pk
    assert list_accounts(token)[0]["username"] == user.username
    assert list_accounts(token)[0]["available"]
    connection = MCPConnection.objects.get(pk=primary.connection_id)
    assert connection.primary_user_id == user.pk
    assert connection.application == app
    _, _, claims = verify_bearer(token, audience=mcp_resource())
    assert claims["mcp_connection"] == str(primary.connection_id)
    assert mcp_resource() in claims["aud"]
    refreshed = form_post(APIClient(), "/api/oauth/token", {
        "grant_type": "refresh_token", "client_id": app.client_id,
        "refresh_token": tokens["refresh_token"], "resource": mcp_resource(),
    })
    assert refreshed.status_code == 200, refreshed.content
    assert authenticate_mcp(refreshed.json()["access_token"]).connection_id == primary.connection_id
    # Each new code is an independent connection even for the same user/client.
    _, _, another = issue(signed_in, user, app)
    assert authenticate_mcp(another["access_token"]).connection_id != primary.connection_id
    evaluated = flow.evaluate(resource=mcp_resource()).json()
    assert evaluated["action"] == "consent"
    assert evaluated["consent"]["signed_in_username"] == user.username
    denied = flow.decide(evaluated, allow=False).json()
    from django.conf import settings
    assert query_of(denied["redirect_to"])["iss"] == settings.OIDC_ISSUER


def test_wrong_resource_never_issues_or_refreshes(signed_in, user):
    app = register()
    flow = Flow(signed_in, user, app, redirect_uri=WEB_REDIRECT, scope=SCOPES)
    for resource in (None, "https://attacker.example/mcp"):
        evaluated = flow.evaluate(resource=resource).json()
        assert evaluated["action"] == "redirect"
        assert query_of(evaluated["redirect_to"])["error"] == "invalid_target"
    code = flow.authorize(resource=mcp_resource())
    wrong = flow.exchange(code, extra={"resource": "https://attacker.example/mcp"})
    assert wrong.status_code == 400
    valid = flow.exchange(code, extra={"resource": mcp_resource()})
    assert valid.status_code == 200, valid.content
    tokens = valid.json()
    wrong = form_post(APIClient(), "/api/oauth/token", {
        "grant_type": "refresh_token", "client_id": app.client_id,
        "refresh_token": tokens["refresh_token"], "resource": "https://attacker.example/mcp",
    })
    assert wrong.status_code == 400


def test_linking_exact_account_scope_isolation_one_use_and_target_revocation(signed_in, user, creator_factory):
    app, _, tokens = issue(signed_in, user)
    token = tokens["access_token"]
    target = creator_factory(username="baz")
    pending = create_link_intent(token, "baz", ["mcp:read"])
    opaque = parse_qs(urlsplit(pending["url"]).fragment)["intent"][0]
    wrong = signed_in.post("/api/oauth/mcp/link/", {"intent": opaque, "allow": True}, format="json")
    assert wrong.status_code == 403
    assert MCPLinkIntent.objects.get(pk=hashlib.sha256(opaque.encode()).hexdigest()).used_at is None
    target_client = APIClient()
    target_client.force_login(target)
    evaluation = target_client.post("/api/oauth/mcp/link/evaluate/", {"intent": opaque}, format="json")
    assert evaluation.status_code == 200, evaluation.content
    assert evaluation.json()["expected_username"] == "baz"
    assert evaluation.json()["connection"]["primary_username"] == user.username
    result = target_client.post("/api/oauth/mcp/link/", {"intent": opaque, "allow": True}, format="json")
    assert result.status_code == 200, result.content
    grant_id = result.json()["account"]["id"]
    assert target_client.post("/api/oauth/mcp/link/", {"intent": opaque, "allow": True}, format="json").status_code == 400
    with authorized_actor(token, "baz", ["mcp:read"]) as actor:
        assert actor.user.pk == target.pk
        assert actor.scopes == {"mcp:read"}
    with pytest.raises(APIException):
        with authorized_actor(token, "baz", ["mcp:write"]):
            pytest.fail("target grant widened")
    # A second connection of the same app cannot inherit the first's accounts.
    _, _, another = issue(signed_in, user, app)
    with pytest.raises(APIException):
        with authorized_actor(another["access_token"], grant_id, ["mcp:read"]):
            pytest.fail("connection boundary crossed")
    revoked = target_client.delete(f"/api/oauth/mcp/grants/{grant_id}/")
    assert revoked.status_code == 204
    with pytest.raises(APIException):
        with authorized_actor(token, "baz", ["mcp:read"]):
            pytest.fail("target revoke ignored")
    with authorized_actor(token, user.username, ["mcp:write"]) as actor:
        assert actor.user.pk == user.pk


def test_primary_revoke_and_target_epoch_disable_linked_access(signed_in, user, creator_factory):
    app, _, tokens = issue(signed_in, user)
    target = creator_factory(username="target")
    link(tokens["access_token"], target)
    type(target).objects.filter(pk=target.pk).update(kt_account_epoch=target.kt_account_epoch + 1)
    with pytest.raises(APIException):
        with authorized_actor(tokens["access_token"], target.username, ["mcp:read"]):
            pytest.fail("stale target epoch admitted")
    revoke_authorization(user, app)
    with pytest.raises(APIException):
        authenticate_mcp(tokens["access_token"])


def test_link_expiry_and_scope_escalation_are_refused(signed_in, user, creator_factory):
    _, _, tokens = issue(signed_in, user)
    target = creator_factory(username="target")
    intent = create_link_intent(tokens["access_token"], target.username, ["mcp:read"])
    opaque = parse_qs(urlsplit(intent["url"]).fragment)["intent"][0]
    client = APIClient(); client.force_login(target)
    rejected = client.post("/api/oauth/mcp/link/", {"intent": opaque, "allow": True, "scopes": ["mcp:publish"]}, format="json")
    assert rejected.status_code == 403
    row = MCPLinkIntent.objects.get(token_hash=hashlib.sha256(opaque.encode()).hexdigest())
    assert row.used_at is None
    row.expires_at = timezone.now() - timedelta(seconds=1); row.save(update_fields=["expires_at"])
    assert client.post("/api/oauth/mcp/link/", {"intent": opaque, "allow": True}, format="json").status_code == 400


def test_registration_rejects_privileged_scopes_and_bad_redirects():
    client = APIClient()
    for payload in (
        {"redirect_uris": [WEB_REDIRECT], "scope": "ai:invoke"},
        {"redirect_uris": ["https://app.example/*"]},
        {"redirect_uris": ["http://evil.example/callback"]},
    ):
        response = client.post("/api/oauth/register", payload, format="json")
        assert response.status_code == 400, response.content
    response = client.post("/api/oauth/register", {"redirect_uris": [WEB_REDIRECT], "client_name": "Free2Z official"}, format="json")
    assert response.status_code == 400
    assert client.post("/api/oauth/register", "x" * 16385, content_type="application/json").status_code == 413


def test_browser_logout_switch_and_expired_access_cleanup_preserve_connection(signed_in, user, creator_factory):
    from django.conf import settings
    from oauth2_provider.models import clear_expired
    from dj.apps.oidc.models import AccessToken
    app, _, tokens = issue(signed_in, user)
    original = authenticate_mcp(tokens["access_token"]).connection_id
    assert signed_in.post("/api/auth/logout/").status_code == 200
    signed_in.force_login(creator_factory(username="another-browser-account"))
    with authorized_actor(tokens["access_token"], user.username, ["mcp:read"]) as actor:
        assert actor.user.pk == user.pk
    # Database expiry cleanup retains the access row anchoring a live refresh.
    AccessToken.objects.filter(token=tokens["access_token"]).update(expires=timezone.now() - timedelta(seconds=1))
    clear_expired()
    refreshed = form_post(APIClient(), "/api/oauth/token", {
        "grant_type": "refresh_token", "client_id": app.client_id,
        "refresh_token": tokens["refresh_token"], "resource": mcp_resource(),
    })
    assert refreshed.status_code == 200, refreshed.content
    assert authenticate_mcp(refreshed.json()["access_token"]).connection_id == original


def test_link_requires_csrf_and_accounts_are_private(signed_in, user, creator_factory):
    _, _, tokens = issue(signed_in, user)
    target = creator_factory(username="target")
    pending = create_link_intent(tokens["access_token"], target.username)
    opaque = parse_qs(urlsplit(pending["url"]).fragment)["intent"][0]
    browser = APIClient(enforce_csrf_checks=True); browser.force_login(target)
    assert browser.post("/api/oauth/mcp/link/", {"intent": opaque, "allow": True}, format="json").status_code == 403
    anonymous = APIClient()
    assert anonymous.get("/api/oauth/mcp/connections/").status_code in {401, 403}
    assert anonymous.get("/api/oauth/mcp/link/?intent=" + opaque).status_code in {401, 403, 405}


@pytest.mark.parametrize("declared", ["client_secret_basic", "client_secret_post"])
def test_confidential_registration_enforces_declared_auth_method(signed_in, user, declared):
    import base64
    response = APIClient().post("/api/oauth/register", {
        "redirect_uris": [WEB_REDIRECT], "token_endpoint_auth_method": declared,
        "scope": SCOPES,
    }, format="json")
    assert response.status_code == 201, response.content
    registration = response.json()
    app = F2ZApplication.objects.get(client_id=registration["client_id"])
    flow = Flow(signed_in, user, app, redirect_uri=WEB_REDIRECT, scope=SCOPES)
    code = flow.authorize(resource=mcp_resource())
    fields = {"grant_type": "authorization_code", "code": code, "redirect_uri": WEB_REDIRECT,
              "code_verifier": flow.verifier, "resource": mcp_resource()}
    basic = "Basic " + base64.b64encode(f'{app.client_id}:{registration["client_secret"]}'.encode()).decode()
    body = {"client_id": app.client_id, "client_secret": registration["client_secret"]}
    if declared == "client_secret_basic":
        bad = form_post(APIClient(), "/api/oauth/token", {**fields, **body})
        good = form_post(APIClient(), "/api/oauth/token", fields, HTTP_AUTHORIZATION=basic)
    else:
        bad = form_post(APIClient(), "/api/oauth/token", fields, HTTP_AUTHORIZATION=basic)
        good = form_post(APIClient(), "/api/oauth/token", {**fields, **body})
    assert bad.status_code == 401, bad.content
    assert good.status_code == 200, good.content


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("revoke_target", [True, False])
def test_revoke_serializes_with_action_on_separate_database_connections(signed_in, user, creator_factory, revoke_target):
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    import threading
    from django.db import close_old_connections
    from dj.apps.oidc.mcp import record_action
    from dj.apps.oidc.models import MCPActionAudit
    app, _, tokens = issue(signed_in, user)
    target = creator_factory(username="target")
    account, _ = link(tokens["access_token"], target)
    acquired, release, revoke_started = threading.Event(), threading.Event(), threading.Event()

    def action():
        close_old_connections()
        try:
            with authorized_actor(tokens["access_token"], target.username, ["mcp:write"]) as actor:
                acquired.set()
                assert release.wait(10), "test did not release action"
                actor.user.full_name = "Completed before revoke"
                actor.user.save(update_fields=["full_name"])
                record_action(actor, "profile_update", 200)
        finally:
            close_old_connections()

    def revoke():
        close_old_connections()
        try:
            revoke_started.set()
            if revoke_target:
                browser = APIClient(); browser.force_login(target)
                response = browser.delete(f'/api/oauth/mcp/grants/{account["id"]}/')
                assert response.status_code == 204
            else:
                revoke_authorization(user, app)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        running = pool.submit(action)
        assert acquired.wait(10), "action did not obtain its locks"
        revoking = pool.submit(revoke)
        assert revoke_started.wait(5)
        try:
            with pytest.raises(TimeoutError):
                revoking.result(timeout=0.2)
        finally:
            release.set()
        running.result(timeout=10)
        revoking.result(timeout=10)
    target.refresh_from_db()
    assert target.full_name == "Completed before revoke"
    audit = MCPActionAudit.objects.get(operation="profile_update")
    assert audit.target_user_id == target.pk and audit.primary_user_id == user.pk
    with pytest.raises(APIException):
        with authorized_actor(tokens["access_token"], target.username, ["mcp:write"]):
            pytest.fail("revocation was not enforced after commit")
