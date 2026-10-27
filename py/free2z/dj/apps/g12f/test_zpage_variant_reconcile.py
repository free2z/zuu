"""The drift reconciler ( §3.2) — the stated blocker on M5.

Every scenario here is manufactured the way production manufactures it: by
writing the legacy shape with the dual-write mirror turned off, which is exactly
what an old pod does during the window between ``migrate`` and the rollout
finishing, and what ``ZPAGE_VARIANT_DUAL_WRITE=False`` does deliberately.

Re-running the M2 backfill does not repair any of this — that is the point.
``0100`` only creates missing rows; the ``(zpage, language)`` pair is already
taken, so a diverged or orphaned variant is skipped forever.
"""
import uuid
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.test import override_settings

from dj.apps.g12f.models import zPage, ZPageTranslation, ZPageVariant


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


def reconcile(**options):
    out = StringIO()
    try:
        call_command(
            "reconcile_zpage_variants", stdout=out, stderr=out, **options
        )
    except SystemExit as exc:
        return out.getvalue(), exc.code
    return out.getvalue(), 0


def unmirrored():
    """Writes that reach the legacy shape with no mirror — an old pod.

    ``ZPAGE_VARIANT_READS`` is pinned off, not left to the settings default:
    the kill switch is only honoured while readers read the legacy shape
    (``variants.dual_write_enabled``), so with reads on this helper would
    quietly stage a MIRRORED corpus and every drift assertion below would be
    asserting nothing. Hermetic under a prod-parity ``ZPAGE_VARIANT_READS=true``
    environment, which is how the flag is set in production.
    """
    return override_settings(
        ZPAGE_VARIANT_READS=False, ZPAGE_VARIANT_DUAL_WRITE=False
    )


# --------------------------------------------------------------------------- #
# Clean corpus
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_a_dual_written_corpus_reports_no_drift(creator_factory):
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", description="D",
        content="Contenido", is_published=True,
    )
    output, code = reconcile(fail_on_drift=True)

    assert "No drift" in output
    assert code == 0


# --------------------------------------------------------------------------- #
# Every finding, and its repair
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_a_missing_source_variant_is_found_and_created(creator_factory):
    with unmirrored():
        page = make_page(creator_factory())
    assert not page.variants.exists()

    output, code = reconcile(fail_on_drift=True)
    assert "missing-source" in output
    assert code == 1

    reconcile(repair=True)
    variant = page.variants.get(origin=ZPageVariant.SOURCE)
    assert variant.language == "en"
    assert variant.content == "English body"
    assert variant.is_published is True

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output and code == 0


@pytest.mark.django_db
def test_a_diverged_source_variant_is_repaired_field_by_field(creator_factory):
    page = make_page(creator_factory())
    with unmirrored():
        page.title = "Retitled"
        page.content = "Rewritten body"
        page.is_published = False
        page.source_language = "fr"
        page.save()

    output, _ = reconcile()
    assert "diverged-source" in output
    assert "content" in output and "language" in output

    reconcile(repair=True)
    variant = page.variants.get(origin=ZPageVariant.SOURCE)
    assert (variant.title, variant.content, variant.is_published,
            variant.language) == ("Retitled", "Rewritten body", False, "fr")


@pytest.mark.django_db
def test_a_missing_translation_variant_is_created(creator_factory):
    page = make_page(creator_factory())
    with unmirrored():
        ZPageTranslation.objects.create(
            zpage=page, language="es", title="T", description="D",
            content="Contenido", is_published=True,
        )

    output, _ = reconcile()
    assert "missing-translation" in output

    reconcile(repair=True)
    variant = page.variants.get(language="es")
    assert variant.origin == ZPageVariant.HUMAN
    assert variant.content == "Contenido"


@pytest.mark.django_db
def test_a_diverged_translation_is_repaired_without_inventing_provenance(
    creator_factory,
):
    """`origin` and `source_digest` have no legacy counterpart to repair from."""
    page = make_page(creator_factory())
    translation = ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", description="D",
        content="Contenido", is_published=True,
    )
    page.variants.filter(language="es").update(
        origin=ZPageVariant.AI, source_digest="a" * 64
    )
    with unmirrored():
        translation.content = "Contenido revisado"
        translation.is_published = False
        translation.save()

    output, _ = reconcile()
    assert "diverged-translation" in output

    reconcile(repair=True)
    variant = page.variants.get(language="es")
    assert variant.content == "Contenido revisado"
    assert variant.is_published is False
    assert variant.origin == ZPageVariant.AI, "provenance was fabricated"
    assert variant.source_digest == "a" * 64


@pytest.mark.django_db
def test_an_orphan_variant_is_found_and_deleted(creator_factory):
    """A translation an old pod deleted, or renamed, with no mirror."""
    page = make_page(creator_factory())
    translation = ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", description="D",
        content="Contenido", is_published=True,
    )
    with unmirrored():
        translation.delete()

    assert page.variants.filter(language="es").exists()
    output, _ = reconcile()
    assert "orphan-variant" in output

    reconcile(repair=True)
    assert not page.variants.filter(language="es").exists()
    assert page.variants.count() == 1


