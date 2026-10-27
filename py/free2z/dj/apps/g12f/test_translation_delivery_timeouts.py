"""Worker-side translation transactions are BOUNDED .

The ``translation`` queue shares a PgBouncer pool of two server connections
with the ledger worker. The delivery transaction locks the zPage row, and an
API request holding that row can keep it for as long as gunicorn runs the
request (600 s). Waiting that out would pin a pooled connection and stall the
ledger worker. So the delivery and ``charges.settle_failure`` ``SET LOCAL`` a
lock timeout and a statement timeout. A timeout is a RETRY: never a delivery,
never a refund.

Real Postgres, real row locks, held from a SECOND connection. That is the
only way to test this, which is why these are ``transaction=True``.

NEGATIVE CONTROL (both tests): delete the ``bound_worker_transaction()`` call
(in ``translate_zpage``'s delivery transaction, or in ``settle_failure``). The
worker then waits on the lock until the holder's safety timer releases it
(``HOLD_SECONDS``), then delivers or refunds, and the ``pytest.raises``
assertion fails. The timer is what keeps the control from hanging.
"""
import threading
from datetime import timedelta
from decimal import Decimal

import psycopg
import pytest
from django.db import DatabaseError, OperationalError, connection
from django.utils import timezone

from dj.apps.g12f.models import ZPageTranslation, zPage
from dj.apps.g12f.translation import charges, service
from dj.apps.g12f.translation.tasks import DeliveryContended, translate_zpage
from dj.apps.tuzis.models import IdempotencyKey

from dj.apps.openai.models import AIModel
from dj.apps.g12f.test_translation_settlement import (  # noqa: F401
    Provider,
    balance,
    buy,
    client_for,
    keyed_provider,
    make_page,
    record_for,
    roomy_ceilings,
    run_job,
)

#Seconds the second connection holds its lock if nobody releases it first.
#Only the negative control ever waits this long.
HOLD_SECONDS = 4


class RowLock:
    """``SELECT... FOR UPDATE`` one row from a second connection."""

    def __init__(self, table, pk):
        config = connection.settings_dict
        self.conn = psycopg.connect(
            host=config["HOST"], port=config["PORT"], dbname=config["NAME"],
            user=config["USER"], password=config["PASSWORD"],
        )
        self.conn.execute(
            f'SELECT 1 FROM "{table}" WHERE id = %s FOR UPDATE', [pk]
        ).fetchone()
        self._mutex = threading.Lock()
        self._released = False
        self._timer = threading.Timer(HOLD_SECONDS, self.release)
        self._timer.start()

    def release(self):
        with self._mutex:
            if self._released:
                return
            self._released = True
            self._timer.cancel()
            self.conn.rollback()
            self.conn.close()


@pytest.fixture
def isolated_model(settings):
    """``transaction=True`` flushes the migration-seeded catalogue, so these
    tests bring their own row -- the same pattern, and for the same reason, as
    ``test_translation_purchase.transaction_quote_model``."""
    model = AIModel.objects.create(
        provider="openai", model="delivery-timeout-test",
        display_name="Delivery timeout test", system_message="Test",
        max_tokens=16384, is_enabled=True,
    )
    settings.ZPAGE_TRANSLATION_MODELS = [f"{model.provider}:{model.model}"]
    return model


@pytest.fixture
def no_queue(monkeypatch):
    """``transaction=True`` runs on_commit hooks; capture the defer."""
    monkeypatch.setattr(translate_zpage, "defer", lambda **kwargs: None)


