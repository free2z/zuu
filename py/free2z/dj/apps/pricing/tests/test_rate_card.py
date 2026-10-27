"""Rate cards: the seeded v1 card, the CHECKs, and immutability.

Real Postgres, real migrations: the immutability guarantee lives in triggers
created by migration 0002, so these tests exercise exactly what prod runs.
Every write that must be refused is attempted through ``QuerySet.update()``
or raw SQL as well as the ORM -- the paths ``save()`` guards cannot see.
"""
import hashlib
import importlib
import io
import json

import pytest
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.db.utils import InternalError
from django.utils import timezone

from dj.apps.openai.management.commands import seed_ai_models
from dj.apps.openai.models import AIModel
from dj.apps.pricing import rate_card_seeds
from dj.apps.pricing.ai import Usage, price_2z
from dj.apps.pricing.models import RateCard, RateCardModel

pytestmark = pytest.mark.django_db

# Postgres raises the triggers' 'integrity_constraint_violation' (23000) as
# IntegrityError; accept InternalError too so a psycopg mapping change reads
# as a refusal rather than a pass.
REFUSED = (IntegrityError, InternalError)

frozen = importlib.import_module("dj.apps.pricing.migrations.0003_seed_rate_card_v1")

PRICE_FIELDS = dict(
    input_nusd_per_mtok=3_000_000_000,
    cached_input_nusd_per_mtok=300_000_000,
    cache_write_5m_nusd_per_mtok=3_750_000_000,
    cache_write_1h_nusd_per_mtok=6_000_000_000,
    output_nusd_per_mtok=15_000_000_000,
    image_nusd=0,
    tool_call_nusd=0,
)


@pytest.fixture(autouse=True)
def _cards_seeded():
    """Re-run each migration's own seed function if its card is missing.

    A ``transactional_db`` test elsewhere in the session ends with a flush
    (TRUNCATE, which fires no row trigger) that wipes migration-seeded rows,
    so relying on the migration's side effect would make these tests
    order-dependent. Running each frozen ``seed`` still tests migration code
    itself -- a no-op when the migration's row survived.
    """
    from django.apps import apps

    for _version, _name, module in rate_card_seeds.seed_migrations():
        module.seed(apps, None)


def _draft(version=900, **kw):
    return RateCard.objects.create(version=version, **kw)


def _row(card, model_id="m", **kw):
    return RateCardModel.objects.create(rate_card=card, model_id=model_id, **{**PRICE_FIELDS, **kw})


def _publish(card, active=True):
    RateCard.objects.filter(pk=card.pk).update(published_at=timezone.now(), active=active)
    card.refresh_from_db()
    return card


def _refused(fn):
    with pytest.raises(REFUSED):
        with transaction.atomic():
            fn()


# ------------------------------------------------------------- the seed


def test_migration_seeded_v1_published_active_at_2000_bps():
    card = RateCard.objects.get(version=1)
    assert card.platform_margin_bps == 2000
    assert card.is_published and card.active
    assert card.model_rows.count() == len(frozen.ROWS)
    assert set(card.model_rows.values_list("min_charge_2z", flat=True)) == {1}


def test_the_newest_seed_prices_every_lineup_model():
    version, _name, module = rate_card_seeds.newest_seed()
    card = RateCard.objects.get(version=version)
    assert card.is_published and card.active
    assert card.model_rows.count() == len(seed_ai_models.LINEUP) == len(module.ROWS)


# Recorded content digests of every seed migration, by version. A seed that
# has been applied anywhere is HISTORY: editing it makes fresh databases and
# prod disagree about what that version is. A new card is a new migration and
# a new line here, never a changed one.
RECORDED_SEED_DIGESTS = {
    1: "d392b010746cbddb15b8dd6ec5e17dadc1a728d2a2c4b4700bed3677d1931d23",
    2: "b4f8166d303be50760aa2c20447fa6963f43d7e8adaec8e031c08ee4523883c8",
    3: "bae214ae6770ec1ac846bb482206d67de5ff205dc2627b34556a962263b8994d",
}