@pytest.mark.django_db
def test_an_ai_variant_is_never_deleted_as_an_orphan(creator_factory):
    """ P8 authors AI variants in the variant table by design.

    Deleting one because the legacy table has never heard of it would be this
    command destroying the future shape to defend the past one.
    """
    page = make_page(creator_factory())
    ZPageVariant.objects.create(
        zpage=page, language="ja", title="T", content="C",
        origin=ZPageVariant.AI, source_digest="b" * 64,
    )

    output, _ = reconcile(repair=True)
    assert "orphan-variant" not in output
    assert page.variants.filter(language="ja").exists()


@pytest.mark.django_db
def test_a_source_collision_is_reported_and_never_repaired(creator_factory):
    """Picking a winner automatically is how you destroy an original."""
    page = make_page(creator_factory())
    with unmirrored():
        ZPageTranslation.objects.create(
            zpage=page, language="fr", title="T", description="D",
            content="Contenu", is_published=True,
        )
    ZPageVariant.objects.create(
        zpage=page, language="fr", title="T", content="Contenu",
        origin=ZPageVariant.HUMAN,
    )
    zPage.objects.filter(pk=page.pk).update(source_language="fr")

    output, code = reconcile(repair=True, fail_on_drift=True)
    assert "source-collision" in output
    assert code == 1
    # The original is intact.
    assert page.variants.get(origin=ZPageVariant.SOURCE).content == (
        "English body"
    )


@pytest.mark.django_db
def test_a_page_with_no_language_yet_is_not_drift(creator_factory):
    """NULL is "detection has not run yet", not a missing mirror."""
    with unmirrored():
        make_page(creator_factory(), source_language=None)

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0


# --------------------------------------------------------------------------- #
# Contract
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_reporting_is_the_default_and_writes_nothing(creator_factory):
    with unmirrored():
        page = make_page(creator_factory())

    reconcile()
    assert not page.variants.exists()


@pytest.mark.django_db
def test_repair_is_idempotent(creator_factory):
    with unmirrored():
        page = make_page(creator_factory())
        ZPageTranslation.objects.create(
            zpage=page, language="es", title="T", description="D",
            content="Contenido", is_published=True,
        )

    reconcile(repair=True)
    first = list(page.variants.values_list("language", "content", "origin"))

    output, code = reconcile(repair=True, fail_on_drift=True)
    assert "No drift" in output and code == 0
    assert list(
        page.variants.values_list("language", "content", "origin")
    ) == first


@pytest.mark.django_db
def test_repair_works_with_the_dual_write_kill_switch_off(creator_factory):
    """The switch being off is one of the reasons drift exists.

    A repair tool that honours it cannot repair the damage the switch caused.
    """
    with unmirrored():
        page = make_page(creator_factory())
        reconcile(repair=True)

    assert page.variants.get(origin=ZPageVariant.SOURCE).language == "en"


@pytest.mark.django_db
def test_it_never_writes_to_the_legacy_shape(creator_factory):
    """The legacy columns are the source of truth until M5."""
    page = make_page(creator_factory())
    with unmirrored():
        page.title = "Retitled"
        page.save()
    before = zPage.objects.values("title", "content", "is_published").get(
        pk=page.pk
    )

    reconcile(repair=True)

    assert zPage.objects.values(
        "title", "content", "is_published"
    ).get(pk=page.pk) == before


@pytest.mark.django_db
def test_it_is_resumable_on_a_primary_key_cursor(creator_factory):
    creator = creator_factory()
    with unmirrored():
        pages = [make_page(creator) for _ in range(4)]

    reconcile(repair=True, start_after=pages[1].pk)

    assert not pages[0].variants.exists()
    assert not pages[1].variants.exists()
    assert pages[2].variants.exists()
    assert pages[3].variants.exists()


# --------------------------------------------------------------------------- #
# Adversarial review findings (codex, 2026-08-09)
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_limit_bounds_the_batch_not_just_the_loop(creator_factory):
    """`--limit 1 --repair` must be a one-record trial, not a 500-row one.

    The limit used to be checked only after a full 500-row batch had already
    been repaired, so an operator asking for a careful production canary got a
    corpus-scale mutation before regaining control.
    """
    creator = creator_factory()
    with unmirrored():
        pages = [make_page(creator) for _ in range(5)]

    reconcile(repair=True, limit=1)

    repaired = [p for p in pages if p.variants.exists()]
    assert len(repaired) == 1


