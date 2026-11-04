"""Epoch publication, the internal epoch endpoint, and the ledger seam."""
from __future__ import annotations

import logging

import pytest
from django.db import connection
from rest_framework.test import APIClient

from dj.apps.ktauth.epoch import EVENT_PASSWORD_CHANGE, bump_account_epoch
from dj.apps.oidc import epoch_publish, ledger_projection
from dj.apps.oidc.models import AppAuthorization

from .conftest import WEB_REDIRECT, Flow

pytestmark = pytest.mark.django_db


# ------------------------------------------------------------ publication
def test_an_ownership_event_publishes_the_new_epoch_after_commit(user, django_capture_on_commit_callbacks):
    assert epoch_publish.read_account_epoch(user.public_id) is None
    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)
    assert callbacks, "nothing was scheduled for commit"
    user.refresh_from_db()
    assert user.kt_account_epoch == 2
    assert epoch_publish.read_account_epoch(user.public_id) == 2


def test_publication_is_monotonic(user):
    epoch_publish.publish_account_epoch(user.public_id, 5)
    epoch_publish.publish_account_epoch(user.public_id, 3)    # a late callback
    assert epoch_publish.read_account_epoch(user.public_id) == 5
    epoch_publish.publish_account_epoch(user.public_id, 6)
    assert epoch_publish.read_account_epoch(user.public_id) == 6


def test_the_keys_are_namespaced_and_plain(settings, user, web_app):
    settings.OIDC_EPOCH_REDIS_NAMESPACE = "stage"
    assert epoch_publish.account_epoch_key(user.public_id) == f"stage:aep:{user.public_id}"
    assert epoch_publish.grant_generation_key(user.public_id, web_app.client_id) == (
        f"stage:agen:{web_app.client_id}:{user.public_id}"
    )


def test_the_raw_redis_write_is_a_set_if_greater(monkeypatch, user):
    """With django-redis in front, the write goes through the Lua CAS."""
    calls = []

    class FakeRedis:
        store = {}

        def eval(self, script, numkeys, key, value, ttl):
            calls.append((key, value, ttl))
            current = self.store.get(key)
            if current is None or int(current) < int(value):
                self.store[key] = value
            return 1

        def get(self, key):
            return self.store.get(key)

    fake = FakeRedis()
    monkeypatch.setattr(epoch_publish, "_raw_redis", lambda: fake)
    epoch_publish.publish_account_epoch(user.public_id, 7)
    epoch_publish.publish_account_epoch(user.public_id, 4)
    assert fake.store == {epoch_publish.account_epoch_key(user.public_id): "7"}
    # One access-token lifetime: the bound on how long a publication that
    # never landed can leave a stale counter readable.
    assert calls[0][2] == "300"
    assert epoch_publish.read_account_epoch(user.public_id) == 7


def test_a_failed_publication_is_retried_then_logged_not_raised(monkeypatch, user, caplog):
    attempts = []

    class Broken:
        def eval(self, *args):
            attempts.append(1)
            raise ConnectionError("redis down")

    monkeypatch.setattr(epoch_publish, "_raw_redis", lambda: Broken())
    monkeypatch.setattr(epoch_publish, "RETRY_PAUSES", (0, 0))
    with caplog.at_level(logging.ERROR, logger="dj.apps.oidc.epoch_publish"):
        epoch_publish.publish_account_epoch(user.public_id, 9)
    assert len(attempts) == 3
    assert "epoch publication failed" in caplog.text and "3 attempts" in caplog.text


def test_a_transient_failure_is_absorbed_by_the_retry(monkeypatch, user, caplog):
    class Flaky:
        store = {}
        failures = 1

        def eval(self, script, numkeys, key, value, ttl):
            if self.failures:
                self.failures -= 1
                raise ConnectionError("blip")
            self.store[key] = value
            return 1

        def get(self, key):
            return self.store.get(key)

    flaky = Flaky()
    monkeypatch.setattr(epoch_publish, "_raw_redis", lambda: flaky)
    monkeypatch.setattr(epoch_publish, "RETRY_PAUSES", (0, 0))
    with caplog.at_level(logging.ERROR, logger="dj.apps.oidc.epoch_publish"):
        epoch_publish.publish_account_epoch(user.public_id, 4)
    assert epoch_publish.read_account_epoch(user.public_id) == 4
    assert "publication failed" not in caplog.text


