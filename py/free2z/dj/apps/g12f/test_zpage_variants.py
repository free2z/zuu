"""ZPageVariant: schema, M2 backfill, and M3 dual write ( wave 2b).

Against real Postgres, because every property under test here is a database
property: two partial/unique indexes, an ``ON CONFLICT DO NOTHING`` insert, and
a mirror write that has to commit inside somebody else's transaction. Mocking
the database would test none of it.

The backfill is exercised by calling the migration module's own functions with
the real models. A historical model from ``apps.get_model`` and a real model
expose the identical queryset API for everything the backfill uses
(``values()``, ``values_list()``, ``bulk_create``), so this runs the shipped
code rather than a paraphrase of it -- and it lets the interrupt/resume test
inject a failure mid-sweep, which a ``migrate``-driven test cannot.
"""
import importlib
import uuid

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f import localization, variants as variant_service
from dj.apps.g12f.models import zPage, ZPageTranslation, ZPageVariant
from dj.apps.g12f.tasks import publish_zpage


backfill_migration = importlib.import_module(
    "dj.apps.g12f.migrations.0100_backfill_zpage_variants"
)


class _RealApps:
    """``apps`` stand-in handing the migration the live models."""

    _models = {
        ("g12f", "zpage"): zPage,
        ("g12f", "zpagetranslation"): ZPageTranslation,
        ("g12f", "zpagevariant"): ZPageVariant,
    }

    def get_model(self, app_label, model_name):
        return self._models[(app_label, model_name.lower())]


def run_backfill():
    backfill_migration.backfill(_RealApps(), None)


def make_page(creator, **overrides):
    values = {
        "creator": creator,
        "free2zaddr": str(uuid.uuid4()),
        "title": "English title",
        "description": "English description",
        "content": "English body",
        "source_language": "en",
        "is_published": True,
    }
    values.update(overrides)
    return zPage.objects.create(**values)


def source_variant(page):
    return page.variants.get(origin=ZPageVariant.SOURCE)


def assert_shapes_agree(page):
    """The M3 invariant: the variant table says what the legacy shape says.

    This is the assertion M5 depends on. If it holds after every write path,
    flipping reads to variants is behaviour-preserving by construction.
    """
    page.refresh_from_db()
    source = source_variant(page)
    assert source.language == page.source_language
    assert source.title == page.title
    assert source.description == page.description
    assert source.content == page.content
    assert source.is_published == page.is_published
    assert source.source_digest is None
    assert source.ai_model_id is None

    for translation in page.translations.all():
        variant = page.variants.get(language=translation.language)
        assert variant.origin == ZPageVariant.HUMAN
        assert variant.title == translation.title
        assert variant.description == translation.description
        assert variant.content == translation.content
        assert variant.is_published == translation.is_published

    # No orphans: exactly one variant per legacy row.
    assert page.variants.count() == 1 + page.translations.count()


# --------------------------------------------------------------------------- #
# Schema — the two constraints are the design
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_one_variant_per_language(creator_factory):
    page = make_page(creator_factory())
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            ZPageVariant.objects.create(
                zpage=page, language="en", title="dup", content="dup",
                origin=ZPageVariant.HUMAN,
            )


@pytest.mark.django_db
def test_only_one_source_variant_per_page(creator_factory):
    page = make_page(creator_factory())
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            ZPageVariant.objects.create(
                zpage=page, language="fr", title="second source",
                content="body", origin=ZPageVariant.SOURCE,
            )


@pytest.mark.django_db
def test_many_non_source_variants_per_page(creator_factory):
    """The partial index constrains `origin='source'` and nothing else."""
    page = make_page(creator_factory())
    for language in ("es", "fr", "ja"):
        ZPageVariant.objects.create(
            zpage=page, language=language, title=language, content="body",
            origin=ZPageVariant.HUMAN,
        )
    assert page.variants.count() == 4


@pytest.mark.django_db
def test_a_wide_bcp47_tag_survives_a_round_trip(creator_factory):
    """The widening this wave exists to do, proven against the real column.

    `ca-ES-valencia` is 14 characters and `yue-Hant-HK` is 11; both used to be
    a `DataError` on INSERT into `varchar(10)`.
    """
    page = make_page(creator_factory(), source_language="ca-ES-valencia")
    ZPageVariant.objects.create(
        zpage=page, language="yue-Hant-HK", title="粵語", content="body",
        origin=ZPageVariant.HUMAN,
    )
    page.refresh_from_db()
    assert page.source_language == "ca-ES-valencia"
    assert source_variant(page).language == "ca-ES-valencia"
    assert page.variants.get(origin=ZPageVariant.HUMAN).language == \
        "yue-Hant-HK"