@pytest.mark.django_db
def test_fail_on_drift_verifies_with_a_read_only_rescan(creator_factory,
                                                        monkeypatch):
    """A repair pass cannot be its own evidence.

    It counts *attempted* repairs. If a repair silently does nothing, counting
    it as fixed makes `--repair --fail-on-drift` exit zero over a corpus that
    is still wrong -- and M5 flips reads onto it.
    """
    with unmirrored():
        make_page(creator_factory())

    from dj.apps.g12f.management.commands import reconcile_zpage_variants as cmd

    monkeypatch.setattr(
        cmd.Command, "_repair_source", lambda self, page_id: True
    )

    output, code = reconcile(repair=True, fail_on_drift=True)
    assert "read-only rescan" in output
    assert code == 1, "a no-op repair was accepted as evidence of no drift"


@pytest.mark.django_db
def test_a_repair_uses_freshly_locked_legacy_state(creator_factory,
                                                   monkeypatch):
    """Minutes pass between the scan and the repair.

    Repairing from the snapshot the sweep read would let the tool overwrite a
    newer, correct mirror with stale content -- creating the drift it exists to
    remove.
    """
    page = make_page(creator_factory())
    with unmirrored():
        page.title = "Stale snapshot"
        page.save()

    from dj.apps.g12f.management.commands import reconcile_zpage_variants as cmd

    real_repair = cmd.Command._repair_source

    def repair_after_a_concurrent_edit(self, page_id):
        # Someone edits (with dual-write on) between the scan and the repair.
        edited = zPage.objects.get(pk=page_id)
        edited.title = "Newer content"
        edited.save()
        return real_repair(self, page_id)

    monkeypatch.setattr(
        cmd.Command, "_repair_source", repair_after_a_concurrent_edit
    )
    reconcile(repair=True)

    assert page.variants.get(
        origin=ZPageVariant.SOURCE
    ).title == "Newer content"


# --------------------------------------------------------------------------- #
# origin='ai' — validated on its own terms
#
# Sweeps 1-3 all start from the legacy shape, so before  an `origin='ai'`
# variant appeared in exactly one of them (`orphan-variant`) and was explicitly
# excluded there. The whole class could be arbitrarily malformed and
# `--fail-on-drift` still exited 0 — a green pre-flight in front of the M5 read
# flip, which is worse than no pre-flight at all.
#
# The other half of the requirement is that the AI rules are the AI rules. Run
# the human expectations over an AI row (or vice versa) and you manufacture
# drift instead of finding it, which fails the same way  failed.
# --------------------------------------------------------------------------- #
def ai_variant(page, language="ja", *, legacy=True, **overrides):
    """An AI translation the way `translation.tasks` actually delivers one.

    Delivery writes the `ZPageTranslation` **first** and lets the dual-write
    signal mirror it, then relabels that variant to `ai` in the same
    transaction. Manufacturing a bare `ZPageVariant` instead would be testing
    a shape production does not produce — and would quietly make every AI
    fixture an `ai-no-legacy-row` finding.

    `legacy=False` builds the M6 shape (and today's defect) on purpose.
    """
    content = {
        "title": "T", "description": "D", "content": "C", "is_published": False,
    }
    content.update({
        field: overrides.pop(field)
        for field in list(overrides) if field in content
    })
    provenance = {"origin": ZPageVariant.AI, "source_digest": "b" * 64}
    provenance.update(overrides)

    if not legacy:
        return ZPageVariant.objects.create(
            zpage=page, language=language, **content, **provenance
        )

    ZPageTranslation.objects.create(zpage=page, language=language, **content)
    variants = ZPageVariant.objects.filter(zpage=page, language=language)
    variants.update(**provenance)
    return variants.get()


@pytest.mark.django_db
def test_a_valid_ai_variant_is_not_drift(creator_factory):
    """The no-false-drift half. An AI row that is fine must report as fine."""
    page = make_page(creator_factory())
    ai_variant(page)

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0


@pytest.mark.django_db
def test_an_ai_variant_with_no_source_digest_is_drift(creator_factory):
    """FAILS ON MAIN — the finding  was filed for.

    Delivery writes the digest of the exact source text the model was shown,
    so a NULL here means the provenance is gone and `staleness()` returns
    "unknown" forever: the translation can never be reported stale again, no
    matter how far the article moves underneath it.
    """
    page = make_page(creator_factory())
    ai_variant(page, source_digest=None)

    output, code = reconcile(fail_on_drift=True)
    assert "ai-missing-digest" in output
    assert code == 1


@pytest.mark.django_db
def test_an_ai_variant_with_a_malformed_source_digest_is_drift(creator_factory):
    """A truncated digest never matches, so it reads as permanently stale."""
    page = make_page(creator_factory())
    ai_variant(page, source_digest="not-a-digest")

    output, code = reconcile(fail_on_drift=True)
    assert "ai-malformed-digest" in output
    assert code == 1


@pytest.mark.django_db
def test_an_ai_variant_in_a_non_language_is_drift(creator_factory):
    """`und` is a legacy sentinel. No purchase can produce one."""
    page = make_page(creator_factory())
    ai_variant(page, language="und")

    output, code = reconcile(fail_on_drift=True)
    assert "ai-invalid-language" in output
    assert code == 1