def test_the_grant_admin_is_read_only():
    from django.contrib.admin.sites import AdminSite
    from django.test import RequestFactory

    from dj.apps.oidc.admin import AppAuthorizationAdmin

    admin = AppAuthorizationAdmin(AppAuthorization, AdminSite())
    request = RequestFactory().get("/")
    assert admin.has_add_permission(request) is False
    assert admin.has_change_permission(request) is False
    assert admin.has_delete_permission(request) is False


# ---------------------------------------------------- internal endpoint
def test_internal_epoch_endpoint(settings, signed_in, user, web_app):
    url = f"/api/oauth/internal/epoch/{user.public_id}/"
    settings.OIDC_INTERNAL_API_TOKEN = ""
    assert APIClient().get(url, HTTP_AUTHORIZATION="Bearer anything").status_code == 503
    settings.OIDC_INTERNAL_API_TOKEN = "s3cret"
    assert APIClient().get(url).status_code == 401
    assert APIClient().get(url, HTTP_AUTHORIZATION="Bearer wrong").status_code == 401
    Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid").run()
    response = APIClient().get(url, HTTP_AUTHORIZATION="Bearer s3cret")
    assert response.status_code == 200
    assert response.json() == {"sub": str(user.public_id), "aep": 1, "agen": {web_app.client_id: 1}}
    assert response["Cache-Control"] == "no-store"
    unknown = APIClient().get("/api/oauth/internal/epoch/00000000-0000-4000-8000-000000000000/",
                              HTTP_AUTHORIZATION="Bearer s3cret")
    assert unknown.status_code == 404
    # An OAuth access token is not the internal secret.
    assert APIClient().get(url, HTTP_AUTHORIZATION="Bearer eyJ.eyJ.sig").status_code == 401


# ------------------------------------------------------------ ledger seam
def test_with_the_l2_tables_the_seam_writes_the_projection(user, web_app, developer, caplog):
    web_app.markup_bps = 1500
    web_app.approved_markup_bps = 1000
    web_app.save()
    assert ledger_projection.sync_application(web_app) == ledger_projection.WRITTEN
    with connection.cursor() as cursor:
        cursor.execute("SELECT developer_creator_id, frozen, markup_bps, approved_markup_bps, rails FROM ledger_app WHERE id = %s", [str(web_app.pk)])
        assert cursor.fetchone() == (developer.pk, False, 1500, 1000, ["stripe", "zec"])

    grant = AppAuthorization.objects.create(
        user=user, application=web_app, scope="openid ai:invoke",
        spend_cap_2z=100, cap_period="week", markup_bps=1000, generation=3,
    )
    assert ledger_projection.sync_grant(grant) == ledger_projection.WRITTEN
    with connection.cursor() as cursor:
        cursor.execute("SELECT account_id, cap_m2z, period, markup_bps, grant_generation, revoked_at FROM ledger_spend_cap WHERE app_id = %s", [str(web_app.pk)])
        account_id, cap_m2z, period, markup, generation, revoked_at = cursor.fetchone()
    assert (cap_m2z, period, markup, generation, revoked_at) == (100_000, "week", 1000, 3, None)
    from dj.apps.ledger.api import user_account_id
    assert account_id == user_account_id(user.pk)

    # No cap: NULL, and an upsert replaces in place.
    grant.spend_cap_2z = None
    grant.generation = 4
    grant.save()
    assert ledger_projection.sync_grant(grant) == ledger_projection.WRITTEN
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*), max(cap_m2z), max(grant_generation) FROM ledger_spend_cap")
        assert cursor.fetchone() == (1, None, 4)

    # A total cap replaces the old projection immediately, never preserving
    # a previous, higher monthly/weekly cap behind the user's new consent.
    grant.cap_period = "total"
    grant.spend_cap_2z = 10
    grant.save()
    assert ledger_projection.sync_grant(grant) == ledger_projection.WRITTEN
    with connection.cursor() as cursor:
        cursor.execute("SELECT period, cap_m2z FROM ledger_spend_cap")
        assert cursor.fetchone() == ("total", 10000)


