"""The app's shape: swapped models, one additive migration, the v1 numbers."""
import ast
from pathlib import Path

import pytest
from django.conf import settings
from django.db import connection
from oauth2_provider.models import (
    get_access_token_model,
    get_application_model,
    get_device_grant_model,
    get_grant_model,
    get_id_token_model,
    get_refresh_token_model,
)
from oauth2_provider.settings import oauth2_settings

from dj.apps.oidc import models

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "0001_initial.py"


def test_every_library_model_is_swapped_into_this_app():
    assert get_application_model() is models.F2ZApplication
    assert get_grant_model() is models.AuthorizationCode
    assert get_access_token_model() is models.AccessToken
    assert get_refresh_token_model() is models.RefreshToken
    assert get_id_token_model() is models.IDToken
    assert get_device_grant_model() is models.DeviceGrant


@pytest.mark.django_db
def test_the_library_creates_no_table_of_its_own():
    """Swapping all six means django-oauth-toolkit's migrations are no-ops."""
    tables = set(connection.introspection.table_names())
    assert not [t for t in tables if t.startswith("oauth2_provider_")]
    assert {
        "oidc_f2zapplication", "oidc_appauthorization", "oidc_authorizationcode",
        "oidc_accesstoken", "oidc_refreshtoken", "oidc_idtoken", "oidc_devicegrant",
    } <= tables


def test_application_primary_key_is_a_uuid():
    """docs/tuzis/ledger-v2.md §3.6: `ledger_app.id = F2ZApplication.id`."""
    from django.db import models as dj_models

    assert isinstance(models.F2ZApplication._meta.pk, dj_models.UUIDField)


def test_the_migration_is_purely_additive():
    """Mixed-fleet safety: new tables only, never an ALTER of an existing one."""
    tree = ast.parse(MIGRATION.read_text())
    ops = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if isinstance(node.func.value, ast.Name) and node.func.value.id == "migrations":
                ops.append(node)
    names = {op.func.attr for op in ops}
    assert names <= {
        "CreateModel", "AddField", "AddConstraint", "AddIndex",
        "AlterUniqueTogether", "RunPython", "swappable_dependency",
    }, names
    # Field-level operations name the model with `model_name`.
    for op in ops:
        if op.func.attr == "AddField":
            assert any(kw.arg == "model_name" for kw in op.keywords)
    created = {
        kw.value.value.lower()
        for op in ops if op.func.attr == "CreateModel"
        for kw in op.keywords if kw.arg == "name"
    }
    for op in ops:
        if op.func.attr in ("AddField", "AddConstraint", "AddIndex", "AlterUniqueTogether"):
            target = next(kw.value.value for kw in op.keywords if kw.arg in ("model_name", "name"))
            assert target.lower() in created, f"{op.func.attr} touches a table this migration did not create: {target}"
    # The RunPython is the lock_timeout guard, with a no-op reverse.
    runpython = [op for op in ops if op.func.attr == "RunPython"]
    assert len(runpython) == 1
    assert runpython[0].args[0].id == "set_lock_timeout"


def test_the_v1_numbers_are_pinned():
    """zuu docs/free2z/sdk/README.md 'The v1 numbers'."""
    assert oauth2_settings.ACCESS_TOKEN_EXPIRE_SECONDS == 300
    assert oauth2_settings.ID_TOKEN_EXPIRE_SECONDS == 3600
    assert oauth2_settings.AUTHORIZATION_CODE_EXPIRE_SECONDS == 60
    assert oauth2_settings.REFRESH_TOKEN_EXPIRE_SECONDS == 30 * 24 * 3600
    assert oauth2_settings.REFRESH_TOKEN_GRACE_PERIOD_SECONDS == 60
    assert oauth2_settings.ROTATE_REFRESH_TOKEN is True
    assert oauth2_settings.REFRESH_TOKEN_REUSE_PROTECTION is True
    assert oauth2_settings.PKCE_REQUIRED is True
    assert oauth2_settings.COMPLIANT_BCP_RFC9700_AUTHZ_RESPONSE_ISS is True
    assert oauth2_settings.COMPLIANT_BCP_RFC9700_PKCE_METHOD is True
    assert oauth2_settings.COMPLIANT_BCP_RFC9700_IMPLICIT_GRANT is True
    assert oauth2_settings.ALLOW_URI_WILDCARDS is False
    assert oauth2_settings.ALLOW_LOCALHOST_LOOPBACK is False
    # No forced app budget: prepaid balance bounds ordinary first consent.
    from dj.apps.oidc.scopes import PLATFORM_DEFAULT_CAP_PERIOD, PLATFORM_DEFAULT_SPEND_CAP_2Z

    assert PLATFORM_DEFAULT_SPEND_CAP_2Z is None
    assert PLATFORM_DEFAULT_CAP_PERIOD == "month"
    # The publication TTL is one access-token lifetime.
    assert settings.OIDC_EPOCH_REDIS_TTL_SECONDS == 300