@pytest.mark.django_db
def test_a_human_variant_with_no_digest_is_not_drift(creator_factory):
    """The invariants genuinely differ by origin.

    No human write path has ever set `source_digest`, so requiring it the way
    an AI row requires it would fire on essentially every translation in the
    corpus — the  banner-that-cries-wolf mistake, re-shipped as a gate.
    """
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", description="D",
        content="Contenido", is_published=True,
    )
    assert page.variants.get(language="es").source_digest is None

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0


@pytest.mark.django_db
def test_an_edited_ai_variant_retains_provenance_without_drift(creator_factory):
    """Creator edits update the text without erasing the paid AI origin."""
    page = make_page(creator_factory())
    translation = ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", description="D",
        content="Contenido", is_published=False,
    )
    page.variants.filter(language="es").update(
        origin=ZPageVariant.AI, source_digest="c" * 64
    )

    translation.content = "Contenido editado"
    translation.save()

    variant = page.variants.get(language="es")
    assert variant.origin == ZPageVariant.AI
    assert variant.source_digest == "c" * 64

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0


@pytest.mark.django_db
def test_an_ai_variant_with_a_retired_model_is_not_drift(creator_factory):
    """`ai_model` is SET_NULL so retiring a model never deletes content.

    That makes NULL an expected post-retirement state, not drift — which is
    why the reconciler does not require it, and says so in its output.
    """
    page = make_page(creator_factory())
    ai_variant(page, ai_model=None)

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0
    assert "ai_model" in output, "the absent check must be stated"


@pytest.mark.django_db
def test_a_source_variant_that_claims_a_provenance_is_drift(creator_factory):
    """The source has no source and no model wrote it.

    Both write paths clear these unconditionally and the M2 backfill wrote
    NULL, so a value here is a row somebody made by hand.
    """
    page = make_page(creator_factory())
    page.variants.filter(origin=ZPageVariant.SOURCE).update(
        source_digest="d" * 64
    )

    output, code = reconcile(fail_on_drift=True)
    assert "source-provenance" in output
    assert code == 1


@pytest.mark.django_db
def test_a_variant_whose_zpage_is_gone_is_drift(creator_factory):
    """The FK cascades, so this is a DB-integrity alarm, not routine drift.

    Deleted here with the constraint deferred — the state a restore, a manual
    `DELETE`, or a cascade that half-ran would leave behind. The reconciler
    has to survive it rather than crash on a dereference.
    """
    page = make_page(creator_factory())
    ai_variant(page, legacy=False)
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL DEFERRED")
        cursor.execute("DELETE FROM g12f_zpage WHERE id = %s", [page.pk])

    output, code = reconcile(fail_on_drift=True)
    assert "orphan-page" in output
    assert code == 1
    assert "ai-missing-digest" not in output, (
        "a row with no page must not also be diagnosed field by field"
    )

    # Drop the dangling rows before the test transaction unwinds: teardown
    # runs `SET CONSTRAINTS ALL IMMEDIATE`, which would re-check the FK we
    # deliberately violated and error out of the fixture rather than the test.
    ZPageVariant.objects.filter(zpage_id=page.pk).delete()


@pytest.mark.django_db
def test_the_ai_findings_are_reported_and_never_repaired(creator_factory):
    """You cannot reconstruct the digest of a revision a model was shown.

    Inventing one would make a stale translation read as fresh, which is the
    exact lie the column exists to prevent.
    """
    page = make_page(creator_factory())
    variant = ai_variant(page, source_digest=None)

    output, code = reconcile(repair=True, fail_on_drift=True)
    assert "ai-missing-digest" in output
    assert code == 1

    variant.refresh_from_db()
    assert variant.source_digest is None
    assert page.variants.filter(pk=variant.pk).exists(), "content destroyed"


# --------------------------------------------------------------------------- #
# Coverage — the count is the regression detector
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_the_report_states_how_many_rows_of_each_origin_it_examined(
    creator_factory,
):
    """"No drift" over an empty sweep and over the whole corpus read alike.

    Only the counts tell them apart, and that ambiguity is the bug  was
    filed for: the AI sweep examined zero rows and the report said the corpus
    was consistent.
    """
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", description="D",
        content="Contenido", is_published=True,
    )
    ai_variant(page)

    output, code = reconcile(fail_on_drift=True)

    assert code == 0
    assert "zPages examined              1" in output
    assert "ZPageTranslations examined   2" in output
    assert "ZPageVariants examined       3" in output
    assert "(source=1 human=1 ai=1)" in output


@pytest.mark.django_db
def test_the_report_states_what_it_did_not_compare(creator_factory):
    """A clean verdict must say what it is NOT a verdict about.

    An AI variant with no legacy translation row behind it has no second copy
    of its text to compare against — today that is one row, after M6 it is
    every one of them.
    """
    page = make_page(creator_factory())
    ai_variant(page, legacy=False)

    output, _ = reconcile()

    assert "not compared" in output
    assert "1 origin='ai' variant(s) with no ZPageTranslation" in output


