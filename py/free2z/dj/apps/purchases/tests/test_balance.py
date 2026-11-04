"""``GET /api/sdk/v1/balance``  against real Postgres: the wire type,
the numbers the ledger holds, the credentials, and that a read never writes.

``fixtures/sdk_balance_example.json`` is the §1.1 example of zuu
``docs/free2z/sdk/spec/purchase.md`` verbatim (zuu main 91719e36). The SDKs decode
this response with ``f2z_ai_proto::balance::Balance`` (``rs/crates/
f2z-ai-proto/src/balance.rs``);:func:`decode_balance` is that struct's serde
contract written out -- four ``Milli2z`` (``#[serde(transparent)]`` over
``u64``, so a JSON integer in ``0..=u64::MAX``, never a float, a string or a
bool), ``debt_milli_2z`` with ``#[serde(default)]``, and ``as_of: String``.
Its own negative controls are the first tests below: a decoder that accepts
anything proves nothing about the endpoint.
"""
from __future__ import annotations

import datetime
import json
import uuid
from decimal import Decimal
from pathlib import Path

import pytest
from django.db import connection, transaction
from knox.models import AuthToken
from rest_framework.test import APIClient

from dj.apps.ledger import api as ledger
from dj.apps.oidc.models import F2ZApplication
from dj.apps.oidc.tests.conftest import Flow

pytestmark = pytest.mark.django_db

URL = "/api/sdk/v1/balance"
APP_REDIRECT = "https://tutor.example.com/oauth/callback"
EXAMPLE = json.loads((Path(__file__).parent / "fixtures" / "sdk_balance_example.json").read_text())
U64_MAX = 2**64 - 1
_MILLI_FIELDS = ("available_milli_2z", "held_milli_2z", "balance_milli_2z", "debt_milli_2z")


class DecodeError(ValueError):
    pass


def decode_balance(raw: str) -> dict:
    """Decode ``raw`` exactly as serde_json decodes ``Balance``."""
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise DecodeError("not an object")
    out = {}
    for field in _MILLI_FIELDS:
        if field not in value:
            if field == "debt_milli_2z":  # #[serde(default)]
                out[field] = 0
                continue
            raise DecodeError(f"missing field `{field}`")
        amount = value[field]
        if isinstance(amount, bool) or not isinstance(amount, int) or not 0 <= amount <= U64_MAX:
            raise DecodeError(f"invalid type for `{field}`: {amount!r}")
        out[field] = amount
    if not isinstance(value.get("as_of"), str):
        raise DecodeError("missing or non-string `as_of`")
    out["as_of"] = value["as_of"]
    return out


def assert_spec_shape(response):
    """The response decodes as ``Balance`` and is shaped like the vendored
    example key for key and type for type -- nothing more, nothing less."""
    assert response.status_code == 200, response.content
    decoded = decode_balance(response.content.decode())
    body = response.json()
    assert set(body) == set(EXAMPLE)
    for field, example in EXAMPLE.items():
        assert type(body[field]) is type(example), field
    # RFC 3339 UTC with a `Z`, like the example.
    assert body["as_of"].endswith("Z")
    as_of = datetime.datetime.strptime(body["as_of"], "%Y-%m-%dT%H:%M:%SZ")
    assert abs(as_of.replace(tzinfo=datetime.UTC) - datetime.datetime.now(datetime.UTC)) < datetime.timedelta(minutes=5)
    assert response["Cache-Control"] == "no-store"
    return decoded


# ------------------------------------------------------------ the decoder
def test_the_vendored_spec_example_decodes():
    raw = json.dumps(EXAMPLE)
    assert decode_balance(raw) == EXAMPLE
    # The spec's own identity: available = balance - held.
    assert EXAMPLE["available_milli_2z"] == EXAMPLE["balance_milli_2z"] - EXAMPLE["held_milli_2z"]


@pytest.mark.parametrize("field, bad", [
    ("available_milli_2z", -1),
    ("held_milli_2z", 1.5),
    ("balance_milli_2z", "43500"),
    ("debt_milli_2z", True),
    ("balance_milli_2z", 2**64),
    ("as_of", 1727384654),
])
def test_the_decoder_refuses_what_serde_refuses(field, bad):
    with pytest.raises(DecodeError):
        decode_balance(json.dumps({**EXAMPLE, field: bad}))


@pytest.mark.parametrize("missing", ["available_milli_2z", "held_milli_2z", "balance_milli_2z", "as_of"])
def test_the_decoder_requires_every_field_but_debt(missing):
    with pytest.raises(DecodeError):
        decode_balance(json.dumps({k: v for k, v in EXAMPLE.items() if k != missing}))
    without_debt = {k: v for k, v in EXAMPLE.items() if k != "debt_milli_2z"}
    assert decode_balance(json.dumps(without_debt))["debt_milli_2z"] == 0


# ------------------------------------------------------------ the numbers
@pytest.fixture
def user(creator_factory):
    return creator_factory(tuzis=Decimal("43.5"))


@pytest.fixture
def client(user):
    api = APIClient()
    api.force_authenticate(user=user)
    return api