@pytest.fixture
def short_lock_timeout(settings):
    settings.ZPAGE_TRANSLATION_LOCK_TIMEOUT_MS = 300


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("isolated_model", "no_queue", "short_lock_timeout")
def test_a_locked_zpage_retries_the_delivery_and_neither_delivers_nor_refunds(
    creator_factory, monkeypatch
):
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    response = buy(client_for(creator), page)
    after_purchase = balance(creator)
    first = Provider()
    monkeypatch.setattr(service, "stream_chat", first)

    holder = RowLock(zPage._meta.db_table, page.pk)
    try:
        with pytest.raises(DeliveryContended) as excinfo:
            run_job(response)
    finally:
        holder.release()

    assert isinstance(excinfo.value.__cause__, DatabaseError)
    assert charges.is_contention(excinfo.value.__cause__)
    body = record_for(response)
    assert body["status"] == charges.QUEUED, "a lock timeout is not a refund"
    assert balance(creator) == after_purchase, "nothing was credited back"
    assert not ZPageTranslation.objects.filter(zpage=page).exists()
    assert body.get("_fragments"), "the paid-for fragments were not stashed"
    assert body["_contended_spend"]["calls"] == first.calls

    # SET LOCAL: the bound ended with its transaction and did not leak into
    # the (pooled) connection's session.
    with connection.cursor() as cursor:
        cursor.execute("SHOW lock_timeout")
        assert cursor.fetchone()[0] == "0"

    # The retry: the lock is gone, and every fragment the first run paid for
    # is recalled instead of being bought from the provider again.
    second = Provider()
    monkeypatch.setattr(service, "stream_chat", second)
    assert run_job(response) is True
    assert second.calls == 0
    assert record_for(response)["status"] == charges.DELIVERED
    assert balance(creator) == after_purchase


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("isolated_model", "no_queue", "short_lock_timeout")
def test_a_locked_charge_record_makes_settle_failure_raise_without_crediting(
    creator_factory,
):
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    response = buy(client_for(creator), page)
    after_purchase = balance(creator)
    record = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    )

    holder = RowLock(IdempotencyKey._meta.db_table, record.pk)
    try:
        with pytest.raises(DatabaseError) as excinfo:
            charges.settle_failure(record.pk, code="provider_error")
    finally:
        holder.release()

    assert charges.is_contention(excinfo.value)
    assert record_for(response)["status"] == charges.QUEUED
    assert balance(creator) == after_purchase

    # Once the lock is gone the same call settles normally.
    assert charges.settle_failure(record.pk, code="provider_error") is True
    assert record_for(response)["status"] == charges.REFUNDED


class _LockNotAvailable(Exception):
    """Stands in for psycopg's error, carrying the SQLSTATE we classify on."""

    sqlstate = "55P03"


def _contended_error():
    exc = OperationalError("canceling statement due to lock timeout")
    exc.__cause__ = _LockNotAvailable()
    return exc


@pytest.mark.django_db
@pytest.mark.usefixtures("isolated_model")
def test_a_contended_settlement_keeps_its_spend_for_the_retry(
    creator_factory, monkeypatch
):
    """codex review of, round 5, finding 2. A run that failed on its
    output and then lost the lock race SETTLING it must not leave the retry an
    empty meter: the retry recalls the stashed fragments (no second provider
    bill) and settles against the first run's spend.

    The real-Postgres timeout in ``settle_failure`` is pinned by
    ``test_a_locked_charge_record_makes_settle_failure_raise_without_crediting``;
    this one pins the task's handling of it.

    NEGATIVE CONTROL: delete the ``stash_contended_run`` call in ``give_up``'s
    ``except DatabaseError`` and the retry pays the provider again and settles
    with only its own (empty) spend.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def inject_a_link(fragment):
        return f"[tr] {fragment}\n\n[x](https://not-in-the-source.example/)"

    first = Provider(transform=inject_a_link)
    monkeypatch.setattr(service, "stream_chat", first)
    real_settle = charges.settle_failure
    attempts = []

    def contended_once(*args, **kwargs):
        attempts.append(kwargs.get("code"))
        if len(attempts) == 1:
            raise _contended_error()
        return real_settle(*args, **kwargs)

    monkeypatch.setattr(charges, "settle_failure", contended_once)

    with pytest.raises(OperationalError):
        run_job(response)
    body = record_for(response)
    assert body["status"] == charges.QUEUED
    assert body["_contended_spend"]["calls"] == first.calls > 0

    second = Provider(transform=inject_a_link)
    monkeypatch.setattr(service, "stream_chat", second)
    assert run_job(response) is False

    body = record_for(response)
    assert attempts == ["url_not_in_source", "url_not_in_source"]
    assert second.calls == 0, "the retry bought the document again"
    assert body["status"] == charges.REFUNDED
    assert body["provider_billed"] is True
    assert body["provider_calls"] == first.calls
    assert balance(creator) == before


@pytest.mark.django_db
@pytest.mark.usefixtures("isolated_model")
def test_the_reaper_counts_the_spend_of_a_charge_that_kept_losing_lock_races(
    creator_factory,
):
    """codex review of, round 5, finding 3: every delivery attempt
    stashed its spend and then lost the lock again, so the reaper is what
    settles it. Still a full refund -- but counted toward the ceilings.

    NEGATIVE CONTROL: make ``_contended_meter`` return ``(None, None)`` and
    the refund records ``provider_billed: false`` and no cost.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    record = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    )
    body = dict(record.response_body)
    body["_contended_spend"] = {
        "calls": 3, "input_tokens": 50_000, "output_tokens": 50_000,
    }
    # Past the OUTER deadline: `buy` enqueued a real job that is still `todo`,
    # and the reaper waits for a job still in the queue until
    # `abandoned_hard_after()` rather than refunding it at `abandoned_after()`.
    IdempotencyKey.objects.filter(pk=record.pk).update(
        response_body=body,
        created_at=timezone.now() - charges.abandoned_hard_after()
        - timedelta(minutes=1),
    )

    assert charges.reap_abandoned() == 1

    body = record_for(response)
    assert body["status"] == charges.REFUNDED
    assert body["error"] == "abandoned"
    assert body["refunded"] == body["charged"]
    assert balance(creator) == before
    assert body["provider_billed"] is True
    assert body["provider_calls"] == 3
    assert body["estimated_cost"] > 0