def test_projection_backfill_is_dry_run_then_idempotent(user, web_app):
    from django.core.management import call_command
    from django.utils import timezone
    from io import StringIO

    grant = AppAuthorization.objects.create(user=user, application=web_app, scope="ai:invoke",
                                             spend_cap_2z=10, cap_period="total", generation=9,
                                             revoked_at=timezone.now())
    with connection.cursor() as cursor:
        cursor.execute('DELETE FROM ledger_spend_cap')
        cursor.execute('DELETE FROM ledger_app WHERE id=%s', [web_app.pk])
    output = StringIO()
    call_command('sync_oidc_ledger', stdout=output)
    assert 'dry-run:' in output.getvalue()
    with connection.cursor() as cursor:
        cursor.execute('SELECT count(*) FROM ledger_spend_cap')
        assert cursor.fetchone() == (0,)
    call_command('sync_oidc_ledger', '--apply', stdout=output)
    call_command('sync_oidc_ledger', '--apply', stdout=output)
    with connection.cursor() as cursor:
        cursor.execute('SELECT cap_m2z, period, grant_generation, revoked_at FROM ledger_spend_cap WHERE app_id=%s', [web_app.pk])
        assert cursor.fetchall() == [(10000, 'total', 9, grant.revoked_at)]


def test_deleting_an_app_freezes_its_ledger_tombstone(web_app):
    ledger_projection.sync_application(web_app)
    app_id = web_app.pk
    # Queryset deletion must run the same revocation, including admin bulk
    # deletion. A direct model.save override would miss this path.
    type(web_app).objects.filter(pk=app_id).delete()
    with connection.cursor() as cursor:
        cursor.execute('SELECT frozen FROM ledger_app WHERE id=%s', [app_id])
        assert cursor.fetchone() == (True,)


def test_projection_revision_tracks_frame_changes_not_numeric_limits(user, web_app):
    grant = AppAuthorization.objects.create(user=user, application=web_app, scope='ai:invoke',
                                             spend_cap_2z=10, cap_period='day')
    for period, amount, expected_revision in [('day', 10, 0), ('day', 5, 0), ('day', 20, 0),
                                               ('total', 20, 1), ('day', 20, 2),
                                               ('day', None, 3), ('day', 20, 4)]:
        grant.cap_period, grant.spend_cap_2z = period, amount
        grant.save()
        ledger_projection.sync_grant(grant)
        with connection.cursor() as cursor:
            cursor.execute('SELECT cap_window_revision FROM ledger_spend_cap WHERE app_id=%s', [web_app.pk])
            assert cursor.fetchone() == (expected_revision,)


def _app_projection(app_id):
    with connection.cursor() as cursor:
        cursor.execute('SELECT developer_creator_id, frozen, markup_bps, approved_markup_bps, rails '
                       'FROM ledger_app WHERE id=%s', [str(app_id)])
        return cursor.fetchone()


def test_a_grant_projects_its_missing_app_once(user, web_app):
    """`web_app` is created through the ORM, so it has no ledger_app row -- an
    app registered before L2. Its first grant write creates it; later ones
    find it and write nothing."""
    assert _app_projection(web_app.pk) is None
    grant = AppAuthorization.objects.create(user=user, application=web_app, scope='ai:invoke',
                                             spend_cap_2z=10, cap_period='month')
    assert ledger_projection.sync_grant(grant) == ledger_projection.WRITTEN
    assert _app_projection(web_app.pk) == (web_app.user_id, False, 0, None, ['stripe', 'zec'])
    assert ledger_projection._ensure_application(web_app) is False


def test_the_grant_path_never_overwrites_a_newer_registry_projection(user, web_app):
    """Insert-if-missing, never upsert: the in-memory app on a grant can be
    older than a registry write (an operator's freeze, a lowered markup) that
    already projected. Overwriting it from the grant would fail OPEN."""
    ledger_projection.sync_application(web_app)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_app SET frozen=true, markup_bps=7 WHERE id=%s', [str(web_app.pk)])
    grant = AppAuthorization.objects.create(user=user, application=web_app, scope='ai:invoke',
                                             spend_cap_2z=10, cap_period='month')
    assert grant.application.frozen is False and grant.application.markup_bps == 0  # stale
    ledger_projection.sync_grant(grant)
    assert _app_projection(web_app.pk) == (web_app.user_id, True, 7, None, ['stripe', 'zec'])


