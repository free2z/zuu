"""Grant privacy and exact policy proof through real OAuth and Postgres."""
import pytest
from django.db import connection
from knox.models import AuthToken
from rest_framework.test import APIClient
from dj.apps.ledger.api import ensure_account
from dj.apps.oidc.models import AppAuthorization
from dj.apps.oidc.tokens import decode_access_token
from .conftest import Flow, WEB_REDIRECT

pytestmark = pytest.mark.django_db
URL = '/api/sdk/v1/grant'

@pytest.fixture
def grant_request(signed_in, user, web_app):
    tokens = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT,
                  scope='openid ai:invoke').run(spend_cap_2z=2147483647, cap_period='week')
    claims = decode_access_token(tokens['access_token'], audience='f2z-api')
    assert claims['app_id'] == str(web_app.pk)
    assert claims['client_id'] == web_app.client_id != str(web_app.pk)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION='Bearer ' + tokens['access_token'])
    return api, AppAuthorization.objects.get(user=user, application=web_app)

def test_own_grant_original_integer_limit(grant_request):
    api, grant = grant_request
    response = api.get(URL, {'client_id': 'foreign', 'sub': 'foreign'})
    assert response.status_code == 200, response.content
    body = response.json()
    assert body == {'sub': str(grant.user.public_id), 'client_id': grant.application.client_id,
                    'account_epoch': grant.user.kt_account_epoch, 'grant_generation': grant.generation,
                    'scopes': ['openid', 'ai:invoke'], 'spend_cap_2z': 2147483647,
                    'cap_period': 'week', 'enforced': False,
                    'enforcement_reason': 'platform_disabled', 'as_of': body['as_of']}
    assert type(body['spend_cap_2z']) is int
    assert body['as_of'].endswith('Z')
    assert response['Cache-Control'] == 'no-store'

def test_uncapped_and_same_generation_edits(grant_request):
    api, grant = grant_request
    for cap in (17, 0, None):
        AppAuthorization.objects.filter(pk=grant.pk).update(spend_cap_2z=cap)
        body = api.get(URL).json()
        assert (body['spend_cap_2z'], body['grant_generation'], body['enforced']) == (cap, grant.generation, False)

def test_session_and_knox_not_grant_credentials(user):
    api = APIClient()
    for credential in ('missing', 'session', 'knox'):
        if credential == 'session': api.force_login(user)
        if credential == 'knox':
            _, token = AuthToken.objects.create(user)
            api.credentials(HTTP_AUTHORIZATION='Token ' + token)
        response = api.get(URL)
        assert response.status_code == 401
        assert response.json()['error']['code'] == 'invalid_token'
        assert response['Cache-Control'] == 'no-store'

def test_balance_scope_not_enough(signed_in, user, web_app):
    tokens = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope='openid balance:read').run()
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION='Bearer ' + tokens['access_token'])
    response = api.get(URL)
    assert response.status_code == 403
    assert response.json()['error']['details']['scope'] == 'ai:invoke'

@pytest.mark.parametrize('change', ['epoch', 'generation', 'revoked', 'frozen'])
def test_stale_grants_refused(grant_request, change):
    api, grant = grant_request
    if change == 'epoch':
        type(grant.user).objects.filter(pk=grant.user_id).update(kt_account_epoch=grant.user.kt_account_epoch+1)
    elif change == 'generation':
        AppAuthorization.objects.filter(pk=grant.pk).update(generation=grant.generation+1)
    elif change == 'revoked':
        from django.utils.timezone import now
        AppAuthorization.objects.filter(pk=grant.pk).update(revoked_at=now())
    else:
        type(grant.application).objects.filter(pk=grant.application_id).update(frozen=True)
    assert api.get(URL).status_code == 401

def test_epoch_race_after_auth_refused(grant_request, monkeypatch):
    from dj.apps.oidc.sdk_grant import SdkGrantView
    original = SdkGrantView.get
    def race(self, request):
        user = request.user
        type(user).objects.filter(pk=user.pk).update(kt_account_epoch=user.kt_account_epoch+1)
        return original(self, request)
    monkeypatch.setattr(SdkGrantView, 'get', race)
    assert grant_request[0].get(URL).status_code == 401