@pytest.mark.django_db
@pytest.mark.usefixtures("isolated_model")
def test_an_early_failure_after_contention_is_still_priced(creator_factory):
    """codex review of, round 6: the article is deleted during the retry
    delay, so the retry fails at its very first check -- before the model is
    resolved -- and the stashed spend was priced against no model at all.

    NEGATIVE CONTROL: delete the ``priced["model"] =...`` line in the
    ``_contended_spend`` seeding block and ``estimated_cost`` is 0.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    record = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    )
    body = dict(record.response_body)
    body["_contended_spend"] = {
        "calls": 3, "input_tokens": 50_000, "output_tokens": 50_000,
    }
    IdempotencyKey.objects.filter(pk=record.pk).update(response_body=body)
    page.delete()

    assert run_job(response) is False

    body = record_for(response)
    assert body["error"] == "zpage_gone"
    assert body["refunded"] == body["charged"]
    assert balance(creator) == before
    assert body["provider_billed"] is True
    assert body["estimated_cost"] > 0


def _contend_the_first_delivery(response, page, monkeypatch):
    """Run the job once with the zPage row locked: it generates the whole
    document, loses the delivery lock race and stashes its run."""
    first = Provider()
    monkeypatch.setattr(service, "stream_chat", first)
    holder = RowLock(zPage._meta.db_table, page.pk)
    try:
        with pytest.raises(DeliveryContended):
            run_job(response)
    finally:
        holder.release()
    body = record_for(response)
    assert body["status"] == charges.QUEUED
    assert body["_contended_spend"]["calls"] == first.calls > 0
    assert body["_fragments"]
    return body["_contended_spend"]


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("no_queue", "short_lock_timeout")
def test_a_contended_delivery_records_the_cost_of_the_attempt_that_paid(
    creator_factory, monkeypatch, isolated_model
):
    """codex review of, round 7, finding 3. The retry recalls every
    stashed fragment at no provider cost, so its own token counts are ~0; the
    delivered ``actual_cost`` must still count what the contended attempt
    spent, or the "settled under its cost" signal goes blind on exactly the
    runs that cost us twice the lock waits.

    NEGATIVE CONTROL: drop ``+ contended_in`` / ``+ contended_out`` from the
    ``actual_cost`` computation in ``translate_zpage`` and ``actual_cost`` is 0.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    response = buy(client_for(creator), page)
    spent = _contend_the_first_delivery(response, page, monkeypatch)

    second = Provider()
    monkeypatch.setattr(service, "stream_chat", second)
    run_job(response)

    body = record_for(response)
    assert body["status"] == charges.DELIVERED
    assert second.calls == 0
    assert body["actual_cost"] == service.translation_price(
        isolated_model, spent["input_tokens"], spent["output_tokens"]
    ) > 0


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("isolated_model", "no_queue", "short_lock_timeout")
def test_a_warned_delivery_of_another_purchase_does_not_void_this_charges_stash(
    creator_factory, monkeypatch
):
    """codex review of, round 7, finding 2. Another purchase of the same
    document delivered WITH WARNINGS voids the fragment cache for re-buys --
    but not this charge's own contention stash, which is the output of an
    earlier attempt at this same purchase. Voiding it made every contended
    retry pay the provider for the whole document again, against one quote.

    NEGATIVE CONTROL: drop ``own_record_pk=record.pk`` from the
    ``carried_fragments`` call in ``translate_zpage`` and the retry calls the
    provider again.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    response = buy(client_for(creator), page)
    _contend_the_first_delivery(response, page, monkeypatch)

    record = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    )
    sibling = {
        key: value for key, value in record.response_body.items()
        if not key.startswith("_")
    }
    sibling.update(
        job_id="an-earlier-purchase",
        status=charges.DELIVERED,
        warnings=[{
            "code": "code_identifier_not_preserved",
            "detail": "an earlier purchase came back with a warning",
            "items": ["flexibility"],
        }],
    )
    earlier = IdempotencyKey.objects.create(
        scope=charges.SCOPE, key="an-earlier-purchase", user=creator,
        response_body=sibling,
    )
    IdempotencyKey.objects.filter(pk=earlier.pk).update(
        created_at=record.created_at - timedelta(minutes=5)
    )
    # The void itself still holds for anyone else asking (a re-buy).
    assert charges.carried_fragments(
        creator, page.pk, sibling["language"], sibling["source_digest"],
        sibling["ai_model_id"],
    ) == {}

    second = Provider()
    monkeypatch.setattr(service, "stream_chat", second)
    run_job(response)

    body = record_for(response)
    assert second.calls == 0, "the retry bought the document again"
    assert body["status"] == charges.DELIVERED


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("isolated_model", "no_queue", "short_lock_timeout")
def test_a_rebuy_after_a_contended_delivery_pays_the_provider_again(
    creator_factory, monkeypatch
):
    """Independent review of, finding 3.

    A contended delivery stashes ``_fragments`` on its charge record so the
    RETRY of that purchase finishes without paying the provider twice. Left on
    the record after the retry delivers, ``carried_fragments`` hands that stash
    to the creator's NEXT purchase of the same document: a re-roll, paid at
    full price, that replays the old translation with zero provider calls.

    NEGATIVE CONTROL: drop the ``drop=`` argument from ``charges.mark_delivered``
    and the re-buy makes no provider calls (``fresh.calls == 0``) and the
    delivered record still carries ``_fragments``.
    """
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    first_buy = buy(client, page)
    monkeypatch.setattr(service, "stream_chat", Provider())
    holder = RowLock(zPage._meta.db_table, page.pk)
    try:
        with pytest.raises(DeliveryContended):
            run_job(first_buy)
    finally:
        holder.release()
    assert record_for(first_buy).get("_fragments"), "nothing was stashed"

    retry = Provider()
    monkeypatch.setattr(service, "stream_chat", retry)
    assert run_job(first_buy) is True
    delivered = record_for(first_buy)
    assert delivered["status"] == charges.DELIVERED
    assert retry.calls == 0, "the retry should have replayed its own stash"
    assert "_fragments" not in delivered
    assert "_contended_spend" not in delivered

    before = balance(creator)
    second_buy = buy(client, page)
    assert second_buy.status_code in (200, 201, 202), second_buy.data
    fresh = Provider()
    monkeypatch.setattr(service, "stream_chat", fresh)
    assert run_job(second_buy) is True
    assert record_for(second_buy)["status"] == charges.DELIVERED
    assert before - balance(creator) == Decimal(second_buy.data["price"])
    assert fresh.calls > 0, "the re-buy replayed the previous purchase's stash"


def test_the_bounds_fit_the_translation_lanes_30_second_budget():
    """: one PgBouncer server connection, ``query_wait_timeout`` 30 s,
    Procrastinate heartbeat timeout 30 s. Both bounds must sit well inside
    that, and the lock bound under the statement bound so a lock wait reports
    as 55P03."""
    lock = charges.DEFAULT_WORKER_LOCK_TIMEOUT_MS
    statement = charges.DEFAULT_WORKER_STATEMENT_TIMEOUT_MS
    assert lock == 5_000
    assert statement == 15_000
    assert lock < statement <= 30_000 // 2


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("isolated_model", "no_queue", "short_lock_timeout")
def test_a_retry_after_contention_settles_against_the_spend_already_made(
    creator_factory, monkeypatch
):
    """codex review of, round 4. A contended delivery is retried with a
    fresh meter; if the creator edits the article during the retry delay, the
    retry fails BEFORE any provider call -- and without the stashed spend it
    settles as if nothing had ever been generated, which also drops it out of
    the failure ceilings.

    NEGATIVE CONTROL: delete the ``_contended_spend`` seeding at the top of
    ``translate_zpage`` and ``provider_billed`` comes back False.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    response = buy(client_for(creator), page)
    first = Provider()
    monkeypatch.setattr(service, "stream_chat", first)

    holder = RowLock(zPage._meta.db_table, page.pk)
    try:
        with pytest.raises(DeliveryContended):
            run_job(response)
    finally:
        holder.release()
    stashed = record_for(response)["_contended_spend"]
    assert stashed["calls"] == first.calls > 0

    page.content = page.content + "\n\nEdited during the retry delay.\n"
    page.save()
    second = Provider()
    monkeypatch.setattr(service, "stream_chat", second)
    assert run_job(response) is False

    body = record_for(response)
    assert body["error"] == "source_changed"
    assert second.calls == 0
    assert body["provider_billed"] is True
    assert body["provider_calls"] == stashed["calls"]
    assert body["estimated_cost"] > 0


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("isolated_model", "no_queue", "short_lock_timeout")
def test_one_locked_charge_does_not_stop_the_reaper_refunding_the_rest(
    creator_factory,
):
    """codex review of, round 4: the bounded refund raises on a lock
    timeout, and the sweep had no per-record handling, so one locked charge
    withheld every later creator's refund until the next sweep.

    NEGATIVE CONTROL: remove the ``except DatabaseError`` from
    ``reap_abandoned`` and the sweep raises before reaching the second charge.
    """
    first_creator = creator_factory(tuzis=Decimal("100"))
    second_creator = creator_factory(tuzis=Decimal("100"))
    first = buy(client_for(first_creator), make_page(first_creator))
    second = buy(client_for(second_creator), make_page(second_creator))
    long_ago = timezone.now() - charges.abandoned_after() - timedelta(hours=1)
    for offset, response in enumerate((first, second)):
        IdempotencyKey.objects.filter(
            scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
        ).update(created_at=long_ago + timedelta(minutes=offset))
    locked = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=first.data["job_id"]
    )

    holder = RowLock(IdempotencyKey._meta.db_table, locked.pk)
    try:
        assert charges.reap_abandoned() == 1
    finally:
        holder.release()

    assert record_for(first)["status"] == charges.QUEUED
    assert record_for(second)["status"] == charges.REFUNDED
    # The next sweep picks the skipped one up.
    assert charges.reap_abandoned() == 1
    assert record_for(first)["status"] == charges.REFUNDED


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("isolated_model", "no_queue", "short_lock_timeout")
def test_a_locked_charge_record_skips_the_start_stamp_and_the_job_still_delivers(
    creator_factory, monkeypatch
):
    """``charges.mark_started`` is bounded ( security round): a second
    connection holding the charge row makes it give up after the lock timeout
    and SKIP the stamp. The job is neither failed nor refunded over it; it
    delivers and is charged, and ``_count_mutations`` falls back to
    ``created_at`` for the missing stamp.

    NEGATIVE CONTROLS (each verified red): delete the
    ``bound_worker_transaction()`` call in ``mark_started`` and it waits out
    the holder's ``HOLD_SECONDS`` timer and stamps (the elapsed and
    ``started_at`` assertions fail); delete the ``except DatabaseError``
    branch and the lock timeout escapes ``translate_zpage``.
    """
    import time

    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    response = buy(client_for(creator), page)
    after_purchase = balance(creator)
    monkeypatch.setattr(service, "stream_chat", Provider())

    real_mark_started = charges.mark_started
    observed = {}

    def mark_started_under_contention(record_pk, **kwargs):
        holder = RowLock(IdempotencyKey._meta.db_table, record_pk)
        began = time.monotonic()
        try:
            observed["result"] = real_mark_started(record_pk, **kwargs)
        finally:
            observed["elapsed"] = time.monotonic() - began
            holder.release()
        return observed["result"]

    monkeypatch.setattr(charges, "mark_started", mark_started_under_contention)

    assert run_job(response) is True

    assert observed["result"] is None, "the stamp was written through the lock"
    assert observed["elapsed"] < HOLD_SECONDS / 2, (
        "mark_started waited for the holder instead of timing out"
    )
    body = record_for(response)
    assert body["status"] == charges.DELIVERED
    assert "started_at" not in body
    assert balance(creator) == after_purchase, "charged once, not refunded"
    assert ZPageTranslation.objects.filter(zpage=page).exists()
    with connection.cursor() as cursor:
        cursor.execute("SHOW lock_timeout")
        assert cursor.fetchone()[0] == "0"


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("isolated_model", "no_queue", "short_lock_timeout")
def test_an_uncontended_start_is_still_stamped(creator_factory, monkeypatch):
    """The positive half: with nobody holding the row the stamp is written,
    so the test above is not passing because stamping is simply broken."""
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator)
    response = buy(client_for(creator), page)
    monkeypatch.setattr(service, "stream_chat", Provider())

    assert run_job(response) is True

    body = record_for(response)
    assert body["status"] == charges.DELIVERED
    assert body.get("started_at")


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("isolated_model", "no_queue", "short_lock_timeout")
def test_a_contended_retry_is_not_refused_by_the_failure_ceiling(
    creator_factory, monkeypatch, settings
):
    """Review of. The worker re-checks the failed-spend ceilings before
    provider work, but a retry after a contended delivery HAS no provider work
    left: the document was generated and paid for, and the retry replays the
    stash. Refusing it there refunds a finished translation and adds its spend
    to the total that refused it.

    NEGATIVE CONTROL: drop the ``meter.billable`` guard on the worker's
    ceiling re-check and the retry settles ``failure_cooldown`` instead of
    delivering.
    """
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    contended = buy(client, page)
    sibling = buy(client, make_page(creator))
    monkeypatch.setattr(service, "stream_chat", Provider())
    holder = RowLock(zPage._meta.db_table, page.pk)
    try:
        with pytest.raises(DeliveryContended):
            run_job(contended)
    finally:
        holder.release()

    # While the retry waits, a sibling from the same batch fails after real
    # provider work and takes the creator over the ceiling.
    monkeypatch.setattr(service, "stream_chat", Provider(fail_after=1))
    run_job(sibling)
    assert record_for(sibling)["status"] == "refunded"
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER = 1
    _, spend = charges.failed_spend(user=creator)
    assert spend >= 1, "the sibling's failure must reach the ceiling"

    retry = Provider()
    monkeypatch.setattr(service, "stream_chat", retry)
    assert run_job(contended) is True
    body = record_for(contended)
    assert body["status"] == charges.DELIVERED, body.get("error")
    assert retry.calls == 0


