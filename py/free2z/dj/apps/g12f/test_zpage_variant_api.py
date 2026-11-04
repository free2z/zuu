"""The variant API surface —  P6, §4.2 and §4.3.

Four things are being pinned here, in rough order of how expensive it would be
to get them wrong:

1. **Nobody reads or writes another creator's drafts.** Every new route is
   another way to ask for content, so every new route gets an ownership test.
2. **`is_stale` treats a NULL digest as *unknown*, not stale.** Every
   translation that existed before  has a NULL ``source_digest``. If
   unknown collapsed to stale, the badge would fire on essentially the whole
   corpus — the exact false-positive rate that forced the fallback banner out
   in. There is a test for the NULL case specifically, because it is the
   one a reasonable implementation gets wrong.
3. **A representation selector never decides what is stored, and never fails a
   write.** `?lang=` and `Accept-Language` shape the response body only.
4. **Relabelling the source language is a transaction, and a collision is a
   409** — never a silent overwrite of a translation the creator wrote.
5. **Published translations stop at the cap, even under a real concurrent
   write.**
   The source is not part of that number, and a legacy row plus its M3 mirror
   is still one language rather than two.
"""
import threading
import uuid
from pathlib import Path

import pytest
import yaml
from django.conf import settings
from django.db import connection, transaction
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage, ZPageTranslation, ZPageVariant
from dj.apps.g12f.serializers.zpage import (
    MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE,
    MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
    draft_translation_variant_count,
    published_translation_variant_count,
)
from dj.apps.g12f.variants import content_digest
from f2z import languages


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


def page_url(page):
    return f"/api/zpage/{page.free2zaddr}/"


def variants_url(page):
    return f"{page_url(page)}variants/"


def variant_url(page, language):
    return f"{variants_url(page)}{language}/"


def translation_url(page, language):
    return f"{page_url(page)}translations/{language}/"


def owner_client(creator):
    client = APIClient()
    client.force_authenticate(creator)
    return client


def by_language(payload):
    return {row["language"]: row for row in payload}


# Keep the boundary test independent of the curated translation product set:
#  exists precisely because a creator may write any real BCP-47 language.
#
# GENERATED, not a literal list. It was 79 hand-written tags, sized to
# clear the then-64 ceiling by two; raising the ceiling to 96 made every
# boundary test in this module fail on its own fixture. A fixture that has to
# be re-sized whenever the constant under test moves is the same structural
# defect  is about, one layer down -- so this derives from the registry
# and from the cap instead.
#
# Two-letter primary subtags only, filtered through `is_detectable` and
# normalized, which is what keeps them real individual languages or
# macrolanguages rather than private-use or extension tags. Sorted, so the
# fixture is deterministic across runs and processes.
def published_variant_cap_languages():
    seen = []
    for code in sorted(
        f"{first}{second}"
        for first in "abcdefghijklmnopqrstuvwxyz"
        for second in "abcdefghijklmnopqrstuvwxyz"
    ):
        # `en` is these fixtures' SOURCE language (`make_page`), and the cap
        # counts translations EXCLUDING the source -- seeding it as a
        # translation collides on `uniq_zpage_variant_language` instead of
        # testing anything. The hand-written list this replaced carried
        # `en-GB`/`en-US` but never bare `en`, for the same reason.
        if code == "en" or not languages.is_detectable(code):
            continue
        # `normalize` folds regional defaults (`pt` -> `pt-BR`) and legacy
        # aliases (`iw` -> `he`), so two distinct inputs can land on one tag.
        # Deduplicate AFTER normalizing or the page ends up with fewer
        # languages than the fixture believes and the ceiling is never reached.
        tag = languages.normalize(code, allow_missing=False)
        if tag is not None and tag not in seen:
            seen.append(tag)
    # Two spare valid languages beyond the ceiling: the boundary tests need one
    # to fill the last slot and one to be refused.
    needed = max(
        MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
        MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE,
    ) + 2
    assert len(seen) >= needed, (
        f"only {len(seen)} distinct registry languages available for a "
        f"fixture that needs {needed}; widen the generator (three-letter "
        "subtags) rather than lowering the cap under test"
    )
    return seen


def _published_translation_payload(language):
    return {
        "title": f"{language} title",
        "description": f"{language} description",
        "content": f"{language} content",
        "is_published": True,
        "tags": [],
    }


def _seed_published_translation_mirrors(page, language_tags):
    """Create dual-written pairs without firing 63 unrelated async signals."""
    ZPageTranslation.objects.bulk_create([
        ZPageTranslation(
            zpage=page, language=language, title=f"{language} title",
            description=f"{language} description",
            content=f"{language} content", is_published=True,
        )
        for language in language_tags
    ])
    ZPageVariant.objects.bulk_create([
        ZPageVariant(
            zpage=page, language=language, title=f"{language} title",
            description=f"{language} description",
            content=f"{language} content", origin=ZPageVariant.HUMAN,
            is_published=True,
        )
        for language in language_tags
    ])


def _published_translation_row(page, language):
    return ZPageTranslation(
        zpage=page, language=language, title=f"{language} title",
        description=f"{language} description", content=f"{language} content",
        is_published=True,
    )


def _published_variant_row(page, language):
    return ZPageVariant(
        zpage=page, language=language, title=f"{language} title",
        description=f"{language} description", content=f"{language} content",
        origin=ZPageVariant.HUMAN, is_published=True,
    )


def _draft_translation_payload(language):
    return {
        "title": f"{language} title",
        "description": f"{language} description",
        "content": f"{language} content",
        "is_published": False,
        "tags": [],
    }


def _seed_draft_translation_mirrors(page, language_tags):
    """Create dual-written draft pairs without firing 63 unrelated async signals."""
    ZPageTranslation.objects.bulk_create([
        ZPageTranslation(
            zpage=page, language=language, title=f"{language} title",
            description=f"{language} description",
            content=f"{language} content", is_published=False,
        )
        for language in language_tags
    ])
    ZPageVariant.objects.bulk_create([
        ZPageVariant(
            zpage=page, language=language, title=f"{language} title",
            description=f"{language} description",
            content=f"{language} content", origin=ZPageVariant.HUMAN,
            is_published=False,
        )
        for language in language_tags
    ])


def _draft_translation_row(page, language):
    return ZPageTranslation(
        zpage=page, language=language, title=f"{language} title",
        description=f"{language} description", content=f"{language} content",
        is_published=False,
    )


def _draft_variant_row(page, language):
    return ZPageVariant(
        zpage=page, language=language, title=f"{language} title",
        description=f"{language} description", content=f"{language} content",
        origin=ZPageVariant.HUMAN, is_published=False,
    )


def _admin_translation_payload(page, language, *, is_published=True):
    """POST data for the real translation-admin form, not a hand-wired save."""
    data = {
        "zpage": str(page.pk),
        "language": language,
        "title": f"{language} admin title",
        "description": f"{language} admin description",
        "content": f"{language} admin content",
    }
    if is_published:
        data["is_published"] = "on"
    return data


# ---------------------------------------------------------------------------
# §4.2 — listing variants
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_variant_list_reports_source_first_with_real_status(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Titre", content="Corps",
        is_published=False,
    )

    response = owner_client(creator).get(f"{variants_url(page)}?mine=true")

    assert response.status_code == 200
    rows = response.data
    # Source first, then translations by tag: a stable order the translation
    # manager can render without sorting, and one that never buries the
    # article itself in the middle of its own translations.
    assert [row["language"] for row in rows] == ["en", "es", "fr"]
    assert rows[0]["origin"] == "source"
    assert rows[0]["is_stale"] is None
    assert rows[1]["origin"] == "human"
    assert rows[1]["is_published"] is True
    assert rows[2]["is_published"] is False
    # An index, not a content endpoint.
    assert "content" not in rows[0]