@pytest.fixture
def projected(grant_request, settings):
    """Read-side SQL fixture before L2; use actual L2 tables when installed.

    Minimal tables exist only inside this test's rollback transaction, never
    as another migration or a fake enforcement function.
    """
    api, grant = grant_request
    account = ensure_account(grant.user_id)
    with connection.cursor() as cursor:
        tables = set(connection.introspection.table_names(cursor))
        if 'ledger_app' not in tables:
            cursor.execute('CREATE TABLE ledger_app (id uuid PRIMARY KEY, developer_creator_id bigint, frozen boolean, markup_bps integer, approved_markup_bps integer)')
            cursor.execute('CREATE TABLE ledger_spend_cap (app_id uuid, account_id bigint, cap_m2z bigint, period text, markup_bps integer, grant_generation integer, revoked_at timestamptz)')
        cursor.execute('DELETE FROM ledger_spend_cap WHERE app_id=%s', [str(grant.application_id)])
        cursor.execute('DELETE FROM ledger_app WHERE id=%s', [str(grant.application_id)])
        real_l2 = 'ledger_hold' in tables
        cursor.execute('INSERT INTO ledger_app (id,developer_creator_id,frozen,markup_bps,approved_markup_bps' +
                       (',rails,updated_at' if real_l2 else '') + ') VALUES (%s,%s,false,%s,%s' +
                       (",ARRAY['stripe','zec'],now()" if real_l2 else '') + ')',
                       [str(grant.application_id), grant.application.user_id, grant.application.markup_bps, grant.application.approved_markup_bps])
        cursor.execute('INSERT INTO ledger_spend_cap (app_id,account_id,cap_m2z,period,markup_bps,grant_generation,revoked_at' +
                       (',updated_at' if real_l2 else '') + ') VALUES (%s,%s,%s,%s,%s,%s,NULL' +
                       (',now()' if real_l2 else '') + ')',
                       [str(grant.application_id), account, grant.spend_cap_2z*1000, grant.cap_period, grant.markup_bps, grant.generation])
        cursor.execute('UPDATE ledger_config SET heal_enabled=false')
    settings.SDK_AI_GRANTS_ENFORCED = True
    return api, grant

def _state(api):
    body = api.get(URL).json()
    return body['enforced'], body['enforcement_reason']

def test_exact_projection_requires_activation(projected, settings):
    api, _ = projected
    assert _state(api) == (True, 'ok')
    settings.SDK_AI_GRANTS_ENFORCED = False
    assert _state(api) == (False, 'platform_disabled')

@pytest.mark.parametrize('sql', [
    'UPDATE ledger_config SET heal_enabled=true',
    'UPDATE ledger_spend_cap SET cap_m2z=cap_m2z-1',
    'UPDATE ledger_spend_cap SET cap_m2z=NULL',
    "UPDATE ledger_spend_cap SET period='day'",
    'UPDATE ledger_spend_cap SET markup_bps=markup_bps+1',
    'UPDATE ledger_spend_cap SET grant_generation=grant_generation+1',
    'UPDATE ledger_spend_cap SET revoked_at=now()',
    'UPDATE ledger_app SET frozen=true',
    'UPDATE ledger_app SET markup_bps=markup_bps+1',
    'UPDATE ledger_app SET approved_markup_bps=1',
    'DELETE FROM ledger_spend_cap',
])
def test_mismatch_never_claims_enforcement(projected, sql):
    # Negative control: the untouched projection is enforced, so each
    # mutation below is what flips it, not a broken fixture.
    assert _state(projected[0]) == (True, 'ok')
    with connection.cursor() as cursor: cursor.execute(sql)
    reason = 'ledger_cutover_pending' if 'heal_enabled' in sql else 'ledger_cap_pending'
    assert _state(projected[0]) == (False, reason)

@pytest.mark.parametrize('sql', ['DELETE FROM ledger_config', 'UPDATE ledger_config SET heal_enabled=true'])
def test_heal_still_enabled_is_cutover_pending_even_with_exact_cap(projected, sql):
    with connection.cursor() as cursor: cursor.execute(sql)
    assert _state(projected[0]) == (False, 'ledger_cutover_pending')

