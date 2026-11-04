"""The signed catalogue is built from ONE database snapshot.

Codex review: a request read active card A; a concurrent transaction then
published card B and saved an AIModel; the request's revision read counted
that save, so card A's prices went out under a revision that already covered
card B -- and the next request, serving B, computed the same revision and the
gateway ignored it as ``Unchanged``.

Committed data from a second, real connection, so ``transaction=True``: the
isolation level only matters between separate sessions, and a test wrapped in
the usual per-test transaction would not exercise it at all (``build_catalog``
cannot set an isolation level inside an enclosing transaction).

Negative control (run while writing this): with the ``SET TRANSACTION
ISOLATION LEVEL REPEATABLE READ`` removed from ``build_catalog`` the racing
build returns card A under the concurrent save's revision and
``test_a_concurrent_publish_cannot_lend_its_revision_to_the_old_card`` fails.
"""
import psycopg
import pytest
from django.db import connection

from dj.apps.openai.models import AIModel
from dj.apps.pricing import catalog
from dj.apps.pricing.models import RateCard, RateCardModel
from dj.apps.pricing.tests.test_ai_catalog import (
    PRICES,
    SAMPLE_CARD_VERSION,
    SAMPLE_CONTENT_TS,
    SAMPLE_MODELS,
    SAMPLE_NOW,
    _ai_model,
    _at,
    _publish,
)

U = catalog.VERSION_UNITS_PER_SECOND
NEW_CARD = SAMPLE_CARD_VERSION + 1
CONCURRENT_SAVE = SAMPLE_NOW - 5


def _raw_connection():
    s = connection.settings_dict
    return psycopg.connect(
        host=s["HOST"], port=s["PORT"], user=s["USER"], password=s["PASSWORD"],
        dbname=s["NAME"], autocommit=True,
    )


def _dataset():
    RateCard.objects.update(active=False)
    AIModel.objects.all().delete()
    card = RateCard.objects.create(version=SAMPLE_CARD_VERSION, platform_margin_bps=2000)
    for provider, model, pmid, style, ctx, out, ttfb, safety, prices in SAMPLE_MODELS:
        _ai_model(provider, model, pmid, style, ctx, out, ttfb, safety)
        RateCardModel.objects.create(rate_card=card, model_id=model, **prices)
    AIModel.objects.update(updated_at=_at(SAMPLE_CONTENT_TS))
    return _publish(card)


def _publish_card_b_and_save_a_model(other):
    """What the concurrent transaction commits, on its own connection."""
    with other.cursor() as cur:
        cur.execute(
            "INSERT INTO pricing_ratecard (version, platform_margin_bps, min_margin_bps, "
            "active, created_at) VALUES (%s, 2500, 0, false, now()) RETURNING id",
            [NEW_CARD])
        card_id = cur.fetchone()[0]
        for _, model, *_rest in SAMPLE_MODELS:
            cur.execute(
                "INSERT INTO pricing_ratecard_model (rate_card_id, model_id, "
                "input_nusd_per_mtok, cached_input_nusd_per_mtok, "
                "cache_write_5m_nusd_per_mtok, cache_write_1h_nusd_per_mtok, "
                "output_nusd_per_mtok, image_nusd, tool_call_nusd, min_charge_2z) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, 0, 0, 1)",
                [card_id, model, PRICES["input_nusd_per_mtok"],
                 PRICES["cached_input_nusd_per_mtok"], PRICES["cache_write_5m_nusd_per_mtok"],
                 PRICES["cache_write_1h_nusd_per_mtok"], PRICES["output_nusd_per_mtok"]])
        cur.execute(
            "UPDATE pricing_ratecard SET published_at = %s, active = true WHERE id = %s",
            [_at(CONCURRENT_SAVE - 1), card_id])
        cur.execute(
            "UPDATE openai_aimodel SET updated_at = %s WHERE model = 'grok-4.5'",
            [_at(CONCURRENT_SAVE)])


@pytest.mark.django_db(transaction=True)
def test_a_concurrent_publish_cannot_lend_its_revision_to_the_old_card(monkeypatch):
    _dataset()
    other = _raw_connection()
    real_revision = catalog.content_revision
    fired = []

    def revision_after_a_concurrent_commit(card):
        # Card A has been read; the concurrent transaction commits now,
        # between the card read and the revision read.
        if not fired:
            _publish_card_b_and_save_a_model(other)
            fired.append(True)
        return real_revision(card)

    monkeypatch.setattr(catalog, "content_revision", revision_after_a_concurrent_commit)
    try:
        racing = catalog.build_catalog(SAMPLE_NOW)
        assert fired
        # The whole build saw the snapshot from before the commit: card A,
        # and a revision that does not yet count card B or the save.
        assert racing["rate_card_version"] == SAMPLE_CARD_VERSION
        assert racing["version"] == catalog.window_start(SAMPLE_NOW) * U
        # The next build sees both, under a strictly newer version.
        after = catalog.build_catalog(SAMPLE_NOW)
        assert after["rate_card_version"] == NEW_CARD
        assert after["platform_margin_bps"] == 2500
        assert after["version"] == CONCURRENT_SAVE * U > racing["version"]
    finally:
        other.close()