@pytest.mark.django_db
def test_variant_list_hides_drafts_from_everyone_but_the_owner(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Titre", content="Corps",
        is_published=False,
    )

    anonymous = APIClient().get(variants_url(page))
    stranger = owner_client(creator_factory()).get(variants_url(page))

    assert anonymous.status_code == 200
    assert [row["language"] for row in anonymous.data] == ["en"]
    assert stranger.status_code == 200
    assert [row["language"] for row in stranger.data] == ["en"]


@pytest.mark.django_db
def test_the_variants_index_never_loads_a_translation_body(creator_factory):
    """Bytes, not queries. A query-count test cannot see this one.

    The index returns no content, so loading any is pure cost — and the cost
    has teeth: a body may be 100,000 characters, the route is unpaginated and
    anonymous, and nothing bounds how many languages a page has. Reusing the
    ordinary `"translations"` prefetch would let one small unauthenticated
    request pull every body of every language into memory, at will, until a
    pod is OOMKilled. The query count would be identical throughout.

    Asserted structurally — `content` must be *deferred* on every prefetched
    translation — because that is the property that stays true no matter how
    big the fixture is.
    """
    creator = creator_factory()
    page = make_page(creator)
    for language in ("es", "fr"):
        ZPageTranslation.objects.create(
            zpage=page, language=language, title="T", content="x" * 5000,
            is_published=True,
        )

    from dj.apps.g12f.views.zpage import zPageView

    view = zPageView(action="variant_list")
    view.request = type(
        "R", (), {"method": "GET", "user": page.creator, "query_params": {}}
    )()
    fetched = view.get_queryset().get(pk=page.pk)
    prefetched = fetched._prefetched_objects_cache["translations"]

    assert len(prefetched) == 2
    for translation in prefetched:
        assert "content" in translation.get_deferred_fields()

    # And the endpoint still answers correctly with the leaner prefetch.
    listed = APIClient().get(variants_url(page))
    assert [row["language"] for row in listed.data] == ["en", "es", "fr"]


@pytest.mark.django_db
def test_a_mirror_only_variant_is_listed_and_deletable(creator_factory):
    """The 409's remedy has to be reachable, or it is not a remedy.

    `validate_source_language` refuses a relabel that collides with a
    `ZPageVariant` even when no `ZPageTranslation` backs it — a hand-edited
    row, a half-applied M2 backfill, or (from P8) an AI draft written straight
    into the variant table. If that row were invisible to the list and immune
    to DELETE, the message "delete or merge it before making Spanish the
    source language" would describe an operation only a DBA could perform.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageVariant.objects.create(
        zpage=page, language="fr", title="Titre", description="",
        content="Corps", origin=ZPageVariant.HUMAN, is_published=True,
    )
    client = owner_client(creator)

    listed = client.get(variants_url(page))
    assert [row["language"] for row in listed.data] == ["en", "fr"]
    assert by_language(listed.data)["fr"]["origin"] == "human"

    blocked = client.patch(
        page_url(page), {"source_language": "fr"}, format="json"
    )
    assert blocked.status_code == 409

    removed = client.delete(variant_url(page, "fr"))
    assert removed.status_code == 204
    assert not ZPageVariant.objects.filter(zpage=page, language="fr").exists()

    #...and now the relabel the 409 was blocking goes through.
    relabelled = client.patch(
        page_url(page), {"source_language": "fr"}, format="json"
    )
    assert relabelled.status_code == 200


@pytest.mark.django_db
def test_an_unpublished_mirror_only_variant_stays_private(creator_factory):
    """The draft rule applies to the new listing branch too.

    Mirror-only rows are listed so a creator can clear a relabel blocker — but
    such a row still carries a title and a description, so an unpublished one
    must not appear to a stranger. Adding a second source of rows to a list
    endpoint is exactly where a visibility rule gets applied once and forgotten
    once.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageVariant.objects.create(
        zpage=page, language="fr", title="Unreleased headline", description="",
        content="Corps", origin=ZPageVariant.HUMAN, is_published=False,
    )

    anonymous = APIClient().get(variants_url(page))
    stranger = owner_client(creator_factory()).get(variants_url(page))
    owner = owner_client(creator).get(f"{variants_url(page)}?mine=true")

    assert [row["language"] for row in anonymous.data] == ["en"]
    assert [row["language"] for row in stranger.data] == ["en"]
    assert "Unreleased headline" not in str(anonymous.data)
    assert [row["language"] for row in owner.data] == ["en", "fr"]


@pytest.mark.django_db
def test_variant_list_of_an_unpublished_page_is_invisible(creator_factory):
    creator = creator_factory()
    page = make_page(creator, is_published=False)

    assert APIClient().get(variants_url(page)).status_code == 404
    assert owner_client(creator).get(
        f"{variants_url(page)}?mine=true"
    ).status_code == 200