# --------------------------------------------------------------------------- #
# Staleness is tri-state, and NULL is not "stale"
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_staleness_is_unknown_for_a_backfilled_translation(creator_factory):
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", content="Contenido",
    )
    source = source_variant(page)
    translated = page.variants.get(language="es")

    # Backfilled/mirrored provenance is NULL: unknown, NOT stale.
    assert translated.source_digest is None
    assert variant_service.staleness(translated, source) is None
    # The source has nothing to be measured against.
    assert variant_service.staleness(source, source) is None


@pytest.mark.django_db
def test_staleness_is_exact_once_provenance_is_recorded(creator_factory):
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", content="Contenido",
    )
    source = source_variant(page)
    translated = page.variants.get(language="es")

    translated.source_digest = variant_service.content_digest(source.content)
    assert variant_service.staleness(translated, source) is False

    page.content = "A rewritten English body"
    page.save()
    assert variant_service.staleness(translated, source_variant(page)) is True


# --------------------------------------------------------------------------- #
# M3 dual write — every legacy write path
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_creating_a_page_through_the_api_writes_a_source_variant(
    creator_factory,
):
    creator = creator_factory(tuzis=5)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.post("/api/zpage/", {
        "title": "Ein Titel",
        "content": "Ein deutscher Artikel.",
        "description": "Beschreibung",
        "source_language": "de",
        "tags": [],
    }, format="json")

    assert response.status_code == 201
    page = zPage.objects.get(free2zaddr=response.data["free2zaddr"])
    assert page.source_language == "de"
    assert_shapes_agree(page)


@pytest.mark.django_db
def test_editing_canonical_content_updates_the_source_variant(
    creator_factory,
):
    creator = creator_factory()
    page = make_page(creator)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(f"/api/zpage/{page.free2zaddr}/", {
        "title": "Rewritten title",
        "content": "Rewritten body",
        "description": "Rewritten description",
        "is_published": True,
        "tags": [],
    }, format="json")

    assert response.status_code == 200
    assert_shapes_agree(page)
    assert source_variant(page).title == "Rewritten title"