def test_refresh_tokens_do_not_inherit_the_jwt_generator():
    """oauthlib falls back to the ACCESS token generator for refresh tokens
    when none is configured -- which would hand out a signed JWT as the
    opaque refresh token (spec §8)."""
    from oauthlib.oauth2.rfc6749.tokens import random_token_generator

    from dj.apps.oidc.tokens import generate_access_token

    assert oauth2_settings.ACCESS_TOKEN_GENERATOR is generate_access_token
    assert oauth2_settings.REFRESH_TOKEN_GENERATOR is random_token_generator


def test_the_token_sweep_is_a_registered_periodic_task():
    """Register first (this release); the scheduler produces it. Its reclaim
    policy and drain-loss line are pinned by the jobs app's own tests."""
    from procrastinate.contrib.django import app

    from dj.apps.jobs.reclaim_policy import TASK_POLICIES

    task = app.tasks["oidc.sweep_tokens"]
    assert task.queue == "default"
    assert "oidc.sweep_tokens" in TASK_POLICIES
    assert TASK_POLICIES["oidc.sweep_tokens"].reclaimable is False
    periodic = [
        pt for pt in app.periodic_registry.periodic_tasks.values()
        if pt.task.name == "oidc.sweep_tokens"
    ]
    assert len(periodic) == 1 and periodic[0].cron == settings.OIDC_TOKEN_SWEEP_CRON


@pytest.mark.django_db
def test_the_sweep_keeps_revoked_refresh_tokens_as_reuse_evidence(signed_in, user, web_app):
    """The retention the module docstring states: a rotated (revoked) refresh
    token outlives its 30-day lifetime, an expired code does not."""
    from datetime import timedelta

    from django.utils import timezone

    from dj.apps.oidc.models import AuthorizationCode, RefreshToken
    from dj.apps.oidc.tasks import sweep_tokens

    from .conftest import WEB_REDIRECT, Flow

    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid offline_access")
    tokens = flow.run()
    flow.refresh(tokens["refresh_token"])
    assert RefreshToken.objects.filter(revoked__isnull=False).count() == 1
    assert AuthorizationCode.objects.filter(redeemed_at__isnull=False).count() == 1
    AuthorizationCode.objects.update(expires=timezone.now() - timedelta(seconds=1))
    sweep_tokens()
    assert RefreshToken.objects.filter(revoked__isnull=False).count() == 1, "reuse evidence must survive"
    assert AuthorizationCode.objects.count() == 0
    # Older than the token lifetime it would have had: gone.
    RefreshToken.objects.filter(revoked__isnull=False).update(
        revoked=timezone.now() - timedelta(days=31),
    )
    sweep_tokens()
    assert RefreshToken.objects.filter(revoked__isnull=False).count() == 0


def test_scopes_are_exactly_the_contracts():
    from dj.apps.oidc.scopes import ALL_SCOPES

    assert tuple(settings.OAUTH2_PROVIDER["SCOPES"]) == ALL_SCOPES == (
        "openid", "profile", "email", "offline_access",
        "balance:read", "purchase:create", "ai:invoke",
    )


@pytest.mark.django_db
def test_a_public_client_is_issued_no_secret(developer):
    app = models.F2ZApplication.objects.create(
        name="x", user=developer, client_type="public",
        redirect_uris="https://a.example.com/cb", allowed_scopes="openid",
    )
    app.refresh_from_db()
    assert app.client_secret == ""


@pytest.mark.django_db
def test_a_confidential_client_needs_a_secret_and_stores_it_hashed(developer):
    from django.core.exceptions import ValidationError

    app = models.F2ZApplication(
        name="x", user=developer, client_type="confidential",
        redirect_uris="https://a.example.com/cb", allowed_scopes="openid",
    )
    with pytest.raises(ValidationError):
        app.save()
    secret = app.issue_client_secret()
    app.save()
    app.refresh_from_db()
    assert app.client_secret != secret and app.client_secret.startswith("pbkdf2")


@pytest.mark.django_db
def test_markup_semantics(developer):
    app = models.F2ZApplication.objects.create(
        name="x", user=developer, client_type="public",
        redirect_uris="https://a.example.com/cb", allowed_scopes="openid", markup_bps=2000,
    )
    assert app.effective_markup_bps == 0 and app.markup_approval == "pending"
    app.approved_markup_bps = 1000
    assert app.effective_markup_bps == 1000 and app.markup_approval == "pending"
    app.approved_markup_bps = 2000
    assert app.effective_markup_bps == 2000 and app.markup_approval == "approved"
    app.markup_bps = 0
    assert app.markup_approval == "none"