@pytest.mark.django_db
def test_ai_text_that_still_has_a_legacy_row_is_counted_as_compared(
    creator_factory,
):
    """Today delivery writes the legacy row too, so the text IS checked.

    `diverged-translation` covers it, and the coverage line is what tells an
    operator that — and what will show the number falling to zero when M6
    stops dual-writing.
    """
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="ja", title="T", description="D",
        content="C", is_published=False,
    )
    page.variants.filter(language="ja").update(
        origin=ZPageVariant.AI, source_digest="b" * 64
    )

    output, code = reconcile(fail_on_drift=True)

    assert code == 0
    assert "still have a legacy translation row: 1 of 1" in output


@pytest.mark.django_db
def test_the_coverage_block_is_printed_even_when_drift_is_found(
    creator_factory,
):
    with unmirrored():
        make_page(creator_factory())

    output, code = reconcile(fail_on_drift=True)

    assert code == 1
    assert "missing-source" in output
    assert "coverage" in output


@pytest.mark.django_db
def test_it_does_not_advise_repair_for_findings_repair_cannot_fix(
    creator_factory,
):
    """Sending an operator to run a write command that changes nothing is how
    a tool teaches people to stop believing it."""
    page = make_page(creator_factory())
    ai_variant(page, source_digest=None)

    output, _ = reconcile()

    assert "Re-run with --repair" not in output
    assert "never repaired automatically" in output


@pytest.mark.django_db
def test_it_still_advises_repair_when_something_is_repairable(creator_factory):
    with unmirrored():
        page = make_page(creator_factory())
    ZPageVariant.objects.create(
        zpage=page, language="ja", title="T", content="C",
        origin=ZPageVariant.AI, source_digest=None,
    )

    output, _ = reconcile()

    assert "missing-source" in output and "ai-missing-digest" in output
    assert "Re-run with --repair" in output
    assert "never repaired automatically" in output


# --------------------------------------------------------------------------- #
# Adversarial review findings (codex, 2026-08-17)
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_an_unrecognized_origin_is_drift(creator_factory):
    """`choices=` is a form validator, not a CHECK constraint.

    `.update()` never runs `full_clean`, so the column accepts anything.
    Before this, a typo'd origin fell through everything: `_sweep_orphans` is
    scoped to `human` and every provenance rule is scoped to `source` or `ai`,
    so nothing checked the row at all — while the read path still resolves it
    as a translation and hands a reader an origin no client contract knows.
    """
    page = make_page(creator_factory())
    ai_variant(page, legacy=False)
    page.variants.filter(language="ja").update(origin="a1")

    output, code = reconcile(fail_on_drift=True)
    assert "unknown-origin" in output
    assert code == 1
    assert "ai=0" in output, "the breakdown must not hide it under a real origin"


@pytest.mark.django_db
def test_an_ai_variant_with_no_legacy_row_is_drift_until_m6(creator_factory):
    """Delivery writes the ZPageTranslation first, so today one always exists.

    Its absence means the two shapes disagree about content a creator PAID
    for, and which one a reader gets depends on which pod answers. **This
    check is deleted in M6**, when dual-write stops and the legacy-less shape
    becomes the correct one.
    """
    page = make_page(creator_factory())
    ai_variant(page, legacy=False)

    output, code = reconcile(fail_on_drift=True)
    assert "ai-no-legacy-row" in output
    assert code == 1


@pytest.mark.django_db
def test_the_legacy_less_ai_variant_is_still_never_deleted(creator_factory):
    """Reporting it is the fix. Deleting it would destroy a paid translation."""
    page = make_page(creator_factory())
    ai_variant(page, legacy=False)

    reconcile(repair=True)

    assert page.variants.filter(language="ja").exists()


@pytest.mark.django_db
@pytest.mark.parametrize("stored,canonical", [("pt", "pt-BR"), ("JA", "ja")])
def test_a_non_canonical_ai_language_is_drift(creator_factory, stored,
                                              canonical):
    """`language` is a lookup key, not free text.

    The read path normalizes the tag from the URL and then does an exact
    match, so a stored `pt` or `JA` is a paid translation no reader can reach
    — while an "is this a language at all" check waves it through, because
    both normalize just fine.
    """
    page = make_page(creator_factory())
    ai_variant(page, language=stored)

    output, code = reconcile(fail_on_drift=True)
    assert "ai-invalid-language" in output
    assert canonical in output, "the report should name the canonical tag"
    assert code == 1