def test_backfill_after_a_self_heal_is_idempotent(user, web_app):
    from io import StringIO

    from django.core.management import call_command

    grant = AppAuthorization.objects.create(user=user, application=web_app, scope='ai:invoke',
                                             spend_cap_2z=10, cap_period='month')
    ledger_projection.sync_grant(grant)  # self-heals the app row

    def snapshot():
        with connection.cursor() as cursor:
            cursor.execute('SELECT id, developer_creator_id, frozen, markup_bps, approved_markup_bps, rails '
                           'FROM ledger_app ORDER BY id')
            apps = cursor.fetchall()
            cursor.execute('SELECT app_id, account_id, cap_window_revision, cap_m2z, period, markup_bps, '
                           'grant_generation, revoked_at FROM ledger_spend_cap ORDER BY app_id, account_id')
            return apps, cursor.fetchall()

    healed = snapshot()
    assert any(row[0] == web_app.pk for row in healed[0])
    for _ in range(2):
        call_command('sync_oidc_ledger', '--apply', stdout=StringIO())
        assert snapshot() == healed


def test_deleting_an_unprojected_app_still_leaves_a_frozen_tombstone(web_app):
    assert _app_projection(web_app.pk) is None
    app_id = web_app.pk
    type(web_app).objects.filter(pk=app_id).delete()
    assert _app_projection(app_id) == (web_app.user_id, True, 0, None, ['stripe', 'zec'])


# The two races codex found in review. Both need real concurrent
# transactions, so these commit; each cleans up the ledger rows it wrote.
def _drop_app_projection(app_id):
    with connection.cursor() as cursor:
        cursor.execute('DELETE FROM ledger_app WHERE id=%s', [str(app_id)])


@pytest.mark.django_db(transaction=True)
def test_the_self_heal_takes_the_registry_lock_before_writing_ledger_app(web_app):
    """Registry writers (developer._save, sync_oidc_ledger) lock the app row
    FOR UPDATE and then upsert ledger_app. A heal that inserted ledger_app
    first and met the app row only at COMMIT (the new grant's deferred FK)
    deadlocks with them; it must wait on the app row before writing."""
    from django.db import OperationalError, transaction

    registry = connection.Database.connect(**connection.get_connection_params())
    try:
        with registry.cursor() as cursor:
            cursor.execute('SELECT 1 FROM oidc_f2zapplication WHERE id=%s FOR UPDATE', [str(web_app.pk)])
        with pytest.raises(OperationalError, match='lock timeout'):
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute("SET LOCAL lock_timeout = '500ms'")
                ledger_projection._ensure_application(web_app)
        assert _app_projection(web_app.pk) is None
    finally:
        registry.rollback()
        registry.close()
    try:
        # Control: with the registry lock released the same call heals.
        assert ledger_projection._ensure_application(web_app) is True
    finally:
        _drop_app_projection(web_app.pk)


@pytest.mark.django_db(transaction=True)
def test_a_heal_racing_an_app_deletion_never_leaves_it_unfrozen(user, web_app):
    """A grant write holds its grant row; an operator deletes the app, whose
    tombstone runs before the cascade blocks on that grant; then the grant
    write's self-heal runs. With a zero-row UPDATE tombstone the heal's
    unfrozen insert committed and the deletion completed over it, leaving a
    live projection -- and an unrevoked spend cap -- for a deleted app."""
    import threading
    import time

    from django.db import transaction

    grant = AppAuthorization.objects.create(user=user, application=web_app, scope='ai:invoke',
                                             spend_cap_2z=10, cap_period='month')
    app_id = web_app.pk
    locked = threading.Event()
    results = {}

    def grant_write():
        try:
            with transaction.atomic():
                AppAuthorization.objects.select_for_update().get(pk=grant.pk)
                locked.set()
                time.sleep(1.0)  # the deletion's tombstone lands, then it blocks on us
                results['heal'] = ledger_projection._ensure_application(web_app)
        except Exception as exc:
            results['heal'] = exc
        finally:
            connection.close()

    def delete_app():
        try:
            assert locked.wait(10)
            with transaction.atomic():
                results['delete'] = type(web_app).objects.filter(pk=app_id).delete()
        except Exception as exc:
            results['delete'] = exc
        finally:
            connection.close()

    threads = [threading.Thread(target=grant_write), threading.Thread(target=delete_app)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    try:
        assert not any(thread.is_alive() for thread in threads), results
        app_gone = not type(web_app).objects.filter(pk=app_id).exists()
        projection = _app_projection(app_id)
        if app_gone:
            assert projection is not None and projection[1] is True, (results, projection)
        else:
            # Postgres broke the cycle by aborting the deletion; the app is
            # live and an unfrozen projection is simply correct.
            assert isinstance(results['delete'], Exception), results
    finally:
        _drop_app_projection(app_id)