def _seed_digest(module):
    payload = json.dumps(
        [module.VERSION, module.PLATFORM_MARGIN_BPS, module.MIN_MARGIN_BPS,
         list(module.COLUMNS), [list(r) for r in module.ROWS]],
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def test_seed_migrations_are_history():
    seeds = rate_card_seeds.seed_migrations()
    assert {v: _seed_digest(m) for v, _, m in seeds} == RECORDED_SEED_DIGESTS, (
        "A rate-card seed migration changed or appeared. An APPLIED seed is "
        "history and must never be edited (prod will not re-run it); a NEW "
        "card is a NEW 'NNNN_seed_rate_card_vN.py' plus a NEW line in "
        "RECORDED_SEED_DIGESTS."
    )
    assert [v for v, _, _ in seeds] == list(range(1, len(seeds) + 1))


def test_lineup_matches_the_newest_seeded_card():
    drift = seed_ai_models.lineup_drift()
    assert drift == [], "\n".join(drift)


def test_a_lineup_change_without_a_new_seed_names_the_right_remedy(monkeypatch):
    """Reprice a LINEUP model and add no migration: the failure must send the
    author to a NEW migration, never back into an applied card."""
    original = seed_ai_models.LINEUP
    monkeypatch.setattr(seed_ai_models, "LINEUP", [
        (*original[0][:3], "0.000003", *original[0][4:]),
        *original[1:],
    ])
    version, name, _module = rate_card_seeds.newest_seed()
    assert (version, name) == (3, "0006_seed_rate_card_v3")
    drift = seed_ai_models.lineup_drift()
    assert any(line.startswith("gpt-4o:") for line in drift)
    remedy = drift[-1]
    assert remedy.startswith("REMEDY: add a NEW migration pricing/migrations/0007_seed_rate_card_v4.py")
    assert "Do NOT edit 0006_seed_rate_card_v3.py" in remedy


def test_a_new_lineup_model_without_a_new_seed_is_drift(monkeypatch):
    original = seed_ai_models.LINEUP
    monkeypatch.setattr(seed_ai_models, "LINEUP", [
        *original,
        (seed_ai_models.OPENAI, "gpt-new", "New", "0.000001", "0.000002", 128000, 8192, 8192, 1, True),
    ])
    drift = seed_ai_models.lineup_drift()
    assert "gpt-new: in LINEUP, not on card v3" in drift
    assert drift[-1].startswith("REMEDY: add a NEW migration")


def test_seed_prices_are_lineup_prices_exactly():
    rows = {r["model_id"]: r for r in seed_ai_models.rate_card_rows()}
    gpt4o = rows["gpt-4o"]  # LINEUP: $2.50 / $10 per 1M
    assert gpt4o["input_nusd_per_mtok"] == 2_500_000_000
    assert gpt4o["output_nusd_per_mtok"] == 10_000_000_000
    sonnet = rows["claude-sonnet-5"]  # $2 in: 0.1x read, 1.25x 5m, 2x 1h
    assert sonnet["cached_input_nusd_per_mtok"] == 200_000_000
    assert sonnet["cache_write_5m_nusd_per_mtok"] == 2_500_000_000
    assert sonnet["cache_write_1h_nusd_per_mtok"] == 4_000_000_000
    sol = rows["gpt-5.6-sol"]  # $5 in: 0.1x read, 1.25x write (GPT-5.6+)
    assert sol["cached_input_nusd_per_mtok"] == 500_000_000
    assert sol["cache_write_5m_nusd_per_mtok"] == 6_250_000_000
    for row in rows.values():
        # No class below input except a documented cache read.
        assert row["cached_input_nusd_per_mtok"] <= row["input_nusd_per_mtok"]
        assert row["cache_write_5m_nusd_per_mtok"] >= row["input_nusd_per_mtok"]
        assert row["cache_write_1h_nusd_per_mtok"] >= row["cache_write_5m_nusd_per_mtok"]


def test_seed_refuses_image_prices_for_token_billed_providers(monkeypatch):
    monkeypatch.setattr(seed_ai_models, "RATE_CARD_IMAGE_NUSD", 1)
    with pytest.raises(ValueError, match="image_nusd must be zero"):
        seed_ai_models.rate_card_rows()


def test_seed_command_is_idempotent_and_never_edits_a_published_card(monkeypatch):
    card, created, drift = seed_ai_models.ensure_rate_card()
    assert card.version == 3 and created == [] and drift == []
    # A LINEUP that moved on is REPORTED (with the remedy), never written.
    original = seed_ai_models.LINEUP
    monkeypatch.setattr(seed_ai_models, "LINEUP", [
        (*original[0][:3], "0.000003", *original[0][4:]),
        *original[1:],
    ])
    card, created, drift = seed_ai_models.ensure_rate_card()
    assert created == []
    assert drift[-1].startswith("REMEDY: add a NEW migration")
    assert card.model_rows.get(model_id="gpt-4o").input_nusd_per_mtok == 2_500_000_000
    out = io.StringIO()
    call_command("seed_ai_models", stdout=out)
    assert "0007_seed_rate_card_v4.py" in out.getvalue()


def test_seed_command_recreates_a_missing_card_from_its_migration(monkeypatch):
    """A flushed database converges on what ``migrate`` gives prod: the card
    comes from the seed migration's own rows, NOT from today's LINEUP."""
    # The published v1 row cannot be deleted, so move it aside.
    with connection.cursor() as cur:
        cur.execute("ALTER TABLE pricing_ratecard DISABLE TRIGGER pricing_ratecard_guard")
        cur.execute("UPDATE pricing_ratecard SET version = 777 WHERE version = 1")
        cur.execute("ALTER TABLE pricing_ratecard ENABLE TRIGGER pricing_ratecard_guard")
    original = seed_ai_models.LINEUP
    monkeypatch.setattr(seed_ai_models, "LINEUP", [
        (*original[0][:3], "0.000003", *original[0][4:]),
        *original[1:],
    ])
    _card, created, drift = seed_ai_models.ensure_rate_card()
    assert created == [1]
    assert drift  # LINEUP was changed without a migration -- reported
    v1 = RateCard.objects.get(version=1)
    assert v1.is_published and v1.active and v1.platform_margin_bps == 2000
    rows = list(v1.model_rows.order_by("id").values(*frozen.COLUMNS))
    assert rows == rate_card_seeds.seed_rows(frozen)
    assert v1.model_rows.get(model_id="gpt-4o").input_nusd_per_mtok == 2_500_000_000


# ----------------------------------------------------------- the CHECKs


def test_min_charge_below_one_is_refused():
    card = _draft()
    _refused(lambda: _row(card, min_charge_2z=0))
    row = _row(card)
    _refused(lambda: RateCardModel.objects.filter(pk=row.pk).update(min_charge_2z=0))


def test_all_zero_prices_are_refused():
    card = _draft()
    _refused(lambda: _row(card, **{k: 0 for k in PRICE_FIELDS}))
    _row(card, "img", **{**{k: 0 for k in PRICE_FIELDS}, "image_nusd": 1})


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_token_billed_provider_image_price_refuses_card_publication(provider):
    AIModel.objects.create(
        provider=provider, model="double-charged", display_name="Model",
        system_message="s", max_tokens=128_000,
    )
    card = _draft()
    _row(card, "double-charged", image_nusd=1)
    _refused(lambda: _publish(card))


def test_non_token_billed_provider_may_have_per_image_price():
    AIModel.objects.create(
        provider="xai", model="image-priced", display_name="Model",
        system_message="s", max_tokens=128_000,
    )
    card = _draft()
    _row(card, "image-priced", image_nusd=1)
    assert _publish(card).is_published


def test_activation_rechecks_image_prices_after_provider_metadata_changes():
    model = AIModel.objects.create(
        provider="xai", model="image-priced", display_name="Model",
        system_message="s", max_tokens=128_000,
    )
    card = _draft()
    _row(card, "image-priced", image_nusd=1)
    _publish(card, active=False)
    AIModel.objects.filter(pk=model.pk).update(provider="openai")
    _refused(lambda: RateCard.objects.filter(pk=card.pk).update(active=True))


def test_duplicate_model_on_a_card_is_refused():
    card = _draft()
    _row(card, "dup")
    _refused(lambda: _row(card, "dup"))


def test_margin_checks():
    _refused(lambda: _draft(platform_margin_bps=100, min_margin_bps=200))
    _refused(lambda: _draft(platform_margin_bps=100_001))
    _refused(lambda: _draft(version=0))
    _refused(lambda: _draft(active=True))  # active requires published
    assert _draft().platform_margin_bps == 2000  # the owner-decided default


def test_database_default_margin_is_2000():
    with connection.cursor() as cur:
        cur.execute(
            "INSERT INTO pricing_ratecard (version, created_at) VALUES (901, now()) "
            "RETURNING platform_margin_bps, min_margin_bps, active"
        )
        assert cur.fetchone() == (2000, 0, False)


# ------------------------------------------------------ immutability


def test_a_draft_is_freely_editable():
    card = _draft()
    row = _row(card)
    RateCardModel.objects.filter(pk=row.pk).update(output_nusd_per_mtok=1)
    RateCard.objects.filter(pk=card.pk).update(platform_margin_bps=2500)
    row.delete()
    card.delete()


def test_published_card_rows_cannot_be_inserted_updated_or_deleted():
    card = _draft()
    row = _row(card)
    _publish(card)
    _refused(lambda: _row(card, "late"))
    _refused(lambda: RateCardModel.objects.filter(pk=row.pk).update(output_nusd_per_mtok=1))
    _refused(lambda: RateCardModel.objects.filter(pk=row.pk).delete())
    other = _draft(902)
    # Moving a row OFF a published card is an edit of that card.
    _refused(lambda: RateCardModel.objects.filter(pk=row.pk).update(rate_card=other))

    def raw_update():
        with connection.cursor() as cur:
            cur.execute(
                "UPDATE pricing_ratecard_model SET input_nusd_per_mtok = 1 WHERE id = %s",
                [row.pk],
            )

    _refused(raw_update)
    row.refresh_from_db()
    assert row.output_nusd_per_mtok == PRICE_FIELDS["output_nusd_per_mtok"]


def test_moving_a_row_onto_a_published_card_is_refused():
    published = _draft(903)
    _row(published, "x")
    _publish(published)
    draft = _draft(904)
    row = _row(draft, "y")
    _refused(lambda: RateCardModel.objects.filter(pk=row.pk).update(rate_card=published))


def test_an_empty_card_cannot_be_activated():
    empty = _publish(_draft(910), active=False)
    _refused(lambda: RateCard.objects.filter(pk=empty.pk).update(active=True))
    draft = _draft(911)
    _refused(lambda: RateCard.objects.filter(pk=draft.pk).update(
        published_at=timezone.now(), active=True))
    _refused(lambda: RateCard.objects.create(
        version=912, published_at=timezone.now(), active=True))
    # With a row, publishing and activating in one statement is fine.
    _row(draft)
    RateCard.objects.filter(pk=draft.pk).update(published_at=timezone.now(), active=True)


def test_a_column_added_later_is_frozen_on_a_published_card_too():
    """The guard compares whole rows minus ``active``; it does not list
    columns, so a future migration's column needs no trigger change."""
    card = _draft(913)
    _row(card)
    _publish(card)
    with connection.cursor() as cur:
        cur.execute("ALTER TABLE pricing_ratecard ADD COLUMN note text")  # rolled back with the test

    def edit_note():
        with connection.cursor() as cur:
            cur.execute("UPDATE pricing_ratecard SET note = 'x' WHERE id = %s", [card.pk])

    _refused(edit_note)
    draft = _draft(914)
    with connection.cursor() as cur:
        cur.execute("UPDATE pricing_ratecard SET note = 'x' WHERE id = %s", [draft.pk])


def test_published_card_terms_cannot_change_but_active_can():
    card = _draft()
    _row(card)
    _publish(card)
    _refused(lambda: RateCard.objects.filter(pk=card.pk).update(platform_margin_bps=1))
    _refused(lambda: RateCard.objects.filter(pk=card.pk).update(min_margin_bps=1))
    _refused(lambda: RateCard.objects.filter(pk=card.pk).update(version=999))
    _refused(lambda: RateCard.objects.filter(pk=card.pk).update(published_at=None, active=False))
    _refused(lambda: RateCard.objects.filter(pk=card.pk).update(published_at=timezone.now()))
    _refused(lambda: RateCard.objects.filter(pk=card.pk).delete())
    # Rotation: deactivate and reactivate.
    RateCard.objects.filter(pk=card.pk).update(active=False)
    RateCard.objects.filter(pk=card.pk).update(active=True)


def test_the_seeded_v1_card_is_immutable():
    v1 = RateCard.objects.get(version=1)
    _refused(lambda: RateCard.objects.filter(pk=v1.pk).update(platform_margin_bps=5000))
    _refused(lambda: v1.model_rows.update(min_charge_2z=2))
    _refused(lambda: v1.model_rows.all().delete())


# ------------------------------------------------------------ pricing


def test_row_prices_through_the_crate_formula_on_its_cards_margin():
    v1 = RateCard.objects.get(version=1)
    row = v1.model_rows.get(model_id="claude-sonnet-5")
    usage = Usage(input_tokens=1200, cached_input_tokens=5000, cache_write_tokens=800, output_tokens=350)
    charge = row.price(usage)
    assert charge == price_2z(usage, row.model_prices(), 2000, 0, 1)
    # $0.01335 at 20 %: 1.602 2Z -> 2 2Z (the crate fixture's vector at 50 % is 3).
    assert charge.total_milli == 2000
    assert charge.provider_milli == 1335


def test_gpt4o_cached_input_repricing_preserves_historical_card():
    """A million cached tokens used to cost 300 2Z; current cost-plus is 150.

    Exercise migrated rows through the actual pricing function, not a mirror
    of the seed tuple. Existing holds must retain their historical v1 price.
    """
    old = RateCard.objects.get(version=1).model_rows.get(model_id="gpt-4o")
    current = RateCard.objects.get(version=2).model_rows.get(model_id="gpt-4o")
    usage = Usage(cached_input_tokens=1_000_000)
    assert old.price(usage).total_milli == 300_000
    assert current.price(usage).total_milli == 150_000
    assert current.rate_card.is_published and current.rate_card.active
    _refused(lambda: RateCardModel.objects.filter(pk=current.pk).update(
        cached_input_nusd_per_mtok=2_500_000_000))


@pytest.mark.parametrize("conflict", ["draft", "price", "margin", "inactive", "missing_model"])
def test_v2_seed_rejects_existing_conflicting_card(conflict):
    from django.apps import apps

    v2 = importlib.import_module("dj.apps.pricing.migrations.0004_seed_rate_card_v2")
    # Move the genuine immutable card aside only in this test transaction.
    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE pricing_ratecard DISABLE TRIGGER pricing_ratecard_guard")
        cursor.execute("UPDATE pricing_ratecard SET version = 778 WHERE version = 2")
        cursor.execute("ALTER TABLE pricing_ratecard ENABLE TRIGGER pricing_ratecard_guard")
    card = RateCard.objects.create(version=2, platform_margin_bps=2001 if conflict == "margin" else 2000)
    rows = rate_card_seeds.seed_rows(v2)
    if conflict == "price":
        rows[0]["cached_input_nusd_per_mtok"] = 2_500_000_000
    if conflict == "missing_model":
        rows.pop()
    RateCardModel.objects.bulk_create(RateCardModel(rate_card=card, **row) for row in rows)
    if conflict != "draft":
        _publish(card, active=conflict != "inactive")
    with pytest.raises(RuntimeError, match="rate card v2 conflicts"):
        v2.seed(apps, None)


def test_v2_seed_identical_published_card_is_a_noop():
    from django.apps import apps

    v2 = importlib.import_module("dj.apps.pricing.migrations.0004_seed_rate_card_v2")
    before = list(RateCard.objects.values())
    model_rows = list(RateCardModel.objects.order_by("pk").values())
    v2.seed(apps, None)
    assert list(RateCard.objects.values()) == before
    assert list(RateCardModel.objects.order_by("pk").values()) == model_rows