# ---------------------------------------------------------------------------
# §4.2 — one variant
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_variant_retrieve_is_exact_and_does_not_fall_back(creator_factory):
    """The difference between this route and `?lang=`, and the point of it.

    `GET /api/zpage/{id}/?lang=de` renders the source variant when there is no
    German one, which is right for a reader and useless for an editor: the
    translation manager needs to tell "not translated yet" from "translated",
    and a route that answers every language with *something* cannot.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    client = APIClient()

    exact = client.get(variant_url(page, "es"))
    missing = client.get(variant_url(page, "de"))
    falls_back = client.get(f"{page_url(page)}?lang=de")

    assert exact.status_code == 200
    assert exact.data["title"] == "Título"
    assert exact.data["actual_language"] == "es"
    assert missing.status_code == 404
    assert falls_back.status_code == 200
    assert falls_back.data["actual_language"] == "en"


@pytest.mark.django_db
def test_variant_retrieve_keeps_a_draft_to_its_owner(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Titre", content="Corps secret",
        is_published=False,
    )

    assert APIClient().get(variant_url(page, "fr")).status_code == 404
    assert owner_client(
        creator_factory()
    ).get(variant_url(page, "fr")).status_code == 404
    owner = owner_client(creator).get(
        f"{variant_url(page, 'fr')}?mine=true"
    )
    assert owner.status_code == 200
    assert owner.data["content"] == "Corps secret"


@pytest.mark.django_db
def test_variant_retrieve_rejects_a_tag_that_is_not_a_language(creator_factory):
    creator = creator_factory()
    page = make_page(creator)

    assert APIClient().get(variant_url(page, "not-a-language")).status_code == 400


# ---------------------------------------------------------------------------
# §4.2 — writing a variant
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_a_creator_may_publish_every_language_we_sell(creator_factory):
    """: the sell list must fit inside the cap, on the real write path.

    `test_language_derived_bounds.py` asserts the arithmetic. This asserts the
    consequence through the API the creator actually uses, because the
    arithmetic being right is not the same claim as the 409 not firing.

    The page's source is a language we do NOT sell into (`nan`), which is the
    worst case: the cap excludes the source, so nothing about being a sellable
    language buys a creator a free slot. Every one of `TRANSLATABLE` is a
    translation that has to fit.
    """
    sellable = sorted(languages.TRANSLATABLE)
    assert "nan" not in sellable, "the fixture source must not be sellable"

    creator = creator_factory()
    page = make_page(creator, source_language="nan")
    # All but the last through the mirror helper -- this is about the cap, not
    # about firing ~78 unrelated async signals.
    _seed_published_translation_mirrors(page, sellable[:-1])

    client = owner_client(creator)
    last = sellable[-1]
    response = client.put(
        variant_url(page, last),
        _published_translation_payload(last),
        format="json",
    )

    assert response.status_code in (200, 201), (
        f"publishing {last}, the {len(sellable)}th of "
        f"{len(sellable)} languages we sell, was refused with "
        f"{response.status_code}: {response.data}. The publish cap "
        f"({MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE}) has fallen below "
        "the sell list again -- see #1953."
    )

    listing = client.get(variants_url(page))
    assert listing.status_code == 200
    published = {
        row["language"]
        for row in listing.data
        if row.get("is_published")
    }
    assert set(sellable).issubset(published)


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_published_translation_variant_ceiling_is_distinct_and_non_destructive(
    creator_factory,
):
    """ caps languages, not source-inclusive physical rows.

    Most seed languages have both the legacy row and its M3 mirror; one is
    legacy-only and one is variant-only to cover rolling/degraded data while
    M5 reads variants.  The page itself has a SOURCE mirror.  A physical row
    count would reject this test's LAST permitted translation early; the
    reader-facing cardinality is one lower.  The rest of the test pins the
    intentional escape hatches: current published edits, drafts,
    unpublishing, and source writes all remain usable at the ceiling.
    """
    creator = creator_factory()
    page = make_page(creator)
    tags = published_variant_cap_languages()
    cap = MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_published_translation_mirrors(page, tags[:cap - 3])
    # Both one-sided rows matter.  Counting only the live variant table would
    # miss the legacy-only row; counting only legacy rows would miss the
    # variant-only row; adding table counts would double-count the 61 pairs.
    ZPageTranslation.objects.bulk_create([
        _published_translation_row(page, tags[cap - 3]),
    ])
    ZPageVariant.objects.bulk_create([
        _published_variant_row(page, tags[cap - 2]),
    ])
    client = owner_client(creator)

    # A source is one canonical article, never one of the capped translations.
    assert page.variants.filter(origin=ZPageVariant.SOURCE).count() == 1

    filled = client.put(
        variant_url(page, tags[cap - 1]),
        _published_translation_payload(tags[cap - 1]), format="json",
    )
    assert filled.status_code == 200

    with transaction.atomic():
        locked = zPage.objects.select_for_update().get(pk=page.pk)
        assert published_translation_variant_count(locked) == cap

    # The cap is not a freeze: content edits and both spellings of a source
    # write stay possible, exactly because none adds a published language.
    assert client.patch(
        variant_url(page, tags[cap - 1]), {"title": "Edited title"},
        format="json",
    ).status_code == 200
    assert client.patch(
        variant_url(page, "en"), {"title": "Edited source variant"},
        format="json",
    ).status_code == 200
    assert client.patch(
        page_url(page), {"description": "Edited canonical article"},
        format="json",
    ).status_code == 200

    draft_tag = tags[cap]
    drafted = client.put(
        variant_url(page, draft_tag), {
            **_published_translation_payload(draft_tag), "is_published": False,
        }, format="json",
    )
    assert drafted.status_code == 200
    assert client.patch(
        variant_url(page, draft_tag), {"description": "Edited draft"},
        format="json",
    ).status_code == 200

    # A newly-public draft is still a new published language and is refused.
    blocked_publish = client.patch(
        variant_url(page, draft_tag), {"is_published": True}, format="json"
    )
    assert blocked_publish.status_code == 409
    assert (
        f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE} published translations"
        in blocked_publish.data["detail"]
    )
    assert not ZPageTranslation.objects.get(
        zpage=page, language=draft_tag
    ).is_published

    # The deprecated alias converges on the same cap rather than retaining a
    # legacy back door.
    alias_tag = tags[cap + 1]
    blocked_alias = client.put(
        translation_url(page, alias_tag), _published_translation_payload(alias_tag),
        format="json",
    )
    assert blocked_alias.status_code == 409
    assert not ZPageTranslation.objects.filter(
        zpage=page, language=alias_tag
    ).exists()
    assert not ZPageVariant.objects.filter(
        zpage=page, language=alias_tag
    ).exists()

    # Removing one public language immediately makes room to publish a draft.
    assert client.patch(
        variant_url(page, tags[cap - 1]), {"is_published": False},
        format="json",
    ).status_code == 200
    assert client.patch(
        variant_url(page, draft_tag), {"is_published": True}, format="json"
    ).status_code == 200
    with transaction.atomic():
        locked = zPage.objects.select_for_update().get(pk=page.pk)
        assert published_translation_variant_count(locked) == cap


@pytest.mark.django_db
def test_admin_rejects_a_published_translation_past_the_cap_without_a_mirror(
    client, creator_factory,
):
    """The admin renders the API's actionable 409 detail as a form error.

    This goes through ``ModelAdmin.changeform_view``, whose transaction starts
    before ``form.is_valid()`` and continues through the legacy save and its
    M3 mirror.  The blocked POST must therefore leave neither shape behind.
    """
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    page = make_page(creator_factory())
    tags = published_variant_cap_languages()
    cap = MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_published_translation_mirrors(page, tags[:cap])
    blocked_language = tags[cap]

    client.force_login(admin_user)
    response = client.post(
        reverse("admin:g12f_zpagetranslation_add"),
        _admin_translation_payload(page, blocked_language),
    )

    assert response.status_code == 200
    form = response.context["adminform"].form
    assert "is_published" in form.errors
    assert (
        "This page already has "
        f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE} published translations."
    ) in str(
        form.errors["is_published"]
    )
    assert "Unpublish or delete a published translation" in str(
        form.errors["is_published"]
    )
    assert not ZPageTranslation.objects.filter(
        zpage=page, language=blocked_language
    ).exists()
    assert not ZPageVariant.objects.filter(
        zpage=page, language=blocked_language
    ).exists()


@pytest.mark.django_db
def test_admin_can_rename_a_published_translation_at_the_ceiling(
    client, creator_factory,
):
    """A same-page published rename releases its old slot as it takes a new one."""
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    page = make_page(creator_factory())
    tags = published_variant_cap_languages()
    cap = MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_published_translation_mirrors(page, tags[:cap])
    translation = ZPageTranslation.objects.get(zpage=page, language=tags[0])
    replacement_language = tags[cap]

    client.force_login(admin_user)
    response = client.post(
        reverse("admin:g12f_zpagetranslation_change", args=[translation.pk]),
        _admin_translation_payload(page, replacement_language),
    )

    assert response.status_code == 302
    assert not ZPageTranslation.objects.filter(
        zpage=page, language=tags[0]
    ).exists()
    assert ZPageTranslation.objects.filter(
        zpage=page, language=replacement_language, is_published=True,
    ).exists()
    assert not ZPageVariant.objects.filter(zpage=page, language=tags[0]).exists()
    assert ZPageVariant.objects.filter(
        zpage=page, language=replacement_language, is_published=True,
    ).exists()
    with transaction.atomic():
        locked = zPage.objects.select_for_update().get(pk=page.pk)
        assert published_translation_variant_count(locked) == cap


@pytest.mark.django_db
def test_admin_cannot_move_a_published_translation_to_a_capped_page(
    client, creator_factory,
):
    """A cross-page admin move is an addition on its destination, not a credit."""
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    source = make_page(creator_factory())
    destination = make_page(creator_factory())
    tags = published_variant_cap_languages()
    cap = MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_published_translation_mirrors(destination, tags[:cap])
    moving = ZPageTranslation.objects.create(
        zpage=source, language=tags[cap], title="Moving", content="Moving body",
        is_published=True,
    )

    client.force_login(admin_user)
    response = client.post(
        reverse("admin:g12f_zpagetranslation_change", args=[moving.pk]),
        _admin_translation_payload(destination, moving.language),
    )

    assert response.status_code == 200
    form = response.context["adminform"].form
    assert "is_published" in form.errors
    assert (
        f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE} published translations"
        in str(form.errors["is_published"])
    )
    moving.refresh_from_db()
    assert moving.zpage_id == source.pk
    assert not ZPageTranslation.objects.filter(
        zpage=destination, language=moving.language
    ).exists()
    assert not ZPageVariant.objects.filter(
        zpage=destination, language=moving.language
    ).exists()


def test_deprecated_translation_alias_contract_includes_conflict_detail():
    """The deprecated route remains a typed, actionable 409 API surface."""
    spec_path = Path(settings.BASE_DIR) / "openapi/f2z.yaml"
    operation = yaml.safe_load(spec_path.read_text())["paths"][
        "/api/zpage/{id}/translations/{language}/"
    ]["put"]
    assert operation["responses"]["409"]["content"]["application/json"][
        "schema"
    ] == {"$ref": "#/components/schemas/ConflictDetail"}


@pytest.mark.django_db(transaction=True)
@override_settings(ZPAGE_VARIANT_READS=True)
def test_concurrent_boundary_publishes_serialize_on_the_parent_zpage_row(
    creator_factory, mocker,
):
    """Two last-slot language PUTs race for real; exactly one may commit.

    The wrapper releases both HTTP requests immediately before their actual
    PostgreSQL ``SELECT... FOR UPDATE``.  With the parent lock, one request
    writes and commits first; the other then observes a full page and gets the
    regular actionable 409 rather than leaving 65 published languages.
    """
    from dj.apps.g12f.views import zpage as zpage_views

    creator = creator_factory()
    page = make_page(creator)
    tags = published_variant_cap_languages()
    cap = MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_published_translation_mirrors(page, tags[:cap - 1])

    original_lock = zpage_views._lock_zpage_for_variant_write
    lock_arrivals = threading.Barrier(2)

    def lock_together(instance):
        lock_arrivals.wait(timeout=10)
        return original_lock(instance)

    mocker.patch.object(
        zpage_views, "_lock_zpage_for_variant_write", lock_together,
    )
    results = [None, None]

    def publish(index):
        language = tags[cap - 1 + index]
        try:
            response = owner_client(creator).put(
                variant_url(page, language),
                _published_translation_payload(language), format="json",
            )
            results[index] = (response.status_code, response.data)
        except Exception as error:  # asserted after both connections close
            results[index] = error
        finally:
            connection.close()

    workers = [
        threading.Thread(target=publish, args=(index,))
        for index in range(2)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=30)
        assert not worker.is_alive(), "concurrent variant write deadlocked"

    unexpected = [
        result for result in results if isinstance(result, Exception)
    ]
    assert not unexpected, unexpected
    assert sorted(result[0] for result in results) == [200, 409]
    assert any(
        result[0] == 409
        and f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE} published translations"
        in result[1]["detail"]
        for result in results
    )
    with transaction.atomic():
        locked = zPage.objects.select_for_update().get(pk=page.pk)
        assert published_translation_variant_count(locked) == cap


# ---------------------------------------------------------------------------
#  the draft translation variant ceiling
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_reaches_the_draft_variant_ceiling_and_further_drafts_conflict(
    creator_factory,
):
    """The draft cap  bounds the creator's working set per page.

    Draft variants count across both shapes via SQL UNION, excluding the
    source language. Editing existing drafts or publishing them is
    cardinality-neutral. Unpublishing an existing published translation adds
    a draft and must fit within the draft ceiling. Deleting a draft frees a slot.
    """
    creator = creator_factory()
    page = make_page(creator)
    tags = published_variant_cap_languages()
    cap = MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_draft_translation_mirrors(page, tags[:cap - 3])
    ZPageTranslation.objects.bulk_create([
        _draft_translation_row(page, tags[cap - 3]),
    ])
    ZPageVariant.objects.bulk_create([
        _draft_variant_row(page, tags[cap - 2]),
    ])
    client = owner_client(creator)

    # A source is one canonical article, never one of the capped draft translations.
    assert page.variants.filter(origin=ZPageVariant.SOURCE).count() == 1

    filled = client.put(
        variant_url(page, tags[cap - 1]),
        _draft_translation_payload(tags[cap - 1]), format="json",
    )
    assert filled.status_code == 200

    with transaction.atomic():
        locked = zPage.objects.select_for_update().get(pk=page.pk)
        assert draft_translation_variant_count(locked) == cap

    # Content edits to existing drafts and source variant writes stay possible.
    assert client.patch(
        variant_url(page, tags[cap - 1]), {"title": "Edited draft title"},
        format="json",
    ).status_code == 200
    assert client.patch(
        variant_url(page, "en"), {"title": "Edited source variant"},
        format="json",
    ).status_code == 200
    assert client.patch(
        page_url(page), {"description": "Edited canonical article"},
        format="json",
    ).status_code == 200

    # One past the cap is refused: 409 draft_translation_variant_limit.
    extra_tag = tags[cap]
    blocked_draft = client.put(
        variant_url(page, extra_tag),
        _draft_translation_payload(extra_tag), format="json",
    )
    assert blocked_draft.status_code == 409
    assert (
        f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE} draft translations"
        in blocked_draft.data["detail"]
    )
    assert not ZPageTranslation.objects.filter(
        zpage=page, language=extra_tag
    ).exists()
    assert not ZPageVariant.objects.filter(
        zpage=page, language=extra_tag
    ).exists()

    # The deprecated alias enforces the same draft ceiling.
    alias_tag = tags[cap + 1]
    blocked_alias = client.put(
        translation_url(page, alias_tag),
        _draft_translation_payload(alias_tag),
        format="json",
    )
    assert blocked_alias.status_code == 409
    assert not ZPageTranslation.objects.filter(
        zpage=page, language=alias_tag
    ).exists()
    assert not ZPageVariant.objects.filter(
        zpage=page, language=alias_tag
    ).exists()

    # Publishing an existing draft succeeds (published count is low).
    assert client.patch(
        variant_url(page, tags[cap - 1]), {"is_published": True},
        format="json",
    ).status_code == 200

    # Unpublishing that translation when draft count is cap - 1 succeeds.
    assert client.patch(
        variant_url(page, tags[cap - 1]), {"is_published": False},
        format="json",
    ).status_code == 200

    # Creating a published translation when draft count is at the ceiling succeeds.
    published_tag = tags[cap]
    assert client.put(
        variant_url(page, published_tag),
        _published_translation_payload(published_tag), format="json",
    ).status_code == 200

    # Unpublishing it at the draft cap would add one past it: refused.
    blocked_unpublish = client.patch(
        variant_url(page, published_tag), {"is_published": False},
        format="json",
    )
    assert blocked_unpublish.status_code == 409
    assert (
        f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE} draft translations"
        in blocked_unpublish.data["detail"]
    )
    assert ZPageTranslation.objects.get(
        zpage=page, language=published_tag
    ).is_published

    # Deleting one draft immediately makes room to unpublish the published variant.
    assert client.delete(variant_url(page, tags[0])).status_code == 204
    assert client.patch(
        variant_url(page, published_tag), {"is_published": False},
        format="json",
    ).status_code == 200
    with transaction.atomic():
        locked = zPage.objects.select_for_update().get(pk=page.pk)
        assert draft_translation_variant_count(locked) == cap


@pytest.mark.django_db
def test_admin_cannot_unpublish_translation_on_draft_capped_page(
    client, creator_factory,
):
    """Admin unpublish on a draft-capped page is refused as a form error."""
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    page = make_page(creator_factory())
    tags = published_variant_cap_languages()
    cap = MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_draft_translation_mirrors(page, tags[:cap])
    published_language = tags[cap]
    published_row = ZPageTranslation.objects.create(
        zpage=page, language=published_language, title="Published",
        content="Published body", is_published=True,
    )

    client.force_login(admin_user)
    response = client.post(
        reverse("admin:g12f_zpagetranslation_change", args=[published_row.pk]),
        _admin_translation_payload(page, published_language, is_published=False),
    )

    assert response.status_code == 200
    form = response.context["adminform"].form
    assert "is_published" in form.errors
    assert (
        f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE} draft translations"
        in str(form.errors["is_published"])
    )
    published_row.refresh_from_db()
    assert published_row.is_published is True


@pytest.mark.django_db
def test_admin_rejects_a_draft_translation_past_the_cap_without_a_mirror(
    client, creator_factory,
):
    """The admin renders the API's actionable 409 draft detail as a form error."""
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    page = make_page(creator_factory())
    tags = published_variant_cap_languages()
    cap = MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_draft_translation_mirrors(page, tags[:cap])
    blocked_language = tags[cap]

    client.force_login(admin_user)
    response = client.post(
        reverse("admin:g12f_zpagetranslation_add"),
        _admin_translation_payload(page, blocked_language, is_published=False),
    )

    assert response.status_code == 200
    form = response.context["adminform"].form
    assert "is_published" in form.errors
    assert (
        "This page already has "
        f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE} draft translations."
    ) in str(
        form.errors["is_published"]
    )
    assert "Delete or publish an existing draft translation" in str(
        form.errors["is_published"]
    )
    assert not ZPageTranslation.objects.filter(
        zpage=page, language=blocked_language
    ).exists()
    assert not ZPageVariant.objects.filter(
        zpage=page, language=blocked_language
    ).exists()


