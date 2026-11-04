"""The publish-vs-edit race on a rate card.

The riskiest line in ``pricing/0002_ratecard``: the model-row trigger locks
the card row ``FOR SHARE`` UNCONDITIONALLY. A publisher opens a transaction
and publishes (uncommitted); an editor then inserts a row onto the same card.
The editor must BLOCK on the card row, and once the publish commits it must
see the card as published and be refused -- never land a price on a card
that is already published.

Negative control (run while writing this): with the ``FOR SHARE`` removed
from the trigger, the editor does not block, reads the pre-publish row, and
its insert commits onto the published card -- this test then fails on the
``is_alive`` assertion.

Two real connections to the test database, so this needs
``transaction=True`` (committed data other sessions can see).
"""
import threading

import psycopg
import pytest
from django.db import connection

from dj.apps.pricing.models import RateCard, RateCardModel

INSERT_SQL = (
    "INSERT INTO pricing_ratecard_model (rate_card_id, model_id, "
    "input_nusd_per_mtok, cached_input_nusd_per_mtok, "
    "cache_write_5m_nusd_per_mtok, cache_write_1h_nusd_per_mtok, "
    "output_nusd_per_mtok, image_nusd, tool_call_nusd, min_charge_2z) "
    "VALUES (%s, %s, 1, 1, 1, 1, 1, 0, 0, 1)"
)


def _raw_connection():
    s = connection.settings_dict
    return psycopg.connect(
        host=s["HOST"], port=s["PORT"], user=s["USER"], password=s["PASSWORD"],
        dbname=s["NAME"],
    )


@pytest.mark.django_db(transaction=True)
def test_an_edit_racing_a_publish_is_refused_not_lost():
    card = RateCard.objects.create(version=950)
    with connection.cursor() as cur:
        cur.execute(INSERT_SQL, [card.pk, "base"])

    publisher = _raw_connection()
    editor = _raw_connection()
    outcome = {}
    try:
        # psycopg opens a transaction implicitly; NOT committed yet.
        publisher.execute(
            "UPDATE pricing_ratecard SET published_at = now() WHERE id = %s", [card.pk]
        )

        def edit():
            try:
                editor.execute(INSERT_SQL, [card.pk, "late"])
                editor.commit()
                outcome["result"] = "inserted"
            except psycopg.Error as exc:
                editor.rollback()
                outcome["result"] = type(exc).__name__

        t = threading.Thread(target=edit, daemon=True)
        t.start()
        t.join(timeout=1.5)
        assert t.is_alive(), "the editor must block on the card row while a publish is open"
        publisher.commit()
        t.join(timeout=15)
        assert not t.is_alive()
        assert outcome["result"] == "IntegrityConstraintViolation", outcome
        assert not RateCardModel.objects.filter(rate_card=card, model_id="late").exists()
        assert RateCardModel.objects.filter(rate_card=card, model_id="base").exists()
    finally:
        publisher.close()
        editor.close()


@pytest.mark.django_db(transaction=True)
def test_an_edit_that_wins_the_race_is_carried_by_the_publish():
    """The other order: the insert holds its lock first, the publish waits
    and then publishes a card that includes the row."""
    card = RateCard.objects.create(version=951)
    editor = _raw_connection()
    publisher = _raw_connection()
    try:
        editor.execute(INSERT_SQL, [card.pk, "first"])  # uncommitted, holds FOR SHARE
        done = threading.Event()

        def publish():
            publisher.execute(
                "UPDATE pricing_ratecard SET published_at = now() WHERE id = %s", [card.pk]
            )
            publisher.commit()
            done.set()

        t = threading.Thread(target=publish, daemon=True)
        t.start()
        assert not done.wait(1.5), "the publish must wait for the in-flight edit"
        editor.commit()
        assert done.wait(15)
        card.refresh_from_db()
        assert card.published_at is not None
        assert list(card.model_rows.values_list("model_id", flat=True)) == ["first"]
    finally:
        editor.close()
        publisher.close()