def test_ok_requires_heal_disabled_in_the_same_statement(projected, monkeypatch):
    # Heal flips back on AFTER the cutover pre-check passed but BEFORE the
    # projection query runs. Outside REPEATABLE READ (as here) the two
    # statements see different states; `ok` must still be refused, because the
    # projection statement re-proves heal_enabled=false itself.
    from django.db.backends.utils import CursorWrapper
    real = CursorWrapper.execute
    flipped = []
    def execute(self, sql, params=None):
        result = real(self, sql, params)
        if not flipped and sql.strip() == 'SELECT EXISTS (SELECT 1 FROM ledger_config WHERE NOT heal_enabled)':
            flipped.append(True)
            # A separate cursor, same connection/transaction: the pre-check's
            # own result must still be fetchable by the code under test.
            with connection.cursor() as other:
                other.execute('UPDATE ledger_config SET heal_enabled=true')
        return result
    assert _state(projected[0]) == (True, 'ok')  # control: untouched projection
    monkeypatch.setattr(CursorWrapper, 'execute', execute)
    assert _state(projected[0]) == (False, 'ledger_cap_pending')
    assert flipped == [True]

def test_activation_flag_outranks_every_ledger_state(projected, settings):
    # A missing cap AND an enabled heal still report the platform flag first:
    # the reason names the first unmet prerequisite, in a fixed order.
    with connection.cursor() as cursor:
        cursor.execute('DELETE FROM ledger_spend_cap')
        cursor.execute('UPDATE ledger_config SET heal_enabled=true')
    settings.SDK_AI_GRANTS_ENFORCED = False
    assert _state(projected[0]) == (False, 'platform_disabled')

@pytest.mark.parametrize('table', ['ledger_app', 'ledger_spend_cap', 'ledger_account', 'ledger_config'])
def test_missing_ledger_table_is_cutover_pending(projected, monkeypatch, table):
    from django.db.backends.postgresql.introspection import DatabaseIntrospection
    real = DatabaseIntrospection.table_names
    monkeypatch.setattr(DatabaseIntrospection, 'table_names',
                        lambda self, *a, **k: [t for t in real(self, *a, **k) if t != table])
    assert _state(projected[0]) == (False, 'ledger_cutover_pending')
    monkeypatch.setattr(DatabaseIntrospection, 'table_names', real)
    # Control: the same snapshot with the table visible is fully enforced.
    assert _state(projected[0]) == (True, 'ok')

def test_uncapped_exact_projection_is_enforced(projected):
    api, grant = projected
    AppAuthorization.objects.filter(pk=grant.pk).update(spend_cap_2z=None)
    assert _state(api) == (False, 'ledger_cap_pending')
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_spend_cap SET cap_m2z=NULL')
    assert _state(api) == (True, 'ok')

def test_same_generation_limit_change_invalidates_proof(projected):
    api, grant = projected
    AppAuthorization.objects.filter(pk=grant.pk).update(spend_cap_2z=15)
    body = api.get(URL).json()
    assert (body['spend_cap_2z'], body['grant_generation'], body['enforced']) == (15, grant.generation, False)

def test_activation_without_projection_is_not_enforcement(grant_request, settings):
    settings.SDK_AI_GRANTS_ENFORCED = True
    body = grant_request[0].get(URL).json()
    # A freshly migrated database has not completed the ledger cutover (no L2
    # projection tables, or heal still enabled), so the FIRST unmet
    # prerequisite is the platform one, exactly -- not the per-grant cap.
    # The per-grant `ledger_cap_pending` case is pinned with a real, otherwise
    # exact projection in test_mismatch_never_claims_enforcement.
    assert (body['enforced'], body['enforcement_reason']) == (False, 'ledger_cutover_pending')


def test_refresh_retains_real_app_binding(flow, web_app):
    from dj.apps.oidc.scopes import AUD_ID
    tokens = flow.run()
    refreshed = flow.refresh(tokens['refresh_token'])
    assert refreshed.status_code == 200
    claims = decode_access_token(refreshed.json()['access_token'], audience=AUD_ID)
    assert claims['app_id'] == str(web_app.pk)
    assert claims['client_id'] == web_app.client_id != claims['app_id']


def test_signed_but_wrong_app_binding_rejected(grant_request):
    import hashlib
    import uuid
    from dj.apps.oidc.models import AccessToken
    from dj.apps.oidc.tokens import sign_access_token
    api, grant = grant_request
    row = AccessToken.objects.get(user_id=grant.user_id, application_id=grant.application_id)
    claims = decode_access_token(row.token, audience='f2z-api')
    claims['app_id'] = str(uuid.uuid4())
    raw = sign_access_token(claims)
    AccessToken.objects.filter(pk=row.pk).update(token=raw, token_checksum=hashlib.sha256(raw.encode()).hexdigest())
    api.credentials(HTTP_AUTHORIZATION='Bearer ' + raw)
    assert api.get(URL).status_code == 401