@pytest.mark.django_db
def test_admin_can_rename_a_draft_translation_at_the_ceiling(
    client, creator_factory,
):
    """A same-page draft rename releases its old slot as it takes a new one."""
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    page = make_page(creator_factory())
    tags = published_variant_cap_languages()
    cap = MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_draft_translation_mirrors(page, tags[:cap])
    translation = ZPageTranslation.objects.get(zpage=page, language=tags[0])
    replacement_language = tags[cap]

    client.force_login(admin_user)
    response = client.post(
        reverse("admin:g12f_zpagetranslation_change", args=[translation.pk]),
        _admin_translation_payload(page, replacement_language, is_published=False),
    )

    assert response.status_code == 302
    assert not ZPageTranslation.objects.filter(
        zpage=page, language=tags[0]
    ).exists()
    assert ZPageTranslation.objects.filter(
        zpage=page, language=replacement_language, is_published=False,
    ).exists()
    assert not ZPageVariant.objects.filter(zpage=page, language=tags[0]).exists()
    assert ZPageVariant.objects.filter(
        zpage=page, language=replacement_language, is_published=False,
    ).exists()
    with transaction.atomic():
        locked = zPage.objects.select_for_update().get(pk=page.pk)
        assert draft_translation_variant_count(locked) == cap