@pytest.mark.django_db
@pytest.mark.usefixtures("isolated_model")
def test_a_partial_contended_retry_still_stops_at_the_failure_ceiling(
    creator_factory, monkeypatch, settings
):
    """Review of  (codex round). The other half of the test above: a
    retry that already spent but has fragments LEFT to generate must still
    stop before buying them once the ceiling is reached -- at its first new
    provider call, not before the replay.

    NEGATIVE CONTROL: delete the ``settlement.before_generation()`` call in
    ``service`` and the retry pays the provider for the missing fragment.
    """
    creator = creator_factory(tuzis=Decimal("1000"))
    page = make_page(creator)
    client = client_for(creator)
    response = buy(client, page)
    sibling = buy(client, make_page(creator))

    first = Provider(fail_after=1)
    monkeypatch.setattr(service, "stream_chat", first)
    real_settle = charges.settle_failure
    attempts = []

    def contended_once(*args, **kwargs):
        attempts.append(kwargs.get("code"))
        if len(attempts) == 1:
            raise _contended_error()
        return real_settle(*args, **kwargs)

    monkeypatch.setattr(charges, "settle_failure", contended_once)
    with pytest.raises(OperationalError):
        run_job(response)
    stashed = record_for(response)
    assert stashed["status"] == charges.QUEUED
    assert stashed.get("_fragments"), "the paid-for fragment was not stashed"

    monkeypatch.setattr(service, "stream_chat", Provider(fail_after=1))
    run_job(sibling)
    assert record_for(sibling)["status"] == charges.REFUNDED
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER = 1

    retry = Provider()
    monkeypatch.setattr(service, "stream_chat", retry)
    assert run_job(response) is False
    body = record_for(response)
    assert retry.calls == 0, "the retry bought more after the ceiling"
    assert body["error"] == "failure_cooldown"
    assert body["status"] == charges.REFUNDED
    assert body["provider_billed"] is True, "the first run's spend was lost"
