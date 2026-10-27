import pytest
from rest_framework.test import APIClient

from dj.tests.factories import CreatorFactory


class _DummyPubSubClient:
    """Stands in for gcp.pubsub.client.PubSubClient in tests.

    Model signals publish to Pub/Sub on save; instantiating the real
    client requires GCP credentials. The database is real Postgres —
    only the external Pub/Sub boundary is stubbed.
    """

    def publish(self, *args, **kwargs):
        return None

    def publish_string(self, *args, **kwargs):
        return None


@pytest.fixture(autouse=True)
def _stub_pubsub_client(mocker):
    mocker.patch("gcp.pubsub.client.PubSubClient", _DummyPubSubClient)
    mocker.patch("dj.apps.events.signals.PubSubClient", _DummyPubSubClient)
    mocker.patch("dj.apps.g12f.publication.PubSubClient", _DummyPubSubClient)
    # The Pub/Sub transactional outbox relay. Comments and Dyte
    # recordings no longer hold their own client -- they write an outbox row,
    # and this module is the single external boundary that publishes it.
    mocker.patch("dj.apps.jobs.outbox.PubSubClient", _DummyPubSubClient)


@pytest.fixture(autouse=True)
def _darwin_ordinary_purchase_artifacts(request, monkeypatch):
    """Ordinary Django tests use the canonical, trusted Darwin /var namespace.

    macOS /var is a system symlink. Production retains strict Linux paths and
    no-follow validation. Dedicated filesystem/lease controls exercise their own
    paths unmodified; this fixture proves entry behavior, not a production host.
    """
    import sys
    from pathlib import Path
    if sys.platform != 'darwin' or request.node.path.name == 'test_paymentd_mode.py':
        return
    from zcashrpc import paymentd_mode
    parent = Path('/private/var/lib/free2z-paymentd')
    monkeypatch.setattr(paymentd_mode, 'ACTIVE_PATH', parent / 'ACTIVE')
    monkeypatch.setattr(paymentd_mode, 'PRODUCER_LOCK', parent / 'PRODUCER_LOCK')


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def creator_factory():
    return CreatorFactory


# ---------------------------------------------------------------------------
# The 2Z ledger (dj.apps.ledger, ): every money path in the product now
# calls the ledger's SQL functions, which need the `sys:*` rows and the one
# `ledger_config` row that migration 0001 seeded -- and a `transaction=True`
# test flushes those away for every test after it. So every database test
# gets them back (one cheap probe when they are there), and every test that
# issued a ledger statement is checked for the two invariants that must hold
# whatever the test did: R1 (each maintained balance equals its journal) and
# R3 (the whole ledger sums to zero). R2 (`Creator.tuzis * 1000 == balance`)
# is deliberately NOT asserted here: a test that writes `tuzis` directly is
# simulating an old pod, and the drift it leaves is healed on the next touch,
# not at teardown (design §10 step 3; tuzis/test_ledger_dual_write.py covers
# it). The ledger's own suite asserts all three itself and is excluded.
# ---------------------------------------------------------------------------


def _test_uses_the_database(request) -> bool:
    names = set(request.fixturenames)
    return bool(
        names & {"db", "transactional_db", "django_db_reset_sequences",
                 "django_db_serialized_rollback"}
        or request.node.get_closest_marker("django_db") is not None
    )


@pytest.fixture(autouse=True)
def _ledger_rows_and_invariants(request):
    if not _test_uses_the_database(request):
        yield
        return
    request.getfixturevalue("db")
    from django.db import DatabaseError, connection

    from dj.apps.ledger import api as ledger_api
    from dj.apps.ledger import invariants
    from dj.apps.ledger.seed import ensure_system_rows

    ensure_system_rows()
    from dj.apps.economy.models import EconomicPolicy
    EconomicPolicy.objects.get_or_create(id=True)
    before = ledger_api.statements_issued
    yield
    try:
        if ledger_api.statements_issued == before:
            return
        if "dj/apps/ledger/tests" in str(request.node.fspath).replace("\\", "/"):
            return
        if request.node.get_closest_marker("ledger_drift_expected") is not None:
            return  # a reconciler test that corrupts the ledger on purpose
        if connection.needs_rollback:
            return  # the test left its transaction aborted; nothing can be read
        try:
            r1 = invariants.r1_maintained_balance_equals_journal()
            r3 = invariants.r3_all_accounts_sum_to_zero()
        except DatabaseError:
            return  # an aborted transaction the flag did not show; the test itself reports it
        assert r1 == [], f"ledger R1 drift after {request.node.nodeid}: {r1}"
        assert r3 == 0, f"ledger R3 drift after {request.node.nodeid}: {r3}"
    finally:
        marker = request.node.get_closest_marker("django_db")
        if marker and marker.kwargs.get("transaction") and not connection.needs_rollback:
            # Check R1/R3 first. Django flush omits these unmanaged partitions;
            # their committed receipts must not contaminate the next test.
            with connection.cursor() as cursor:
                cursor.execute("TRUNCATE ledger_transfer, ledger_transfer_key, ledger_ai_usage")


@pytest.fixture
def recent_login():
    """Establish a real session with a recent AuthContext for link-success tests."""
    def sign_in(client, user):
        from types import SimpleNamespace
        from dj.apps.identity.auth_context import record_login, AMR_PASSWORD

        from django.conf import settings

        client.force_login(user)
        session = client.session
        record_login(SimpleNamespace(session=session), user, methods=[AMR_PASSWORD])
        client.cookies[settings.SESSION_COOKIE_NAME] = session.session_key
    return sign_in