@pytest.mark.django_db
def test_admin_cannot_move_a_draft_translation_to_a_draft_capped_page(
    client, creator_factory,
):
    """A cross-page admin move is an addition on its destination, not a credit."""
    admin_user = creator_factory(is_staff=True, is_superuser=True)
    source = make_page(creator_factory())
    destination = make_page(creator_factory())
    tags = published_variant_cap_languages()
    cap = MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_draft_translation_mirrors(destination, tags[:cap])
    moving = ZPageTranslation.objects.create(
        zpage=source, language=tags[cap], title="Moving", content="Moving body",
        is_published=False,
    )

    client.force_login(admin_user)
    response = client.post(
        reverse("admin:g12f_zpagetranslation_change", args=[moving.pk]),
        _admin_translation_payload(destination, moving.language, is_published=False),
    )

    assert response.status_code == 200
    form = response.context["adminform"].form
    assert "is_published" in form.errors
    assert (
        f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE} draft translations"
        in str(form.errors["is_published"])
    )
    moving.refresh_from_db()
    assert moving.zpage_id == source.pk
    assert not ZPageTranslation.objects.filter(
        zpage=destination, language=moving.language
    ).exists()
    assert not ZPageVariant.objects.filter(
        zpage=destination, language=moving.language
    ).exists()


@pytest.mark.django_db(transaction=True)
@override_settings(ZPAGE_VARIANT_READS=True)
def test_concurrent_boundary_draft_writes_serialize_on_the_parent_zpage_row(
    creator_factory, mocker,
):
    """Two last-slot draft PUTs race for real; exactly one may commit.

    The wrapper releases both HTTP requests immediately before their actual
    PostgreSQL ``SELECT... FOR UPDATE``.  With the parent lock, one request
    writes and commits first; the other then observes a full page and gets the
    regular actionable 409 rather than leaving 65 draft languages.
    """
    from dj.apps.g12f.views import zpage as zpage_views

    creator = creator_factory()
    page = make_page(creator)
    tags = published_variant_cap_languages()
    cap = MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
    _seed_draft_translation_mirrors(page, tags[:cap - 1])

    original_lock = zpage_views._lock_zpage_for_variant_write
    lock_arrivals = threading.Barrier(2)

    def lock_together(instance):
        lock_arrivals.wait(timeout=10)
        return original_lock(instance)

    mocker.patch.object(
        zpage_views, "_lock_zpage_for_variant_write", lock_together,
    )
    results = [None, None]

    def create_draft(index):
        language = tags[cap - 1 + index]
        try:
            response = owner_client(creator).put(
                variant_url(page, language),
                _draft_translation_payload(language), format="json",
            )
            results[index] = (response.status_code, response.data)
        except Exception as error:
            results[index] = error
        finally:
            connection.close()

    workers = [
        threading.Thread(target=create_draft, args=(index,))
        for index in range(2)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=30)
        assert not worker.is_alive(), "concurrent draft variant write deadlocked"

    unexpected = [
        result for result in results if isinstance(result, Exception)
    ]
    assert not unexpected, unexpected
    assert sorted(result[0] for result in results) == [200, 409]
    assert any(
        result[0] == 409
        and f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE} draft translations"
        in result[1]["detail"]
        for result in results
    )
    with transaction.atomic():
        locked = zPage.objects.select_for_update().get(pk=page.pk)
        assert draft_translation_variant_count(locked) == cap


@pytest.mark.django_db
def test_owner_creates_a_variant_without_touching_the_article(creator_factory):
    creator = creator_factory()
    page = make_page(creator)

    response = owner_client(creator).put(variant_url(page, "es"), {
        "title": "Título",
        "content": "Contenido",
        "description": "Descripción",
        "is_published": True,
        "tags": [],
    }, format="json")

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.title == "English title"
    assert page.content == "English body"
    translation = ZPageTranslation.objects.get(zpage=page, language="es")
    assert translation.title == "Título"
    # M3 dual write reached the variant table through the shared code path.
    assert ZPageVariant.objects.filter(
        zpage=page, language="es", origin=ZPageVariant.HUMAN
    ).exists()


@pytest.mark.django_db
def test_patch_publishes_a_draft_variant_without_resending_the_body(
    creator_factory,
):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=False,
    )

    response = owner_client(creator).patch(
        variant_url(page, "es"), {"is_published": True}, format="json"
    )

    assert response.status_code == 200
    translation = ZPageTranslation.objects.get(zpage=page, language="es")
    assert translation.is_published is True
    assert translation.content == "Contenido"


@pytest.mark.django_db
def test_writing_the_source_language_updates_the_article_itself(creator_factory):
    """§3.1: the source is a variant. Addressing it as one must not fork it."""
    creator = creator_factory()
    page = make_page(creator)

    response = owner_client(creator).put(variant_url(page, "en"), {
        "title": "Rewritten",
        "content": "Rewritten body",
        "is_published": True,
        "tags": [],
    }, format="json")

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.title == "Rewritten"
    assert not ZPageTranslation.objects.filter(zpage=page, language="en").exists()


@pytest.mark.django_db
def test_writing_the_source_variant_notifies_like_the_canonical_put(
    creator_factory, mocker
):
    """A behavior change, and a deliberate one.

    The old `/translations/{lang}/` handler decided whether to notify by
    looking for a *published `ZPageTranslation` row* in that language. For a
    write in the page's own source language there is no such row — the write
    goes to the `zPage` columns — so the alias silently skipped the fan
    events, the describe/tag pass and the PAGE_UPDATE broadcast that
    `PUT /api/zpage/{id}/` fires for the identical write.

    Now that the source is addressable as a variant, the two spellings of one
    write must not have two different side effects. Unreachable from the
    deployed editor (it uses the canonical route for the source language), so
    this is a consistency fix, not a change in what anyone sees today.
    """
    emit = mocker.patch("dj.apps.g12f.views.zpage.emit_page_update")
    creator = creator_factory()
    page = make_page(creator)

    response = owner_client(creator).put(variant_url(page, "en"), {
        "title": "Rewritten", "content": "Rewritten body",
        "is_published": True, "tags": [],
    }, format="json")

    assert response.status_code == 200
    assert emit.call_count == 1