@pytest.mark.django_db(transaction=True)
def test_production_snapshot_survives_concurrent_revocation(grant_request, monkeypatch):
    """A real independent writer commits after the endpoint reads its grant.

    This runs without pytest's outer transaction, so the production READ ONLY
    REPEATABLE READ statement executes. The response describes the earlier
    coherent snapshot; the next request sees the committed revocation.
    """
    from dj.apps.oidc import sdk_grant
    api, grant = grant_request
    original = sdk_grant._enforcement_reason

    def concurrent_change(current_grant):
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')")
            assert cursor.fetchone() == ('repeatable read', 'on')
        other = connection.Database.connect(**connection.get_connection_params())
        try:
            with other.cursor() as cursor:
                cursor.execute('UPDATE g12f_creator SET kt_account_epoch=kt_account_epoch+1 WHERE id=%s', [grant.user_id])
                cursor.execute('UPDATE oidc_appauthorization SET spend_cap_2z=1 WHERE id=%s', [grant.pk])
            other.commit()
        finally:
            other.close()
        # Re-read after the independent commit: one MVCC snapshot, not a mix
        # of stale grant fields and newly changed authorization state.
        assert AppAuthorization.objects.get(pk=grant.pk).spend_cap_2z == grant.spend_cap_2z
        assert type(grant.user).objects.get(pk=grant.user_id).kt_account_epoch == grant.user.kt_account_epoch
        return original(current_grant)

    monkeypatch.setattr(sdk_grant, '_enforcement_reason', concurrent_change)
    response = api.get(URL)
    assert response.status_code == 200, response.content
    assert response.json()['spend_cap_2z'] == grant.spend_cap_2z
    assert api.get(URL).status_code == 401


# ------------------------------------------- a consent self-heals ledger_app
# The 2026-10-05 ¡AHA! incident: an app registered the day before L2 had no
# `ledger_app` row (that row is written at registration and on admin saves
# only, and the `sync_oidc_ledger --apply` backfill was never run). Its
# user's consent wrote `ledger_spend_cap`, but the grant read
# `ledger_cap_pending` and the gateway's JOIN would have 401'd every paid
# call. `web_app` here is created straight through the ORM, so it is exactly
# that app: registered, never projected.
def _ledger_app_row(app_id):
    with connection.cursor() as cursor:
        cursor.execute('SELECT developer_creator_id, frozen, markup_bps, approved_markup_bps, rails '
                       'FROM ledger_app WHERE id=%s', [str(app_id)])
        return cursor.fetchone()

def _consent_to_an_unprojected_app(signed_in, user, web_app, settings):
    assert _ledger_app_row(web_app.pk) is None  # the incident's precondition
    tokens = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT,
                  scope='openid ai:invoke').run(spend_cap_2z=50, cap_period='month')
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION='Bearer ' + tokens['access_token'])
    # The activated state `projected` arranges, minus any hand-written rows.
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_config SET heal_enabled=false')
    settings.SDK_AI_GRANTS_ENFORCED = True
    return api

def test_a_consent_projects_its_missing_app_and_reads_ok(signed_in, user, web_app, settings):
    api = _consent_to_an_unprojected_app(signed_in, user, web_app, settings)
    assert _ledger_app_row(web_app.pk) == (web_app.user_id, False, web_app.markup_bps,
                                           web_app.approved_markup_bps, ['stripe', 'zec'])
    assert _state(api) == (True, 'ok')

def test_without_the_self_heal_the_same_consent_is_cap_pending(signed_in, user, web_app, settings, monkeypatch):
    """Negative control: the same arrangement with the self-heal removed is
    the incident, and the backfill is still what repairs it."""
    from io import StringIO
    from django.core.management import call_command
    from dj.apps.oidc import ledger_projection
    monkeypatch.setattr(ledger_projection, '_ensure_application', lambda application: False)
    api = _consent_to_an_unprojected_app(signed_in, user, web_app, settings)
    assert _ledger_app_row(web_app.pk) is None
    assert _state(api) == (False, 'ledger_cap_pending')
    call_command('sync_oidc_ledger', '--apply', stdout=StringIO())
    assert _state(api) == (True, 'ok')