def _count(table):
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT count(*) FROM {table}")
        return cursor.fetchone()[0]


def _key():
    return f"test-2245:{uuid.uuid4()}"


def test_an_account_nobody_opened_reads_as_its_tuzis_and_opens_nothing(client, user):
    assert ledger.user_account_id(user.pk) is None
    accounts, journal = _count("ledger_account"), _count("ledger_transfer")
    decoded = assert_spec_shape(client.get(URL))
    assert decoded == {
        "available_milli_2z": 43500, "held_milli_2z": 0, "balance_milli_2z": 43500,
        "debt_milli_2z": 0, "as_of": decoded["as_of"],
    }
    # No side effect: still no account, no opening transfer.
    assert ledger.user_account_id(user.pk) is None
    assert (_count("ledger_account"), _count("ledger_transfer")) == (accounts, journal)
    # And it is exactly what opening the account would have produced.
    ledger.ensure_account(user.pk)
    assert client.get(URL).json()["balance_milli_2z"] == 43500


def test_the_example_numbers_come_back_from_a_real_hold(client, user):
    account_id = ledger.ensure_account(user.pk)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_account SET held = 2000 WHERE id = %s", [account_id])
    body = client.get(URL).json()
    assert {k: body[k] for k in _MILLI_FIELDS} == {k: EXAMPLE[k] for k in _MILLI_FIELDS}


def test_a_debt_is_its_own_line_and_zeroes_available(client, user):
    ledger.ensure_account(user.pk)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_account SET held = 2000 WHERE key = %s", [f"user:{user.pk}"])
    # A refund of 50 2Z against 41.5 available: 41.5 taken, 8.5 owed; the
    # held 2 stay (a reversal never takes held credits).
    result = ledger.clawback(user.pk, 50000, "sys:clearing_stripe", "clawback", "refund",
                             "stripe_transaction", "t1", _key())
    assert (result.clawed, result.debt_added) == (41500, 8500)
    body = assert_spec_shape(client.get(URL))
    assert body["debt_milli_2z"] == 8500
    assert body["available_milli_2z"] == 0
    assert body["held_milli_2z"] == 2000
    assert body["balance_milli_2z"] == 2000  # never net of the debt
    # The hold is released without spending: 2 2Z are now unheld, but while
    # the debt is open available stays 0 (spec §1.1) -- not balance - held.
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_account SET held = 0 WHERE key = %s", [f"user:{user.pk}"])
    released = client.get(URL).json()
    assert (released["balance_milli_2z"], released["held_milli_2z"]) == (2000, 0)
    assert released["available_milli_2z"] == 0


def test_an_open_ai_reservation_is_held_not_gone(client, user):
    """An L2 hold reduces availability while leaving total balance intact."""
    from dj.apps.tuzis import ledger as tuzis_ledger

    row = tuzis_ledger.reserve(user, 6, scope="ai_image", operation_key=uuid.uuid4())
    during = client.get(URL).json()
    assert (during["balance_milli_2z"], during["held_milli_2z"], during["available_milli_2z"]) == (
        43500, 6000, 37500,
    )
    tuzis_ledger.release_reservation(row)
    released = client.get(URL).json()
    assert (released["balance_milli_2z"], released["held_milli_2z"], released["available_milli_2z"]) == (
        43500, 0, 43500,
    )
    settled_row = tuzis_ledger.reserve(user, 2, scope="ai_image", operation_key=uuid.uuid4())
    tuzis_ledger.settle_reservation(settled_row)
    settled = client.get(URL).json()
    assert (settled["balance_milli_2z"], settled["held_milli_2z"], settled["available_milli_2z"]) == (
        41500, 0, 41500,
    )


@pytest.mark.django_db(transaction=True)
def test_on_its_own_it_reads_one_read_only_snapshot(creator_factory):
    """In production a GET is not inside AtomicMiddleware, so the view owns
    its transaction and makes it REPEATABLE READ, READ ONLY."""
    from django.test.utils import CaptureQueriesContext

    user = creator_factory(tuzis=Decimal("3"))
    api = APIClient()
    api.force_authenticate(user=user)
    with CaptureQueriesContext(connection) as queries:
        response = api.get(URL)
    assert response.status_code == 200, response.content
    assert response.json()["balance_milli_2z"] == 3000
    sql = [q["sql"] for q in queries.captured_queries]
    assert "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY" in sql
    assert ledger.user_account_id(user.pk) is None


def test_it_reports_what_the_next_spend_will_act_on_after_legacy_drift(client, user):
    """Differential: the read's arithmetic against ``lock_account``'s real
    heal, including an upward heal that repays debt first."""
    ledger.ensure_account(user.pk)
    ledger.clawback(user.pk, 50000, "sys:clearing_stripe", "clawback", "refund",
                    "stripe_transaction", "t2", _key())
    with connection.cursor() as cursor:  # an old pod credits 5 2Z behind the ledger
        cursor.execute("UPDATE g12f_creator SET tuzis = tuzis + 5 WHERE id = %s", [user.pk])
    read = client.get(URL).json()
    assert (read["balance_milli_2z"], read["debt_milli_2z"], read["available_milli_2z"]) == (0, 1500, 0)
    with transaction.atomic():
        locked = ledger.lock_creator(user.pk)
        row = ledger.lock_account(user.pk, locked.balance)
    assert (row.balance, row.held) == (read["balance_milli_2z"], read["held_milli_2z"])
    assert ledger.debt_m2z(user.pk) == read["debt_milli_2z"]
    again = client.get(URL).json()  # one read: two GETs can straddle a second boundary
    assert again == {**read, "as_of": again["as_of"]}