@pytest.mark.django_db
def test_non_owner_cannot_write_or_delete_a_variant(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    stranger = owner_client(creator_factory())

    written = stranger.put(variant_url(page, "es"), {
        "title": "Hijacked", "content": "Hijacked", "tags": [],
    }, format="json")
    patched = stranger.patch(
        variant_url(page, "es"), {"title": "Hijacked"}, format="json"
    )
    deleted = stranger.delete(variant_url(page, "es"))
    anonymous = APIClient().delete(variant_url(page, "es"))

    assert written.status_code == 404
    assert patched.status_code == 404
    assert deleted.status_code == 404
    assert anonymous.status_code in (401, 403)
    assert ZPageTranslation.objects.get(zpage=page, language="es").title == "Título"


@pytest.mark.django_db
def test_anonymous_writes_are_stopped_by_permissions_not_by_luck(creator_factory):
    """DRF applies one set of `@action` initkwargs to a whole route.

    `/variants/{language}/` carries GET, PUT, PATCH and DELETE, so an
    `AllowAny` added for the sake of the public GET would cover all four, and
    anonymous writes would then be refused only incidentally — by
    `get_queryset` happening to raise NotAuthenticated. That is a rejection
    that disappears the day someone reorganizes the queryset. Assert the
    permission layer itself does the work, by checking the route's declared
    permissions rather than a status code that both designs produce.
    """
    from rest_framework.permissions import IsAuthenticatedOrReadOnly

    from dj.apps.g12f.views.zpage import zPageView

    for name in ("variant_list", "variant_retrieve"):
        initkwargs = getattr(zPageView, name).kwargs
        assert "permission_classes" not in initkwargs, name

    view = zPageView(action="variant_destroy")
    view.request = None
    assert [type(p) for p in view.get_permissions()] == [
        IsAuthenticatedOrReadOnly
    ]


# ---------------------------------------------------------------------------
# §4.2 — deleting a variant
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_deletes_a_variant(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )

    response = owner_client(creator).delete(variant_url(page, "es"))

    assert response.status_code == 204
    assert not ZPageTranslation.objects.filter(zpage=page, language="es").exists()
    assert not ZPageVariant.objects.filter(zpage=page, language="es").exists()


@pytest.mark.django_db
def test_deleting_the_source_variant_is_refused(creator_factory):
    """The source variant is the article. This route will not empty it."""
    creator = creator_factory()
    page = make_page(creator)

    response = owner_client(creator).delete(variant_url(page, "en"))

    assert response.status_code == 400
    page.refresh_from_db()
    assert page.title == "English title"
    assert page.content == "English body"
    assert page.variants.filter(origin=ZPageVariant.SOURCE).count() == 1


@pytest.mark.django_db
def test_deleting_a_variant_that_does_not_exist_is_404(creator_factory):
    creator = creator_factory()
    page = make_page(creator)

    assert owner_client(creator).delete(variant_url(page, "es")).status_code == 404


@pytest.mark.django_db
def test_deprecated_translations_alias_still_works(creator_factory):
    """'s DELETE and the deployed editor's PUT both keep working.

    The alias is not a thin shim that might drift: both routes call the same
    `_save_variant` / `_delete_variant`, so "works the same" is structural
    rather than a promise.
    """
    creator = creator_factory()
    page = make_page(creator)
    alias = f"{page_url(page)}translations/es/"
    client = owner_client(creator)

    written = client.put(alias, {
        "title": "Título", "content": "Contenido",
        "is_published": True, "tags": [],
    }, format="json")
    assert written.status_code == 200
    assert ZPageTranslation.objects.filter(zpage=page, language="es").exists()

    deleted = client.delete(alias)
    assert deleted.status_code == 204
    assert not ZPageTranslation.objects.filter(zpage=page, language="es").exists()


# ---------------------------------------------------------------------------
# §3.2 — the mutable source language and the collision rule
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_relabels_the_source_language_in_one_transaction(creator_factory):
    """Both shapes move together:  keeps them consistent and depends on it."""
    creator = creator_factory()
    page = make_page(creator, source_language="en")

    response = owner_client(creator).patch(
        page_url(page), {"source_language": "es"}, format="json"
    )

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.source_language == "es"
    sources = page.variants.filter(origin=ZPageVariant.SOURCE)
    assert sources.count() == 1
    assert sources.first().language == "es"
    # Relabelling changes the label, never the text.
    assert page.title == "English title"


@pytest.mark.django_db
def test_relabelling_onto_an_occupied_language_is_a_409(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )

    response = owner_client(creator).patch(
        page_url(page), {"source_language": "es"}, format="json"
    )

    assert response.status_code == 409
    detail = str(response.data["detail"])
    # A language name a creator can act on, not a raw subtag ( finding 3),
    # and a next step.
    assert "Spanish" in detail
    assert "Delete or merge" in detail
    page.refresh_from_db()
    assert page.source_language == "en"
    assert page.variants.get(origin=ZPageVariant.SOURCE).language == "en"
    # The refusal is the whole point: the creator's Spanish translation is
    # still there, unaltered.
    assert ZPageTranslation.objects.get(zpage=page, language="es").title == "Título"


@pytest.mark.django_db
def test_a_variant_row_alone_is_enough_to_block_a_relabel(creator_factory):
    """The collision check reads both shapes, not just the legacy one.

    A variant can exist without a `ZPageTranslation` — a future AI draft, or a
    row a reconciler repaired. Checking only the legacy table would let the
    relabel through and then trip `uniq_zpage_variant_language` at M5, or
    silently shadow the variant before that.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageVariant.objects.create(
        zpage=page, language="fr", title="Titre", content="Corps",
        origin=ZPageVariant.HUMAN,
    )

    response = owner_client(creator).patch(
        page_url(page), {"source_language": "fr"}, format="json"
    )

    assert response.status_code == 409
    page.refresh_from_db()
    assert page.source_language == "en"


@pytest.mark.django_db
def test_non_owner_cannot_relabel_the_source_language(creator_factory):
    creator = creator_factory()
    page = make_page(creator)

    response = owner_client(creator_factory()).patch(
        page_url(page), {"source_language": "es"}, format="json"
    )

    assert response.status_code == 404
    page.refresh_from_db()
    assert page.source_language == "en"


# ---------------------------------------------------------------------------
# §4.4 — staleness, and the  trap
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_null_digest_is_unknown_not_stale(creator_factory):
    """The single most important assertion in this file.

    Every translation that predates  has `source_digest = NULL`, because
    nothing recorded which revision of the source it was made from. Computing
    staleness as "digest differs or is missing" would light up "Stale" on
    ~100% of the existing corpus — a badge that fires on everything, which is
    what  had to rip out. Unknown is `null`, and `null` renders as nothing.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    variant = ZPageVariant.objects.get(zpage=page, language="es")
    assert variant.source_digest is None  # what the M2 backfill leaves behind

    listed = APIClient().get(variants_url(page))
    fetched = APIClient().get(variant_url(page, "es"))

    assert by_language(listed.data)["es"]["is_stale"] is None
    assert fetched.data["is_stale"] is None


@pytest.mark.django_db
def test_a_matching_digest_is_fresh_and_a_stale_one_is_stale(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    variant = ZPageVariant.objects.get(zpage=page, language="es")

    ZPageVariant.objects.filter(pk=variant.pk).update(
        source_digest=content_digest(page.content)
    )
    fresh = APIClient().get(variants_url(page))
    assert by_language(fresh.data)["es"]["is_stale"] is False

    ZPageVariant.objects.filter(pk=variant.pk).update(
        source_digest=content_digest("something the creator has since rewritten")
    )
    stale = APIClient().get(variants_url(page))
    assert by_language(stale.data)["es"]["is_stale"] is True


@pytest.mark.django_db
def test_the_source_variant_is_never_stale(creator_factory):
    creator = creator_factory()
    page = make_page(creator)

    listed = APIClient().get(variants_url(page))
    detail = APIClient().get(page_url(page))

    assert by_language(listed.data)["en"]["is_stale"] is None
    assert detail.data["origin"] == "source"
    assert detail.data["is_stale"] is None


@pytest.mark.django_db
def test_detection_fields_are_exposed_and_read_only(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    zPage.objects.filter(pk=page.pk).update(
        detected_language="en",
        detection_confidence=0.93,
        language_source="detected",
    )

    detail = APIClient().get(page_url(page))
    listed = owner_client(creator).get("/api/zpage/?mine=true")

    assert detail.data["detected_language"] == "en"
    assert detail.data["detection_confidence"] == pytest.approx(0.93)
    assert detail.data["language_source"] == "detected"
    # Also on the list, and without a per-row query: the fields are in the
    # `.only()` projection, not deferred into an N+1.
    row = listed.data["results"][0]
    assert row["detected_language"] == "en"
    assert row["language_source"] == "detected"

    # A client cannot forge the provenance that decides whether the detector
    # may overwrite the creator's label later.
    written = owner_client(creator).patch(page_url(page), {
        "detected_language": "fr",
        "detection_confidence": 0.1,
        "language_source": "creator",
    }, format="json")
    assert written.status_code == 200
    page.refresh_from_db()
    assert page.detected_language == "en"
    assert page.language_source == "detected"


@pytest.mark.django_db
def test_the_list_costs_the_same_with_one_page_or_five(creator_factory):
    """Adding a field to a list serializer is how a feed gets slow.

    `zPageListSerializer` now reads three detection columns. The list queryset
    projects with `.only()`, so a column the serializer reads but the
    projection omits is one extra query *per row* — invisible in a test with a
    single fixture, and a homepage outage with a page of twelve. Compare the
    query count at two corpus sizes rather than asserting a magic number, so
    this keeps working when the surrounding queries change.
    """
    from django.test.utils import CaptureQueriesContext
    from django.db import connection

    creator = creator_factory()
    client = owner_client(creator)
    make_page(creator, vanity="one")
    client.get("/api/zpage/?mine=true")  # warm connection-level setup queries

    with CaptureQueriesContext(connection) as one_page:
        client.get("/api/zpage/?mine=true")
    for index in range(4):
        make_page(creator, vanity=f"page-{index}")
    with CaptureQueriesContext(connection) as five_pages:
        client.get("/api/zpage/?mine=true")

    assert len(five_pages) == len(one_page)


# ---------------------------------------------------------------------------
# §4.3 — content negotiation
# ---------------------------------------------------------------------------


def _published_pair(creator):
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    return page


@pytest.mark.django_db
def test_lang_query_beats_the_accept_language_header(creator_factory):
    page = _published_pair(creator_factory())

    response = APIClient().get(
        f"{page_url(page)}?lang=es", HTTP_ACCEPT_LANGUAGE="en-US,en;q=0.9"
    )

    assert response.data["actual_language"] == "es"


@pytest.mark.django_db
def test_accept_language_selects_a_variant_when_lang_is_absent(creator_factory):
    page = _published_pair(creator_factory())

    response = APIClient().get(
        page_url(page), HTTP_ACCEPT_LANGUAGE="es-MX,es;q=0.9,en;q=0.4"
    )

    assert response.data["actual_language"] == "es"
    assert response.data["title"] == "Título"


@pytest.mark.django_db
def test_accept_language_honours_the_weights_not_the_order(creator_factory):
    """The *weighted* list, which is the whole reason to parse it at all."""
    page = _published_pair(creator_factory())

    response = APIClient().get(
        page_url(page), HTTP_ACCEPT_LANGUAGE="en;q=0.2,es;q=0.8"
    )

    assert response.data["actual_language"] == "es"


@pytest.mark.django_db
def test_accept_language_q_zero_is_a_refusal(creator_factory):
    """RFC 9110: `q=0` means "not this one", not "this one, weakly"."""
    page = _published_pair(creator_factory())

    response = APIClient().get(page_url(page), HTTP_ACCEPT_LANGUAGE="es;q=0")

    assert response.data["actual_language"] == "en"


@pytest.mark.django_db
def test_refusing_the_source_language_still_serves_it(creator_factory):
    """Documented, deliberate, and the alternative is worse.

    `Accept-Language: en;q=0` on an English article with a Spanish
    translation refuses the only language the client actually named, and names
    no acceptable alternative (`q=0` on one tag does not imply `*` on the
    rest). RFC 9110 explicitly permits responding anyway rather than 406, and
    "the article's own language" is a better answer than silently handing the
    reader a language they never asked for. Pinned so the behavior is a
    decision rather than an accident.
    """
    page = _published_pair(creator_factory())

    response = APIClient().get(page_url(page), HTTP_ACCEPT_LANGUAGE="en;q=0")

    assert response.status_code == 200
    assert response.data["actual_language"] == "en"


@pytest.mark.django_db
def test_primary_subtag_fallback_is_deterministic(creator_factory):
    """Two pods must not answer the same request differently.

    The available languages are a set, and the first code claiming a primary
    subtag wins the fallback. Iterating the set directly made `pt-AO` resolve
    to `pt-BR` or `pt-PT` depending on the process hash seed — so identical
    requests could alternate across pods, and a shared cache would pin
    whichever one answered first.
    """
    creator = creator_factory()
    page = make_page(creator)
    for language in ("pt-BR", "pt-PT"):
        ZPageTranslation.objects.create(
            zpage=page, language=language, title=f"T {language}",
            content=f"C {language}", is_published=True,
        )

    answers = {
        APIClient().get(
            page_url(page), HTTP_ACCEPT_LANGUAGE="pt-AO"
        ).data["actual_language"]
        for _ in range(5)
    }

    assert answers == {"pt-BR"}  # sorted order, stable across processes


@pytest.mark.django_db
def test_accept_language_falls_through_to_the_source_variant(creator_factory):
    page = _published_pair(creator_factory())

    unavailable = APIClient().get(page_url(page), HTTP_ACCEPT_LANGUAGE="ja,ko;q=0.8")
    garbage = APIClient().get(page_url(page), HTTP_ACCEPT_LANGUAGE=";;;q=,,%%")
    absent = APIClient().get(page_url(page))

    for response in (unavailable, garbage, absent):
        assert response.status_code == 200
        assert response.data["actual_language"] == "en"


@pytest.mark.django_db
def test_a_regional_tag_matches_the_variant_for_its_language(creator_factory):
    page = _published_pair(creator_factory())

    response = APIClient().get(page_url(page), HTTP_ACCEPT_LANGUAGE="es-AR")

    assert response.data["actual_language"] == "es"


@pytest.mark.django_db
def test_accept_language_never_reveals_a_draft_variant(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Borrador",
        is_published=False,
    )

    response = APIClient().get(page_url(page), HTTP_ACCEPT_LANGUAGE="es")

    assert response.data["actual_language"] == "en"
    assert "Borrador" not in response.data["content"]


@pytest.mark.django_db
def test_zpage_responses_vary_on_accept_language_and_cookie(creator_factory):
    page = _published_pair(creator_factory())
    client = APIClient()

    for url in (page_url(page), "/api/zpage/", variants_url(page)):
        vary = client.get(url)["Vary"].lower()
        assert "accept-language" in vary, url
        assert "cookie" in vary, url


@pytest.mark.django_db
def test_accept_language_does_not_reshape_a_write_response(creator_factory):
    """A write answers with what it wrote.

    Negotiating the response of a PUT would mean the editor saves English and
    is shown Spanish — the same confusion `?lang=` on a write caused in,
    one header removed from the URL.
    """
    creator = creator_factory()
    page = _published_pair(creator)

    response = owner_client(creator).patch(
        page_url(page), {"title": "Retitled"},
        format="json", HTTP_ACCEPT_LANGUAGE="es",
    )

    assert response.status_code == 200
    assert response.data["actual_language"] == "en"
    assert response.data["title"] == "Retitled"


# ---------------------------------------------------------------------------
# The doctrine: a URL never dictates what goes in the database
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_lang_query_cannot_brand_a_variant_write(creator_factory):
    creator = creator_factory()
    page = make_page(creator)

    response = owner_client(creator).put(
        f"{variant_url(page, 'es')}?lang=fr", {
            "title": "Título", "content": "Contenido",
            "is_published": True, "tags": [],
        }, format="json",
    )

    assert response.status_code == 200
    # The path segment identifies the resource; the query string picked
    # nothing.
    assert ZPageTranslation.objects.filter(zpage=page, language="es").exists()
    assert not ZPageTranslation.objects.filter(zpage=page, language="fr").exists()


@pytest.mark.django_db
def test_an_unusable_lang_query_cannot_fail_a_write(creator_factory):
    """`ATOMIC_REQUESTS` is why this matters more than it looks.

    DRF renders a `ValidationError` as a *response*, so the transaction
    commits. A representation selector that raised here would return 400 to a
    client whose write had already landed — the worst of both answers, and the
    reason  added `representation_language()`'s asymmetry.

    Two paths, and they hold it for different reasons, so both are asserted.
    On the **variant** routes the guarantee is structural: the path segment
    names the variant, so `?lang=` is never read at all. Mutating
    `representation_language` does not change that response, which is exactly
    the point — there is nothing there to get wrong. On the **canonical**
    route `?lang=` *is* read, and must degrade rather than raise; that half is
    what the second assertion pins.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    on_variant = client.put(
        f"{variant_url(page, 'es')}?lang=not-a-language", {
            "title": "Título", "content": "Contenido",
            "is_published": True, "tags": [],
        }, format="json",
    )
    assert on_variant.status_code == 200
    assert on_variant.data["actual_language"] == "es"
    assert ZPageTranslation.objects.filter(zpage=page, language="es").exists()

    on_article = client.patch(
        f"{page_url(page)}?lang=not-a-language",
        {"title": "Retitled"}, format="json",
    )
    assert on_article.status_code == 200
    assert on_article.data["actual_language"] == "en"
    page.refresh_from_db()
    assert page.title == "Retitled"


@pytest.mark.django_db
def test_an_unusable_lang_query_cannot_fail_a_variant_delete(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )

    response = owner_client(creator).delete(
        f"{variant_url(page, 'es')}?lang=not-a-language"
    )

    assert response.status_code == 204
    assert not ZPageTranslation.objects.filter(zpage=page, language="es").exists()


# ---------------------------------------------------------------------------
#  §1 — a hand-written translation records which revision it was made from
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_writing_a_translation_records_the_source_revision(creator_factory):
    """FAILS ON MAIN. `is_stale` was permanently `null` for human work.

    `source_digest` is what makes "Stale" exact, and until now ONLY paid AI
    translation  ever wrote it -- so a capability that exists silently
    never fired for the majority of variants ( §1). A creator saving a
    translation is working from the article as it stands, so the current digest
    is not a guess: it is what happened, watched.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    response = client.put(
        variant_url(page, "es"),
        _published_translation_payload("es"),
        format="json",
    )
    assert response.status_code == 200

    variant = ZPageVariant.objects.get(zpage=page, language="es")
    assert variant.origin == ZPageVariant.HUMAN  # NOT relabelled as machine
    assert variant.source_digest == content_digest(page.content)
    assert by_language(
        APIClient().get(variants_url(page)).data
    )["es"]["is_stale"] is False


@pytest.mark.django_db
def test_a_translation_goes_stale_when_the_article_is_rewritten(
    creator_factory,
):
    """The whole reason for recording it: the tri-state now has a third state."""
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    client.put(
        variant_url(page, "es"),
        _published_translation_payload("es"),
        format="json",
    )

    zPage.objects.filter(pk=page.pk).update(content="A rewritten English body")

    assert by_language(
        APIClient().get(variants_url(page)).data
    )["es"]["is_stale"] is True


@pytest.mark.django_db
def test_editing_a_translation_restamps_the_digest(creator_factory):
    """A stale translation the creator then fixes is fresh again."""
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    client.put(
        variant_url(page, "es"),
        _published_translation_payload("es"),
        format="json",
    )
    zPage.objects.filter(pk=page.pk).update(content="A rewritten English body")
    page.refresh_from_db()

    client.patch(
        variant_url(page, "es"),
        {"content": "Contenido, actualizado"},
        format="json",
    )

    variant = ZPageVariant.objects.get(zpage=page, language="es")
    assert variant.source_digest == content_digest(page.content)
    assert by_language(
        APIClient().get(variants_url(page)).data
    )["es"]["is_stale"] is False


@pytest.mark.django_db
def test_the_backfilled_corpus_is_left_alone(creator_factory):
    """ §1 decides NOT to retro-stamp, and this is the guard on that.

    Stamping the current digest onto ~4,300 rows nobody watched being written
    would assert a freshness we cannot verify -- the  mistake with the sign
    flipped. `NULL` stays `NULL` until somebody actually saves the translation.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )

    assert ZPageVariant.objects.get(
        zpage=page, language="es"
    ).source_digest is None


@pytest.mark.django_db
def test_a_canonical_write_never_stamps_the_source_variant(creator_factory):
    """The source has no source. Both write paths clear this unconditionally."""
    creator = creator_factory()
    page = make_page(creator)

    owner_client(creator).put(
        variant_url(page, "en"),
        {
            "title": "Retitled", "description": "Rewritten description",
            "content": "Rewritten English body", "tags": [],
        },
        format="json",
    )

    variant = ZPageVariant.objects.get(
        zpage=page, origin=ZPageVariant.SOURCE
    )
    assert variant.source_digest is None
    assert variant.ai_model_id is None


@pytest.mark.django_db
def test_publishing_an_untouched_draft_does_not_claim_it_is_fresh(
    creator_factory,
):
    """A save that changes no text is not evidence about the source.

    The sharp case, found by the codex adversarial review of: the creator
    writes a Spanish draft, the English article is then rewritten (the draft is
    now genuinely stale), and the creator merely PATCHes `is_published: true`.
    Stamping the current digest there would publish stale text labelled fresh
    -- the  badge failure with the sign flipped, and worse, because a
    false "current" is trusted.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    client.put(
        variant_url(page, "es"),
        {**_published_translation_payload("es"), "is_published": False},
        format="json",
    )
    zPage.objects.filter(pk=page.pk).update(content="A rewritten English body")

    client.patch(
        variant_url(page, "es"), {"is_published": True}, format="json",
    )

    assert by_language(
        APIClient().get(variants_url(page)).data
    )["es"]["is_stale"] is True


@pytest.mark.django_db
def test_resaving_identical_text_does_not_restamp(creator_factory):
    """Autosave resends the whole object on every pause; that is not a rewrite."""
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    payload = _published_translation_payload("es")
    client.put(variant_url(page, "es"), payload, format="json")
    zPage.objects.filter(pk=page.pk).update(content="A rewritten English body")

    client.put(variant_url(page, "es"), payload, format="json")

    assert by_language(
        APIClient().get(variants_url(page)).data
    )["es"]["is_stale"] is True


@pytest.mark.django_db
def test_fixing_a_typo_in_the_translated_title_does_not_clear_stale(
    creator_factory,
):
    """`content`, not title -- the mirror image of `content_digest`'s own rule.

    `source_digest` hashes the article's BODY only, deliberately, so that
    retitling an article does not stale every translation of it. The same
    asymmetry has to hold on this side: fixing a typo in the translated TITLE
    is not evidence that a rewritten source body was incorporated, and clearing
    a true "Stale" on that basis is a false negative on a badge whose entire
     design rule is that it must not lie. (codex adversarial review.)
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    client.put(
        variant_url(page, "es"), _published_translation_payload("es"),
        format="json",
    )
    zPage.objects.filter(pk=page.pk).update(content="A rewritten English body")

    client.patch(
        variant_url(page, "es"), {"title": "Título, por fin"}, format="json",
    )

    assert by_language(
        APIClient().get(variants_url(page)).data
    )["es"]["is_stale"] is True