@pytest.mark.django_db
def test_writing_a_translation_mirrors_a_human_variant(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(
        f"/api/zpage/{page.free2zaddr}/translations/es/", {
            "title": "Título",
            "content": "Contenido en español",
            "description": "Descripción",
            "is_published": True,
            "tags": [],
        }, format="json")

    assert response.status_code == 200
    assert_shapes_agree(page)
    variant = page.variants.get(language="es")
    assert variant.origin == ZPageVariant.HUMAN
    assert variant.is_published is True


@pytest.mark.django_db
def test_deleting_a_translation_removes_its_variant(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    assert page.variants.filter(language="es").exists()

    client = APIClient()
    client.force_authenticate(creator)
    response = client.delete(f"/api/zpage/{page.free2zaddr}/translations/es/")

    assert response.status_code == 204
    assert not page.variants.filter(language="es").exists()
    assert_shapes_agree(page)


@pytest.mark.django_db
def test_relabelling_the_source_renames_the_variant(creator_factory):
    """ §3.2 mutable label, and the reason the lookup key is `origin`.

    Keying the upsert on `(zpage, language)` would mint a *second* source
    variant here and trip `uniq_zpage_source_variant`.
    """
    creator = creator_factory()
    page = make_page(creator, source_language="und")
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(f"/api/zpage/{page.free2zaddr}/", {
        "title": "English title",
        "content": "English body",
        "description": "English description",
        "source_language": "en",
        "is_published": True,
        "tags": [],
    }, format="json")

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.source_language == "en"
    assert page.variants.filter(origin=ZPageVariant.SOURCE).count() == 1
    assert source_variant(page).language == "en"
    assert_shapes_agree(page)


@pytest.mark.django_db
def test_relabelling_onto_an_existing_translation_is_refused(creator_factory):
    """The §3.2 collision rule, now a 409 (P6).

    It was a 400 when this landed in wave 2b because nothing at that layer
    could express a conflict. It is a 409 because nothing about the request is
    malformed -- ``source_language: "es"`` succeeds the moment the Spanish
    translation is gone -- and because the client's next move differs: a 400
    means "fix your payload", a 409 means "deal with the other resource first".
    The message names it in words a creator can act on.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
    )
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(f"/api/zpage/{page.free2zaddr}/", {
        "title": "English title",
        "content": "English body",
        "source_language": "es",
        "is_published": True,
        "tags": [],
    }, format="json")

    assert response.status_code == 409
    assert "Spanish translation already exists" in str(response.data["detail"])
    page.refresh_from_db()
    assert page.source_language == "en"
    assert_shapes_agree(page)


@pytest.mark.django_db
def test_scheduled_publishing_publishes_the_source_variant(creator_factory):
    """`publish_zpage` uses a queryset UPDATE, which fires no post_save.

    Without the explicit mirror call in the task, every scheduled publication
    would leave the variant table claiming the page is still a draft -- a
    divergence nobody would notice until M5 flipped reads.
    """
    page = make_page(
        creator_factory(),
        is_published=False,
        publish_at=timezone.now() - timezone.timedelta(minutes=1),
    )
    assert source_variant(page).is_published is False

    assert publish_zpage(zpage_id=page.pk) is True

    page.refresh_from_db()
    assert page.is_published is True
    assert source_variant(page).is_published is True
    assert_shapes_agree(page)


@pytest.mark.django_db
def test_a_vote_does_not_touch_the_variant(creator_factory):
    """`cache_total()` saves with `update_fields`, none of which a variant holds.

    Skipping the mirror on those saves is what keeps the hot vote path at the
    query count it has today.
    """
    page = make_page(creator_factory())
    before = source_variant(page)

    page.tuzi_total = 5
    page.cache_total()

    after = source_variant(page)
    assert after.pk == before.pk
    assert after.updated_at == before.updated_at


@pytest.mark.django_db
def test_the_mirror_costs_a_bounded_number_of_queries(creator_factory):
    """Pin the write-path cost so nobody turns the mirror into an N+1.

    Three statements per canonical save: the collision check, the locking
    SELECT and the UPDATE. Constant in the number of translations a page has
    -- which is the property that matters, because the obvious wrong
    implementation loops over variants.
    """
    creator = creator_factory()
    page = make_page(creator)
    for language in ("es", "fr", "ja", "de", "pt-BR"):
        ZPageTranslation.objects.create(
            zpage=page, language=language, title=language, content="body",
        )

    page.title = "Retitled"
    with CaptureQueriesContext(connection) as captured:
        page.save()

    mirror_queries = [
        query for query in captured.captured_queries
        if "g12f_zpagevariant" in query["sql"]
    ]
    assert len(mirror_queries) == 3, [q["sql"] for q in mirror_queries]


@pytest.mark.django_db
def test_renaming_a_translation_leaves_no_ghost_variant(creator_factory):
    """`language` is the variant's key AND is editable in the admin.

    Renaming `es` -> `fr` must move the variant, not clone it. A leftover `es`
    row is a translation that exists in no authoritative table, and M5 would
    publish it to readers.
    """
    page = make_page(creator_factory())
    translation = ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
    )
    assert page.variants.filter(language="es").exists()

    translation.language = "fr"
    translation.save()

    assert not page.variants.filter(language="es").exists()
    assert page.variants.filter(language="fr").exists()
    assert_shapes_agree(page)


@pytest.mark.django_db
def test_scheduled_publishing_is_all_or_nothing(creator_factory, monkeypatch):
    """The page and its source variant publish in ONE transaction.

    Without that, a worker dying between the compare-and-set and the mirror
    leaves the page permanently published in the legacy shape and permanently
    a draft in the variant shape -- and the retry takes the `updated == 0`
    no-op branch and never repairs it.
    """
    page = make_page(
        creator_factory(),
        is_published=False,
        publish_at=timezone.now() - timezone.timedelta(minutes=1),
    )

    class Evicted(RuntimeError):
        pass

    def boom(*args, **kwargs):
        raise Evicted("worker evicted after the compare-and-set")

    monkeypatch.setattr(
        "dj.apps.g12f.variants.publish_source_variant", boom
    )
    with pytest.raises(Evicted):
        publish_zpage(zpage_id=page.pk)

    # The publication rolled back with the mirror, so the retry still sees a
    # due, unpublished page.
    page.refresh_from_db()
    assert page.is_published is False
    assert page.publish_at is not None

    monkeypatch.undo()
    assert publish_zpage(zpage_id=page.pk) is True
    page.refresh_from_db()
    assert page.is_published is True
    assert source_variant(page).is_published is True


# --------------------------------------------------------------------------- #
# The admin is a write path too, and it lost its `<select>` with the enum
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_the_admin_form_normalizes_and_rejects_a_bogus_language(
    creator_factory,
):
    from dj.apps.g12f.admin import PageForm

    page = make_page(creator_factory())

    def form_for(language):
        data = {
            "creator": page.creator_id,
            "source_language": language,
            "title": page.title,
            "content": page.content,
            "description": page.description,
            "free2zaddr": page.free2zaddr,
            "category": "",
            "password": "",
            "p2paddr": "",
            "viewing_key": "",
            "canonical_url": "",
            "f2z_score": 0,
            "total": 0,
            "tuzi_total": 0,
            "tags": "",
        }
        return PageForm(data=data, instance=page)

    good = form_for("PT-br")
    good.is_valid()
    assert good.cleaned_data["source_language"] == "pt-BR"

    for bogus in ("English", "zz", "en-USA"):
        bad = form_for(bogus)
        assert not bad.is_valid(), bogus
        assert "source_language" in bad.errors, bogus

    # `und` stays saveable: most existing pages hold it, and a validator that
    # rejected it would make every legacy page unsaveable in the admin.
    legacy = form_for("und")
    legacy.is_valid()
    assert legacy.cleaned_data["source_language"] == "und"


@pytest.mark.django_db
def test_the_admin_form_refuses_a_colliding_relabel(creator_factory):
    """The §3.2 collision rule reaches the admin too, not just the API."""
    from dj.apps.g12f.admin import PageForm

    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
    )

    form = PageForm(data={
        "creator": page.creator_id,
        "source_language": "es",
        "title": page.title,
        "content": page.content,
        "description": page.description,
        "free2zaddr": page.free2zaddr,
        "category": "",
        "password": "",
        "p2paddr": "",
        "viewing_key": "",
        "canonical_url": "",
        "f2z_score": 0,
        "total": 0,
        "tuzi_total": 0,
        "tags": "",
    }, instance=page)

    assert not form.is_valid()
    assert "source_language" in form.errors


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=False, ZPAGE_VARIANT_DUAL_WRITE=False)
def test_the_kill_switch_stops_mirroring(creator_factory):
    """Off is a valid state: nothing reads variants yet, and M2 re-runs.

    "Nothing reads variants yet" is the whole precondition, and it is now
    PINNED rather than inherited from the settings default: the switch is only
    honoured while reads are off, so a suite run with the production-parity
    ``ZPAGE_VARIANT_READS=true`` would otherwise fail this test for a reason
    that has nothing to do with what it is testing. The three tests below are
    the other half of the contract.
    """
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
    )
    assert page.variants.count() == 0


# --------------------------------------------------------------------------- #
# The kill switch is inert while readers read variants ( M6, )
# --------------------------------------------------------------------------- #
#
# `ZPAGE_VARIANT_DUAL_WRITE` was an escape hatch for the M3/M5 overlap, and the
# settings comment promised that turning it off "degrades nothing a user can
# see".  flipped `ZPAGE_VARIANT_READS` on in production and that promise
# expired: with reads on the mirror is the only path from a creator's write to
# a reader's screen, so the switch stops being a kill switch and becomes a way
# to serve the whole site stale content while every write returns 200.
#
# These assert the state is now unreachable rather than merely discouraged.


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True, ZPAGE_VARIANT_DUAL_WRITE=False)
def test_an_edit_still_reaches_the_variant_readers_read(creator_factory):
    """The article a reader is served is the article the creator just saved."""
    page = make_page(creator_factory(), title="Before", content="Old body")
    assert source_variant(page).title == "Before"

    page.title = "After"
    page.content = "New body"
    page.save()

    variant = source_variant(page)
    assert variant.title == "After", (
        "the source variant is what readers resolve since #1059; leaving it "
        "on the pre-edit text serves every reader a stale article"
    )
    assert variant.content == "New body"


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True, ZPAGE_VARIANT_DUAL_WRITE=False)
def test_a_new_translation_still_reaches_the_variant_readers_read(
    creator_factory,
):
    """A translation with no variant exists in no language menu at all."""
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", description="Descripción",
        content="Contenido", is_published=True,
    )

    variant = page.variants.get(language="es")
    assert variant.origin == ZPageVariant.HUMAN
    assert variant.content == "Contenido"


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True, ZPAGE_VARIANT_DUAL_WRITE=False)
def test_a_deleted_translation_still_leaves_the_variant_readers_read(
    creator_factory,
):
    """Deletion is a write too: an unmirrored delete keeps serving the row."""
    page = make_page(creator_factory())
    translation = ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    assert page.variants.filter(language="es").exists()

    translation.delete()

    assert not page.variants.filter(language="es").exists(), (
        "with reads on variants, an unmirrored delete leaves the deleted "
        "translation live on the site"
    )


@pytest.mark.django_db
def test_the_switch_is_still_honoured_in_the_documented_rollback_state():
    """It is not deleted, and reads-off is exactly where it still applies.

    The ``ZPAGE_VARIANT_READS=false`` rollback has to stay reachable until M6
    finishes and the legacy shape stops being written at all, so this
    pins the surviving half of the contract rather than only the new half.
    """
    with override_settings(
        ZPAGE_VARIANT_READS=False, ZPAGE_VARIANT_DUAL_WRITE=False
    ):
        assert variant_service.dual_write_enabled() is False
    with override_settings(
        ZPAGE_VARIANT_READS=False, ZPAGE_VARIANT_DUAL_WRITE=True
    ):
        assert variant_service.dual_write_enabled() is True
    with override_settings(
        ZPAGE_VARIANT_READS=True, ZPAGE_VARIANT_DUAL_WRITE=False
    ):
        assert variant_service.dual_write_enabled() is True


def test_the_guard_covers_every_reader_the_read_switch_covers():
    """``dual_write_enabled()`` is True wherever ``variant_reads_enabled()`` is.

    The guard calls ``localization.variant_reads_enabled()`` -- the same
    function every real read site calls -- rather than re-reading the setting,
    so the two cannot drift by construction. This asserts the RELATIONSHIP by
    calling both functions rather than re-asserting the settings matrix a
    second time, so the day someone reintroduces an open-coded ``getattr``
    here and ``variant_reads_enabled()`` grows a condition (a per-namespace
    value, a percentage rollout, a per-page override), the divergence lands
    here instead of on a reader.
    """
    for reads in (True, False):
        for dual_write in (True, False):
            with override_settings(
                ZPAGE_VARIANT_READS=reads, ZPAGE_VARIANT_DUAL_WRITE=dual_write
            ):
                if localization.variant_reads_enabled():
                    assert variant_service.dual_write_enabled() is True, (
                        "a pod that resolves content out of ZPageVariant must "
                        "mirror into it; reads=%r dual_write=%r"
                        % (reads, dual_write)
                    )


# --------------------------------------------------------------------------- #
# Ignoring the switch is not the same as ignoring it QUIETLY
# --------------------------------------------------------------------------- #
#
# The 3am shape: `sync_source_variant` starts raising (the
# `uniq_zpage_variant_language` collision this module documents as reachable),
# every page.save() 500s, on-call sets ZPAGE_VARIANT_DUAL_WRITE="false" in the
# ConfigMap and restarts api + worker -- and the 500s continue. If nothing says
# why, the guard has reproduced one layer up the exact failure it exists to
# prevent: a change is made, nothing behaves differently, nothing logs.


def test_ignoring_the_switch_says_so_in_the_logs(caplog, monkeypatch):
    monkeypatch.setattr(variant_service, "_dual_write_ignored_warned", False)
    with override_settings(
        ZPAGE_VARIANT_READS=True, ZPAGE_VARIANT_DUAL_WRITE=False
    ):
        with caplog.at_level("WARNING", logger=variant_service.__name__):
            assert variant_service.dual_write_enabled() is True
    messages = [r.getMessage() for r in caplog.records]
    assert any("ZPAGE_VARIANT_DUAL_WRITE" in m and "IGNORED" in m
               for m in messages), messages
    # An operator reading it must be able to act on it, so the message names
    # the other key rather than only stating that something was ignored.
    assert any("ZPAGE_VARIANT_READS" in m for m in messages), messages


def test_nothing_is_logged_when_the_switch_is_actually_honoured(
    caplog, monkeypatch
):
    """No warning in either state an operator has configured correctly.

    A guard that cries wolf on the documented rollback state -- or on the
    ordinary all-on production state -- gets muted, and then the message above
    is not there on the night it matters.
    """
    for reads, dual_write in ((False, False), (False, True), (True, True)):
        monkeypatch.setattr(
            variant_service, "_dual_write_ignored_warned", False
        )
        caplog.clear()
        with override_settings(
            ZPAGE_VARIANT_READS=reads, ZPAGE_VARIANT_DUAL_WRITE=dual_write
        ):
            with caplog.at_level("WARNING", logger=variant_service.__name__):
                variant_service.dual_write_enabled()
        assert caplog.records == [], (reads, dual_write, caplog.records)


def test_the_startup_check_reports_the_ignored_switch():
    """`manage.py check` -- CI, and every management command a deploy runs.

    gunicorn and daphne load the WSGI/ASGI app WITHOUT running system checks,
    which is why the runtime WARNING above exists too; this is the half that
    fires before any traffic and in the build.
    """
    from django.core.checks.registry import registry

    from dj.apps.g12f.checks import check_zpage_variant_flags

    assert check_zpage_variant_flags in registry.get_checks(), (
        "G12FConfig.ready() must register the check, or it never runs"
    )

    with override_settings(
        ZPAGE_VARIANT_READS=True, ZPAGE_VARIANT_DUAL_WRITE=False
    ):
        warnings = check_zpage_variant_flags(None)
    assert [w.id for w in warnings] == ["g12f.W001"], warnings
    assert "IGNORED" in warnings[0].msg

    for reads, dual_write in ((False, False), (False, True), (True, True)):
        with override_settings(
            ZPAGE_VARIANT_READS=reads, ZPAGE_VARIANT_DUAL_WRITE=dual_write
        ):
            assert check_zpage_variant_flags(None) == [], (reads, dual_write)


# --------------------------------------------------------------------------- #
# M2 backfill — idempotent, resumable, and correct on real-shaped data
# --------------------------------------------------------------------------- #
@pytest.fixture
def corpus(creator_factory):
    """A realistic corpus, built with mirroring OFF so the table starts empty.

    Covers every shape the production table actually holds: a legacy `und`
    page, a page with translations, a page with none, an unpublished draft
    with a draft translation, and the anomaly where a translation row claims
    the page's own source language.
    """
    creator = creator_factory()
    # Reads pinned off with it: the kill switch is inert while reads are on
    # (`variants.dual_write_enabled`), so without this the corpus would be
    # built MIRRORED and "the table starts empty" would be false.
    with override_settings(
        ZPAGE_VARIANT_READS=False, ZPAGE_VARIANT_DUAL_WRITE=False
    ):
        legacy = make_page(
            creator, source_language="und", title="Legacy", content="Old body",
        )
        with_translations = make_page(creator, title="Multi", content="Body")
        ZPageTranslation.objects.create(
            zpage=with_translations, language="es", title="Título",
            description="Descripción", content="Contenido", is_published=True,
        )
        ZPageTranslation.objects.create(
            zpage=with_translations, language="fr", title="Titre",
            content="Contenu", is_published=False,
        )
        lonely = make_page(creator, title="Alone", content="Just me")
        draft = make_page(
            creator, title="Draft", content="Unfinished", is_published=False,
        )
        ZPageTranslation.objects.create(
            zpage=draft, language="pt-BR", title="Rascunho",
            content="Inacabado", is_published=False,
        )
        # The anomaly: a translation row in the page's own source language.
        # The API cannot produce it; hand-edited or pre- data can.
        collided = make_page(creator, title="Collide", content="Canonical")
        ZPageTranslation.objects.create(
            zpage=collided, language="en", title="Shadow",
            content="Shadow body", is_published=True,
        )

    assert ZPageVariant.objects.count() == 0
    return {
        "legacy": legacy,
        "with_translations": with_translations,
        "lonely": lonely,
        "draft": draft,
        "collided": collided,
    }


@pytest.mark.django_db
def test_backfill_copies_the_whole_corpus(corpus):
    run_backfill()

    # 5 source variants + the 3 of the 4 translation rows that do not collide
    # with their page's own source language.
    assert ZPageVariant.objects.count() == 8

    legacy = source_variant(corpus["legacy"])
    assert legacy.language == "und"
    assert legacy.title == "Legacy"
    assert legacy.content == "Old body"
    assert legacy.source_digest is None

    multi = corpus["with_translations"]
    assert multi.variants.count() == 3
    spanish = multi.variants.get(language="es")
    assert spanish.origin == ZPageVariant.HUMAN
    assert spanish.description == "Descripción"
    assert spanish.is_published is True
    assert spanish.source_digest is None
    assert multi.variants.get(language="fr").is_published is False

    assert corpus["lonely"].variants.count() == 1

    draft = corpus["draft"]
    assert source_variant(draft).is_published is False
    assert draft.variants.get(language="pt-BR").is_published is False


@pytest.mark.django_db
def test_backfill_never_lets_a_translation_overwrite_the_source(corpus):
    """The collision case: the source is canonical content and must win."""
    run_backfill()

    collided = corpus["collided"]
    assert collided.variants.count() == 1
    only = source_variant(collided)
    assert only.language == "en"
    assert only.title == "Collide"
    assert only.content == "Canonical"


@pytest.mark.django_db
def test_backfill_is_idempotent(corpus):
    run_backfill()
    first = {
        (v.zpage_id, v.language): (v.pk, v.updated_at)
        for v in ZPageVariant.objects.all()
    }

    run_backfill()
    run_backfill()

    second = {
        (v.zpage_id, v.language): (v.pk, v.updated_at)
        for v in ZPageVariant.objects.all()
    }
    # Same rows, same primary keys, untouched timestamps: the re-runs wrote
    # nothing at all rather than re-creating or updating.
    assert second == first
    assert ZPageVariant.objects.count() == 8


@pytest.mark.django_db
def test_backfill_is_resumable_after_an_interrupted_batch(
    corpus, monkeypatch
):
    """Kill it mid-sweep, re-run, and the result is identical.

    BATCH_SIZE is shrunk to 2 so the fixture corpus spans several batches, and
    the third `bulk_create` is made to explode -- the shape of a pod being
    evicted or a deploy timing out partway through the migration.
    """
    monkeypatch.setattr(backfill_migration, "BATCH_SIZE", 2)

    real_bulk_create = ZPageVariant.objects.bulk_create
    calls = {"n": 0}

    class Boom(RuntimeError):
        pass

    def flaky(objs, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 3:
            raise Boom("evicted mid-batch")
        return real_bulk_create(objs, *args, **kwargs)

    monkeypatch.setattr(ZPageVariant.objects, "bulk_create", flaky)

    with pytest.raises(Boom):
        run_backfill()

    partial = ZPageVariant.objects.count()
    assert 0 < partial < 8, "the interrupt must land mid-corpus to be a test"

    monkeypatch.undo()
    monkeypatch.setattr(backfill_migration, "BATCH_SIZE", 2)
    run_backfill()

    assert ZPageVariant.objects.count() == 8
    assert ZPageVariant.objects.filter(
        origin=ZPageVariant.SOURCE
    ).count() == 5


@pytest.mark.django_db
def test_backfill_does_not_disturb_rows_dual_write_already_created(
    corpus, creator_factory,
):
    """Mid-rollout reality: some variants exist before the backfill reaches them.

    A page edited after the deploy has a mirrored variant carrying the *new*
    content. The backfill must skip it, not overwrite it with the row it read.
    """
    edited = corpus["lonely"]
    edited.title = "Edited after deploy"
    edited.content = "New body"
    edited.save()  # dual write is on again outside the fixture
    assert source_variant(edited).content == "New body"

    run_backfill()

    assert edited.variants.count() == 1
    assert source_variant(edited).content == "New body"
    assert ZPageVariant.objects.count() == 8


@pytest.mark.django_db
def test_backfill_skips_a_page_with_no_language(corpus):
    """NULL source_language cannot become a variant: the column is NOT NULL."""
    zPage.objects.filter(pk=corpus["lonely"].pk).update(source_language=None)

    run_backfill()

    assert corpus["lonely"].variants.count() == 0
    assert ZPageVariant.objects.count() == 7


@pytest.mark.django_db
def test_backfill_then_dual_write_stay_consistent(corpus):
    """End to end: backfill, then keep writing, and the shapes still agree."""
    run_backfill()

    page = corpus["with_translations"]
    page.title = "Multi, revised"
    page.save()
    page.translations.filter(language="fr").update(is_published=True)
    # A queryset.update() fires no signal, so re-sync the way a repair would.
    variant_service.sync_translation_variant(
        page.translations.get(language="fr")
    )

    assert_shapes_agree(page)


# --------------------------------------------------------------------------- #
# The migrations themselves, run for real against a realistic corpus
# --------------------------------------------------------------------------- #
BEFORE = ("g12f", "0096_alter_creator_total")
WIDENED = ("g12f", "0097_widen_language_columns")


def _leaf():
    """The newest g12f migration, read from the graph rather than hardcoded.

    Restoring to a hardcoded node is how a migration test leaves the shared
    test database behind the code for every `transaction=True` test that runs
    after it -- pytest-django runs those last, as a block, so the failure lands
    on someone else's test.
    """
    return MigrationLoader(connection).graph.leaf_nodes("g12f")[0]


def _all_leaves():
    """Restore every app leaf after this test's g12f-only migration dance."""
    return MigrationLoader(connection).graph.leaf_nodes()


def _column(table, column):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT character_maximum_length, is_nullable "
            "FROM information_schema.columns "
            "WHERE table_name = %s AND column_name = %s",
            [table, column],
        )
        return cursor.fetchone()


@pytest.mark.django_db(transaction=True)
def test_the_migration_series_runs_on_a_realistic_corpus():
    """0096 -> 0100 against data shaped like production, then back, then forward.

    The unit tests above call the backfill's functions directly. This one runs
    the shipped migrations through Django's own executor, in order, on rows
    created by the *old* schema -- which is the only way to catch a migration
    that is fine in isolation and wrong in sequence. Seeded through historical
    models, so no signal fires and nothing is pre-mirrored.
    """
    try:
        executor = MigrationExecutor(connection)
        executor.migrate([BEFORE])
        # 0097's reverse is state-only by design (narrowing a column that may
        # hold a wide value cannot be a safe rollback), so unwinding Django's
        # history does NOT restore varchar(10). Put the pre-0097 *database*
        # back by hand, so this test asserts against the real starting shape
        # no matter what ran before it in this session.
        with connection.cursor() as cursor:
            cursor.execute(
                "ALTER TABLE g12f_zpage "
                "ALTER COLUMN source_language TYPE varchar(10), "
                "ALTER COLUMN source_language SET NOT NULL"
            )
            cursor.execute(
                "ALTER TABLE g12f_zpagetranslation "
                "ALTER COLUMN language TYPE varchar(10)"
            )
        old_apps = executor.loader.project_state(BEFORE).apps
        Creator = old_apps.get_model("g12f", "Creator")
        ZPage = old_apps.get_model("g12f", "zPage")
        Translation = old_apps.get_model("g12f", "ZPageTranslation")

        owner = Creator.objects.create(username="variant-migration-owner")
        legacy = ZPage.objects.create(
            creator=owner, free2zaddr="variant-legacy-und",
            title="Legacy", description="", content="Legacy body",
            is_published=True,
        )
        translated = ZPage.objects.create(
            creator=owner, free2zaddr="variant-with-translations",
            title="Multi", description="Desc", content="Body",
            source_language="en", is_published=True,
        )
        Translation.objects.create(
            zpage=translated, language="es", title="Título",
            description="Descripción", content="Contenido", is_published=True,
        )
        Translation.objects.create(
            zpage=translated, language="fr", title="Titre",
            description="", content="Contenu", is_published=False,
        )
        alone = ZPage.objects.create(
            creator=owner, free2zaddr="variant-no-translations",
            title="Alone", description="", content="Just me",
            source_language="pt-BR", is_published=False,
        )
        # The old default really did apply: this is what `und` looks like.
        legacy.refresh_from_db()
        assert legacy.source_language == "und"

        # --- 0097: the widening, the blocking prerequisite for detection ----
        assert _column("g12f_zpage", "source_language") == (10, "NO")
        assert _column("g12f_zpagetranslation", "language") == (10, "NO")

        MigrationExecutor(connection).migrate([WIDENED])

        assert _column("g12f_zpage", "source_language") == (35, "YES")
        assert _column("g12f_zpagetranslation", "language") == (35, "NO")
        # A tag the old column could not hold now stores. Before 0097 this
        # exact statement is a DataError, which is the incident this wave
        # exists to prevent.
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE g12f_zpage SET source_language = 'ca-ES-valencia' "
                "WHERE free2zaddr = %s",
                ["variant-no-translations"],
            )

        # --- 0098 + 0099 + 0100 -------------------------------------------
        MigrationExecutor(connection).migrate(_all_leaves())

        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT z.free2zaddr, v.language, v.origin, v.title, "
                "v.content, v.is_published, v.source_digest "
                "FROM g12f_zpagevariant v "
                "JOIN g12f_zpage z ON z.id = v.zpage_id "
                "ORDER BY z.free2zaddr, v.language"
            )
            rows = cursor.fetchall()

        assert rows == [
            ("variant-legacy-und", "und", "source", "Legacy",
             "Legacy body", True, None),
            ("variant-no-translations", "ca-ES-valencia", "source", "Alone",
             "Just me", False, None),
            ("variant-with-translations", "en", "source", "Multi",
             "Body", True, None),
            ("variant-with-translations", "es", "human", "Título",
             "Contenido", True, None),
            ("variant-with-translations", "fr", "human", "Titre",
             "Contenu", False, None),
        ]

        # --- reverse the whole series, then re-apply -----------------------
        # M1-M3 must be undoable in a rollback. Reversing drops the variant
        # table and the detection columns; the 0097 column type/nullability is
        # deliberately state-only in reverse (see that migration's docstring),
        # so it stays widened, which no old code can tell apart.
        MigrationExecutor(connection).migrate([BEFORE])
        with connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('g12f_zpagevariant')")
            assert cursor.fetchone() == (None,)
        assert _column("g12f_zpage", "detected_language") is None
        #...and the documented asymmetry: the widened, nullable column stays.
        # Nothing in the pre- code can tell the difference -- it never
        # writes a tag longer than 5 characters and never writes NULL.
        assert _column("g12f_zpage", "source_language") == (35, "YES")

        MigrationExecutor(connection).migrate([_leaf()])
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM g12f_zpagevariant")
            assert cursor.fetchone() == (5,)
        assert _column("g12f_zpage", "source_language") == (35, "YES")
    finally:
        MigrationExecutor(connection).migrate(_all_leaves())