@pytest.mark.django_db
def test_fail_on_drift_refuses_a_scoped_scan(creator_factory):
    """A gate has to be a statement about the whole corpus.

    `--limit 500 --fail-on-drift` over 10,000 variants exits 0 having looked
    at 5% of them, and nothing in an exit code distinguishes that from a clean
    full run — the  failure mode with a different first cause.
    """
    with unmirrored():
        make_page(creator_factory())

    for scope in ({"limit": 1}, {"start_after": 1}):
        with pytest.raises(CommandError) as caught:
            reconcile(fail_on_drift=True, **scope)
        assert "whole corpus" in str(caught.value)


@pytest.mark.django_db
def test_a_scoped_run_says_it_is_partial(creator_factory):
    """Still allowed without the gate flag — but never mistakable for one."""
    creator = creator_factory()
    for _ in range(3):
        make_page(creator)

    output, code = reconcile(limit=1)

    assert code == 0
    assert "PARTIAL SCAN" in output
    assert "zPages examined              1" in output


@pytest.mark.django_db
def test_a_full_run_does_not_claim_to_be_partial(creator_factory):
    make_page(creator_factory())

    output, _ = reconcile()

    assert "PARTIAL SCAN" not in output


@pytest.mark.django_db
@pytest.mark.parametrize("stored,canonical", [("pt", "pt-BR"), ("JA", "ja")])
def test_a_non_canonical_human_language_is_drift(creator_factory, stored,
                                                 canonical):
    """`language` is an exact-match lookup key for EVERY origin.

    Both shapes can agree perfectly and the translation still be unreachable:
    the read path normalizes the tag out of the URL and queries for it
    verbatim, so a stored `pt` or `JA` silently falls back to source content.
    """
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language=stored, title="T", description="D",
        content="Contenido", is_published=True,
    )

    output, code = reconcile(fail_on_drift=True)
    assert "unreachable-language" in output
    assert canonical in output
    assert code == 1


@pytest.mark.django_db
def test_the_und_sentinel_is_exempt_on_the_source_variant(creator_factory):
    """ M7 owns `und`, and it is all over the pre- corpus.

    Holding the M5 gate red on a state that already has an owner is how a gate
    becomes something people pass `--admin` around.
    """
    page = make_page(creator_factory(), source_language="und")

    output, code = reconcile(fail_on_drift=True)
    assert "unreachable-language" not in output
    assert code == 0
    assert page.variants.get(origin=ZPageVariant.SOURCE).language == "und"


@pytest.mark.django_db
def test_und_is_not_exempt_on_a_human_variant(creator_factory):
    """The sentinel was `zPage.source_language`, never a translation language.

    So on a human row it is not inherited legacy data — it is a translation
    request languages can never resolve to, because `und` is rejected at
    normalization.
    """
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="und", title="T", description="D",
        content="C", is_published=True,
    )

    output, code = reconcile(fail_on_drift=True)
    assert "unreachable-language" in output
    assert code == 1


@pytest.mark.django_db
def test_und_is_still_drift_on_an_ai_variant(creator_factory):
    """No purchase can target the sentinel, so it is not inherited data."""
    page = make_page(creator_factory())
    ai_variant(page, language="und")

    output, code = reconcile(fail_on_drift=True)
    assert "ai-invalid-language" in output
    assert code == 1


# --------------------------------------------------------------------------- #
# Sweep 5 -- the money oracle
# --------------------------------------------------------------------------- #
def delivered_charge(user, page, language="es", *, digest="a" * 64):
    """A settled ``zpage-translate`` charge, the shape `charges` writes it.

    The durable second oracle: this row says a creator paid for a machine
    translation of ``(page, language)`` made from source content hashing to
    ``digest``. It outlives the delivery and it cannot be edited by the
    read path, which is what makes it usable as evidence about a variant.
    """
    from dj.apps.g12f.translation import charges
    from dj.apps.tuzis.models import IdempotencyKey

    return IdempotencyKey.objects.create(
        scope=charges.SCOPE,
        key=str(uuid.uuid4()),
        user=user,
        response_status=202,
        response_body={
            "job_id": str(uuid.uuid4()),
            "status": charges.DELIVERED,
            "zpage_id": page.pk,
            "language": language,
            "source_digest": digest,
            "price": 7,
            "charged": "7.000",
            "refunded": "0.000",
        },
    )


@pytest.mark.django_db
def test_a_paid_translation_labelled_human_with_no_digest_is_drift(
    creator_factory,
):
    """FAILS ON MAIN -- the whole point of.

    This is what a delivery with the dual-write mirror off leaves behind once
    the reconciler has repaired the missing variant from the legacy shape: an
    ``origin='human'`` row with no digest, sitting under a settled real-money
    charge. Every check that predates this one passes over it, because they are
    all keyed on the stored origin and the stored origin says a person wrote
    it.
    """
    creator = creator_factory()
    page = make_page(creator)
    # The mirror produces exactly this: origin='human', no digest.
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", description="D",
        content="Contenido", is_published=False,
    )
    delivered_charge(creator, page, "es")

    output, code = reconcile(fail_on_drift=True)
    assert "charge-lost-provenance" in output
    assert code == 1
    # Never repaired, and the report says why rather than sending an operator
    # to run a write flag that would change nothing.
    output, code = reconcile(repair=True, fail_on_drift=True)
    assert "charge-lost-provenance" in output
    assert code == 1
    assert ZPageVariant.objects.get(
        zpage=page, language="es"
    ).origin == ZPageVariant.HUMAN


