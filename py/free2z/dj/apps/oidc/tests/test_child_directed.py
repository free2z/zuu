"""A child-directed registration (zuu docs/free2z/sdk/CHILD-DIRECTED.md).

The developer declares it in the console; the consent screen then addresses
the adult account holder, and the access token carries ``child_directed`` so
the AI gateway keeps no caller-chosen text with a call. An ordinary app's
token is unchanged: the claim is present only when true."""
from __future__ import annotations

import pytest

from dj.apps.oidc.models import F2ZApplication
from dj.apps.oidc.scopes import AUD_ID
from dj.apps.oidc.tokens import TokenContext, access_token_claims, decode_access_token

from .conftest import WEB_REDIRECT, Flow

pytestmark = pytest.mark.django_db

APPS = "/api/oauth/apps/"


def _public(**overrides):
    body = {
        "client_type": "public",
        "name": "Math Practice",
        "redirect_uris": ["com.example.math:/oauth/callback"],
        "allowed_scopes": ["openid", "ai:invoke"],
    }
    body.update(overrides)
    return body


def _claims(user, app):
    context = TokenContext(user=user, application=app, scopes=("openid", "ai:invoke"),
                           account_epoch=1, grant_generation=1, auth_time=None, acr="", amr=())
    return access_token_claims(context, now=1_790_000_000)


def test_the_claim_is_present_only_when_the_app_is_child_directed(user, web_app):
    assert web_app.child_directed is False
    assert "child_directed" not in _claims(user, web_app)

    web_app.child_directed = True
    web_app.save()
    assert _claims(user, web_app)["child_directed"] is True


def test_consent_screen_and_tokens_follow_the_registration(signed_in, user, web_app):
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid")
    ordinary = flow.evaluate().json()["consent"]["application"]
    assert ordinary["child_directed"] is False

    web_app.child_directed = True
    web_app.save()
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid")
    consent = flow.evaluate().json()["consent"]["application"]
    assert consent["child_directed"] is True
    tokens = flow.run()
    claims = decode_access_token(tokens["access_token"], audience=AUD_ID)
    assert claims["child_directed"] is True


def test_the_developer_declares_it_in_the_console(api_client, developer):
    api_client.force_login(developer)
    created = api_client.post(APPS, _public(), format="json")
    assert created.status_code == 201, created.content
    assert created.json()["child_directed"] is False

    app_id = created.json()["id"]
    patched = api_client.patch(f"{APPS}{app_id}/", {"child_directed": True}, format="json")
    assert patched.status_code == 200, patched.content
    assert patched.json()["child_directed"] is True
    assert F2ZApplication.objects.get(pk=app_id).child_directed is True

    # A patch that does not name it leaves it alone.
    renamed = api_client.patch(f"{APPS}{app_id}/", {"name": "Math Practice 2"}, format="json")
    assert renamed.json()["child_directed"] is True

    direct = api_client.post(APPS, _public(name="Fractions", child_directed=True), format="json")
    assert direct.status_code == 201, direct.content
    assert F2ZApplication.objects.get(pk=direct.json()["id"]).child_directed is True


def test_it_must_be_a_boolean(api_client, developer):
    api_client.force_login(developer)
    response = api_client.post(APPS, _public(child_directed="maybe"), format="json")
    assert response.status_code == 400
    assert "child_directed" in response.json()


def test_a_refresh_reads_the_registration_as_it_is_now(signed_in, user, web_app):
    """Registration -> issuance -> refresh: a change reaches the next access
    token minted by refresh, with no new sign-in (zuu CHILD-DIRECTED.md)."""
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid offline_access")
    tokens = flow.run()
    assert "child_directed" not in decode_access_token(tokens["access_token"], audience=AUD_ID)

    web_app.child_directed = True
    web_app.save()
    refreshed = flow.refresh(tokens["refresh_token"])
    assert refreshed.status_code == 200, refreshed.content
    refreshed = refreshed.json()
    assert decode_access_token(refreshed["access_token"], audience=AUD_ID)["child_directed"] is True

    web_app.child_directed = False
    web_app.save()
    again = flow.refresh(refreshed["refresh_token"]).json()
    assert "child_directed" not in decode_access_token(again["access_token"], audience=AUD_ID)


def test_a_developer_cannot_unset_it_and_every_change_is_audited(api_client, developer):
    from dj.apps.oidc.models import AudienceChange

    api_client.force_login(developer)
    app_id = api_client.post(APPS, _public(), format="json").json()["id"]
    assert not AudienceChange.objects.filter(application_id=app_id).exists()

    assert api_client.patch(f"{APPS}{app_id}/", {"child_directed": True},
                            format="json").status_code == 200
    # Re-sending the same value is not a change.
    assert api_client.patch(f"{APPS}{app_id}/", {"child_directed": True},
                            format="json").status_code == 200
    refused = api_client.patch(f"{APPS}{app_id}/", {"child_directed": False}, format="json")
    assert refused.status_code == 400
    assert "child_directed" in refused.json()
    assert F2ZApplication.objects.get(pk=app_id).child_directed is True

    changes = list(AudienceChange.objects.filter(application_id=app_id))
    assert [(c.previous, c.child_directed, c.changed_by_id, c.via) for c in changes] == [
        (False, True, developer.pk, "console"),
    ]

    created = api_client.post(APPS, _public(name="Fractions", child_directed=True),
                              format="json").json()
    change = AudienceChange.objects.get(application_id=created["id"])
    assert (change.previous, change.child_directed, change.via) == (None, True, "console")


def test_staff_unset_it_in_the_admin_and_that_is_audited(rf, developer, creator_factory):
    from django.contrib import admin as django_admin

    from dj.apps.oidc.admin import F2ZApplicationAdmin
    from dj.apps.oidc.models import AudienceChange

    staff = creator_factory(username="staffer")
    app = F2ZApplication.objects.create(
        user=developer, name="Math Practice", client_type="public",
        redirect_uris="com.example.math:/oauth/callback", child_directed=True,
    )
    model_admin = F2ZApplicationAdmin(F2ZApplication, django_admin.site)
    request = rf.post("/")
    request.user = staff

    class Form:
        changed_data = ["child_directed"]

    app.child_directed = False
    model_admin.save_model(request, app, Form(), change=True)
    assert F2ZApplication.objects.get(pk=app.pk).child_directed is False
    change = AudienceChange.objects.get(application=app)
    assert (change.previous, change.child_directed, change.changed_by_id, change.via) == (
        True, False, staff.pk, "admin")

    class Unrelated:
        changed_data = ["name"]

    model_admin.save_model(request, app, Unrelated(), change=True)
    assert AudienceChange.objects.filter(application=app).count() == 1