def test_with_the_heal_retired_the_ledger_is_the_authority(client, user):
    ledger.ensure_account(user.pk)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_config SET heal_enabled = false WHERE id")
        cursor.execute("UPDATE g12f_creator SET tuzis = tuzis + 5 WHERE id = %s", [user.pk])
    assert client.get(URL).json()["balance_milli_2z"] == 43500


@pytest.mark.django_db(transaction=True)
def test_the_read_runs_in_a_read_only_transaction(creator_factory):
    """The strongest form of "a GET does not write": Postgres itself refuses
    any write in a READ ONLY transaction. The negative control is the same
    transaction shape around ``ensure_account``, which must be refused --
    otherwise READ ONLY here would be proving nothing."""
    from django.db import InternalError

    user = creator_factory(tuzis=Decimal("7"))
    api = APIClient()
    api.force_authenticate(user=user)
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION READ ONLY")
        response = api.get(URL)
    assert response.status_code == 200, response.content
    assert response.json()["balance_milli_2z"] == 7000
    with pytest.raises(InternalError, match="read-only transaction"):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")
            ledger.ensure_account(user.pk)


def test_only_the_callers_own_balance(client, user, creator_factory):
    other = creator_factory(tuzis=Decimal("999"))
    ledger.ensure_account(other.pk)
    mine = client.get(URL).json()["balance_milli_2z"]
    assert mine == 43500
    # There is no way to name another account: every selector is ignored.
    for query in (f"?user={other.pk}", f"?creator_id={other.pk}", f"?username={other.username}"):
        assert client.get(URL + query).json()["balance_milli_2z"] == mine
    theirs = APIClient()
    theirs.force_authenticate(user=other)
    assert theirs.get(URL).json()["balance_milli_2z"] == 999000


def test_it_is_read_only_on_the_wire(client):
    for method in ("post", "put", "patch", "delete"):
        response = getattr(client, method)(URL, {}, format="json")
        assert response.status_code == 405
        assert response.json()["error"]["code"] == "method_not_allowed"


# ------------------------------------------------------------ credentials
@pytest.fixture
def app(creator_factory):
    return F2ZApplication.objects.create(
        name="Tutor",
        user=creator_factory(username="tutor-dev-2245"),
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris=APP_REDIRECT,
        allowed_scopes="openid offline_access balance:read purchase:create ai:invoke",
    )


def oauth_token(user, app, scope):
    session = APIClient()
    session.force_login(user)
    return Flow(session, user, app, redirect_uri=APP_REDIRECT, scope=scope).run()["access_token"]


def bearer(token):
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return api


def test_a_session_and_a_knox_token_read_it(user):
    session = APIClient()
    session.force_login(user)
    assert_spec_shape(session.get(URL))
    _instance, raw = AuthToken.objects.create(user)
    knox = APIClient()
    knox.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
    assert knox.get(URL).json()["balance_milli_2z"] == 43500


def test_an_app_with_balance_read_reads_its_users_balance(user, app):
    response = bearer(oauth_token(user, app, "balance:read")).get(URL)
    assert assert_spec_shape(response)["balance_milli_2z"] == 43500


def test_a_token_without_balance_read_is_refused(user, app):
    response = bearer(oauth_token(user, app, "purchase:create")).get(URL)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "insufficient_scope"
    assert response.json()["error"]["details"] == {"scope": "balance:read"}
    assert "balance_milli_2z" not in response.content.decode()


def test_a_frozen_app_is_refused(user, app):
    token = oauth_token(user, app, "balance:read")
    F2ZApplication.objects.filter(pk=app.pk).update(frozen=True)
    response = bearer(token).get(URL)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_token"


def test_an_app_that_is_no_longer_registered_is_refused(user, app):
    token = oauth_token(user, app, "balance:read")
    app.delete()
    response = bearer(token).get(URL)
    assert response.status_code == 401
    assert response.json()["error"]["code"] in ("invalid_token", "token_revoked")


def test_anonymous_and_garbage_credentials_get_the_envelope():
    anonymous = APIClient().get(URL)
    assert anonymous.status_code == 401
    assert anonymous.json()["error"]["code"] == "invalid_token"
    assert anonymous.json()["error"]["details"] == {"reason": "missing"}
    assert anonymous["WWW-Authenticate"].startswith("Bearer")
    garbage = bearer("not.a.jwt").get(URL)
    assert garbage.status_code == 401
    assert garbage.json()["error"]["code"] == "invalid_token"