@pytest.mark.django_db
def test_a_paid_translation_that_kept_its_provenance_is_not_drift(
    creator_factory,
):
    creator = creator_factory()
    page = make_page(creator)
    ai_variant(page, language="es", source_digest="a" * 64)
    delivered_charge(creator, page, "es")

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0
    assert "1 bought a variant that still carries THIS charge's own" in output
    assert "delivered translation charges examined 1" in output


@pytest.mark.django_db
def test_editing_a_paid_ai_translation_keeps_its_charge_provenance(
    creator_factory,
):
    """A creator edit keeps the AI label and digest tied to its charge."""
    creator = creator_factory()
    page = make_page(creator)
    variant = ai_variant(page, language="es", source_digest="a" * 64)
    delivered_charge(creator, page, "es")

    # Perform the creator edit through the same model signal as production.
    translation = ZPageTranslation.objects.get(zpage=page, language="es")
    translation.content = "Contenido, reescrito a mano"
    translation.save()
    variant.refresh_from_db()
    assert variant.origin == ZPageVariant.AI
    assert variant.source_digest == "a" * 64

    output, code = reconcile(fail_on_drift=True)
    assert "charge-lost-provenance" not in output
    assert code == 0


@pytest.mark.django_db
def test_a_deleted_translation_is_counted_not_reported(creator_factory):
    """Deleting a translation is a supported action, not drift.

    Nothing on disk separates "the creator deleted it" from "the delivery wrote
    nothing", so this is a coverage number rather than a finding. It is not a
    hole: a delivery that wrote nothing still wrote its ``ZPageTranslation``,
    which ``missing-translation`` reports, and repairing that produces the
    ``charge-lost-provenance`` row the test above pins.
    """
    creator = creator_factory()
    page = make_page(creator)
    delivered_charge(creator, page, "es")

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0
    assert "1 have no variant at that language at all" in output


@pytest.mark.django_db
def test_a_deleted_zpage_leaves_nothing_to_check(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    delivered_charge(creator, page, "es")
    page.delete()

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0
    assert "1 bought a zPage that has since been deleted" in output


@pytest.mark.django_db
def test_an_older_charge_is_not_judged_against_a_rebought_language(
    creator_factory,
):
    """Unpublish-then-rebuy is the sanctioned way to re-translate.

    The newer charge owns the row; blaming the older one would report the same
    variant twice and name the wrong purchase.
    """
    creator = creator_factory()
    page = make_page(creator)
    old = delivered_charge(creator, page, "es", digest="a" * 64)
    # The row as the second, LOST delivery left it -- human, no digest.
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", description="D",
        content="Contenido", is_published=False,
    )
    new = delivered_charge(creator, page, "es", digest="c" * 64)
    assert new.pk > old.pk

    output, code = reconcile(fail_on_drift=True)
    # Exactly one finding, for the newer charge, not one per charge.
    assert "charge-lost-provenance   found=1 " in output
    assert "1 were superseded by a later purchase" in output
    assert code == 1


@pytest.mark.django_db
def test_a_refunded_charge_asserts_nothing_about_the_variant_table(
    creator_factory,
):
    """Only DELIVERED is a witness. A refund bought nothing."""
    from dj.apps.g12f.translation import charges
    from dj.apps.tuzis.models import IdempotencyKey

    creator = creator_factory()
    page = make_page(creator)
    record = delivered_charge(creator, page, "es")
    body = dict(record.response_body)
    body["status"] = charges.REFUNDED
    IdempotencyKey.objects.filter(pk=record.pk).update(response_body=body)

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0
    assert "delivered translation charges examined 0" in output
    assert "1 are still queued or were refunded" in output


@pytest.mark.django_db
def test_a_settled_charge_asserts_nothing_about_the_variant_table(
    creator_factory,
):
    """``settled``  is a FAILURE, not a delivery.

    It keeps the metered cost of provider work that had already been done, and
    writes no variant at all. Two ways to get this wrong, and both are here:
    treating it as a delivery would report drift for a variant that was never
    supposed to exist, and leaving it out of the recognized statuses makes
    every settlement a ``charge-unreadable`` finding -- which holds
    ``--fail-on-drift`` red for the whole corpus over a money state we added on
    purpose.
    """
    from dj.apps.g12f.translation import charges
    from dj.apps.tuzis.models import IdempotencyKey

    creator = creator_factory()
    page = make_page(creator)
    record = delivered_charge(creator, page, "es")
    body = dict(record.response_body)
    body["status"] = charges.SETTLED
    body["billed"] = "3.000"
    IdempotencyKey.objects.filter(pk=record.pk).update(response_body=body)

    output, code = reconcile(fail_on_drift=True)
    assert "No drift" in output
    assert code == 0
    # Counted as a settled-nothing charge, NOT as one this sweep could not
    # read. (The phrase "charge-unreadable" appears in the clean-run
    # explanation too, so the count is the assertion, not the word.)
    assert "0 carry a response_body this sweep could not read" in output
    assert "1 are still queued or were refunded" in output
    assert "delivered translation charges examined 0" in output


@pytest.mark.django_db
def test_a_charge_body_this_sweep_cannot_read_is_counted_loudly(
    creator_factory,
):
    """A schema change in ``charges.initial_body`` must hold the gate RED.

    A sweep that examines nothing and a sweep that finds nothing print the same
    verdict;  is what that ambiguity costs, and this sweep reads a JSON
    blob owned by another app, so it is the most likely one to lose its
    footing. Counting the unreadable records and still exiting 0 would rebuild
     exactly: an automated pre-flight trusting a green exit over money it
    never audited. (codex adversarial review of this PR.)
    """
    from dj.apps.g12f.translation import charges
    from dj.apps.tuzis.models import IdempotencyKey

    creator = creator_factory()
    page = make_page(creator)
    record = delivered_charge(creator, page, "es")
    IdempotencyKey.objects.filter(pk=record.pk).update(
        response_body={"status": charges.DELIVERED, "renamed_zpage": page.pk}
    )

    output, code = reconcile(fail_on_drift=True)
    assert "1 carry a response_body this sweep could not read" in output
    assert "charge-unreadable" in output
    assert code == 1
    # And --repair does not pretend it can invent the purchase.
    output, code = reconcile(repair=True, fail_on_drift=True)
    assert "charge-unreadable" in output
    assert code == 1


@pytest.mark.django_db
def test_a_charge_with_an_unrecognized_status_is_a_finding(creator_factory):
    """The sweep must not enter through the field it is auditing.

    `response_body__status="delivered"` as the queryset filter is the obvious
    shape and it is a trap: rename or corrupt `status` and every charge leaves
    the sweep silently, the console prints "examined 0", and `--fail-on-drift`
    exits 0 over the whole corpus.  rebuilt out of a different first
    cause. (codex adversarial review of this PR.)
    """
    from dj.apps.tuzis.models import IdempotencyKey

    creator = creator_factory()
    page = make_page(creator)
    record = delivered_charge(creator, page, "es")
    body = dict(record.response_body)
    body["state"] = body.pop("status")  # a schema rename
    IdempotencyKey.objects.filter(pk=record.pk).update(response_body=body)

    output, code = reconcile(fail_on_drift=True)
    assert "charge-unreadable" in output
    assert code == 1


@pytest.mark.django_db
def test_a_digest_from_a_different_revision_is_not_counted_as_provenanced(
    creator_factory,
):
    """"Some digest" stopped being proof the moment  stamped human writes.

    A creator buys a translation of revision D1, deletes it, rewrites the
    article to D2, then hand-writes that language themselves -- which now
    carries D2. Reading any non-null digest as inherited AI provenance would
    report that charge's delivery as intact, which is the gate going green over
    precisely the condition it audits. It is not a finding either: nothing on
    disk separates it from a lost delivery, and guessing is what this whole
    command refuses to do. (codex adversarial review of this PR.)
    """
    creator = creator_factory()
    page = make_page(creator)
    delivered_charge(creator, page, "es", digest="a" * 64)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="T", description="D",
        content="Contenido escrito a mano", is_published=False,
    )
    ZPageVariant.objects.filter(zpage=page, language="es").update(
        source_digest="d" * 64
    )

    output, code = reconcile(fail_on_drift=True)
    assert "charge-lost-provenance" not in output
    assert "0 bought a variant that still carries THIS charge's own" in output
    assert "1 bought a variant that is machine output, or carries some " \
        "digest, but NOT this charge's" in output
    assert code == 0


@pytest.mark.django_db
def test_an_ai_row_from_a_later_rebuy_does_not_credit_the_older_charge(
    creator_factory,
):
    """`origin='ai'` is the label; the recorded digest is the evidence.

    A re-buy delivers a second AI variant over the same language. Accepting
    `origin='ai'` on its own would report the FIRST charge as having kept its
    own provenance by looking at a row that belongs to the second -- the gate
    reporting success without verifying the thing it audits. (codex adversarial
    review of this PR.)
    """
    creator = creator_factory()
    page = make_page(creator)
    delivered_charge(creator, page, "es", digest="a" * 64)
    # What the second, later delivery left behind.
    ai_variant(page, language="es", source_digest="c" * 64)

    output, code = reconcile(fail_on_drift=True)
    assert "0 bought a variant that still carries THIS charge's own" in output
    assert "charge-lost-provenance" not in output
    assert code == 0
