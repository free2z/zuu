"""Draft variant bodies must never enter the process on a read.

The defect this pins is not a correctness one -- drafts were already filtered
out of every response, correctly, by ``include_drafts`` in
``localization._variant_candidates`` and ``variant_summaries``. It is a
**memory** one: that filtering ran in Python, so the prefetch materialized every
draft body first and threw them away afterwards.

Why that matters more than the row count suggests:

* a variant body is up to 100,000 characters;
* **draft** variants have no ceiling at all --  caps published ones at 64
  per zPage, and deliberately says nothing about drafts;
* the detail route is **anonymous**, so no account and no rate-limited action is
  needed to trigger it;
* and the multiplier is chosen by the page owner rather than by us, reachable
  through entirely normal use (buying or drafting translations).

The cost lands on the tier that  records heap-OOMing 3-7x a day as a
baseline. A query-count test calls the old code clean -- the query count is
identical. Only the bytes differ, so the assertions here are about which rows
were **instantiated**, not about how many statements ran.
"""
import uuid

import pytest
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from dj.apps.g12f.localization import (
    localized_variant_prefetch,
    viewer_id_from_request,
    visible_variants,
)
from dj.apps.g12f.models import zPage, ZPageTranslation, ZPageVariant  # noqa: F401


#Big enough that materializing it is unmistakable in a spy, small enough that
#the suite stays fast. Production allows 100,000.
DRAFT_BODY = "borrador " * 2000


@pytest.fixture
def spy(monkeypatch):
    """Record every ``ZPageVariant`` Django instantiates from a row.

    ``Model.from_db`` is the single funnel every queryset result passes
    through, so a language that never appears here never had its body read into
    this process. That is the evidence  asks for, and it is strictly
    stronger than a query count or a captured SQL string: it observes the
    result set, not the statement.
    """
    seen = []
    original = ZPageVariant.from_db.__func__

    def record(cls, db, field_names, values):
        instance = original(cls, db, field_names, values)
        seen.append(instance)
        return instance

    monkeypatch.setattr(ZPageVariant, "from_db", classmethod(record))
    return seen


@pytest.fixture
def page(creator_factory):
    """A published article with one published and one DRAFT translation."""
    creator = creator_factory()
    article = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        # The public list excludes rows with a blank vanity, so without one the
        # feed tests below would assert about an empty page of results.
        vanity=f"article-{uuid.uuid4().hex[:12]}",
        title="Free2Z is for creators",
        description="A short summary.",
        content="The English body.",
        source_language="en",
        is_published=True,
    )
    ZPageTranslation.objects.create(
        zpage=article, language="es", title="Publicado",
        description="D", content="Contenido publicado", is_published=True,
    )
    ZPageTranslation.objects.create(
        zpage=article, language="fr", title="Brouillon",
        description="D", content=DRAFT_BODY, is_published=False,
    )
    return article


def detail_url(article):
    return f"/api/zpage/{article.free2zaddr}/"


def languages_seen(spy):
    return {row.language for row in spy}


# --------------------------------------------------------------------------- #
# The defect
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_an_anonymous_detail_read_never_loads_a_draft_body(page, spy):
    """FAILS ON MAIN. The draft row was read, then discarded, every time."""
    response = APIClient().get(detail_url(page))

    assert response.status_code == 200
    assert "fr" not in languages_seen(spy)
    #...and the rows it DID need are still there, so this is an exclusion and
    # not an accidental "prefetch nothing".
    assert {"en", "es"} <= languages_seen(spy)
    # The response is unchanged: the draft was never renderable anyway.
    assert response.data["available_languages"] == ["en", "es"]


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_the_variants_index_never_loads_a_draft_row_for_a_stranger(page, spy):
    response = APIClient().get(f"{detail_url(page)}variants/")

    assert response.status_code == 200
    assert "fr" not in languages_seen(spy)
    assert [row["language"] for row in response.data] == ["en", "es"]


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_another_creators_drafts_are_not_loaded_either(
    page, spy, creator_factory
):
    """Authenticated is not the same as authorized, and the SQL must agree."""
    stranger = creator_factory()
    client = APIClient()
    client.force_authenticate(stranger)

    response = client.get(detail_url(page))

    assert response.status_code == 200
    assert "fr" not in languages_seen(spy)


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_the_exclusion_is_in_the_sql_not_in_python(page):
    """The filter has to be on the statement, or the bytes still travel."""
    with CaptureQueriesContext(connection) as captured:
        APIClient().get(detail_url(page))

    variant_queries = [
        entry["sql"] for entry in captured.captured_queries
        if "g12f_zpagevariant" in entry["sql"]
        and entry["sql"].lstrip().upper().startswith("SELECT")
    ]
    assert variant_queries, "the detail route must prefetch variants"
    for sql in variant_queries:
        # The predicate has to be in the WHERE, not merely in the SELECT list
        # -- selecting `is_published` is what main already did, and it is
        # exactly the thing a lazy assertion mistakes for a filter.
        _select, _, where = sql.partition(" WHERE ")
        assert where, sql
        assert "is_published" in where, sql
        assert "origin" in where, sql


# --------------------------------------------------------------------------- #
# The owner still sees everything
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
@pytest.mark.parametrize("variant_reads", [False, True])
def test_owner_public_detail_excludes_drafts_before_private_read(
    page, variant_reads
):
    client = APIClient()
    client.force_authenticate(page.creator)

    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        public = client.get(detail_url(page))
        private = client.get(f"{detail_url(page)}?lang=fr&mine=true")

    assert public.status_code == 200
    assert public.data["content"] == "The English body."
    assert public.data["available_languages"] == ["en", "es"]
    assert private.status_code == 200
    assert private.data["actual_language"] == "fr"
    assert private.data["content"] == DRAFT_BODY


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_the_owner_still_gets_their_own_draft(page, spy):
    client = APIClient()
    client.force_authenticate(page.creator)

    response = client.get(f"{detail_url(page)}?lang=fr&mine=true")

    assert response.status_code == 200
    assert response.data["actual_language"] == "fr"
    assert response.data["content"] == DRAFT_BODY
    assert "fr" in languages_seen(spy)


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_the_owner_still_sees_their_draft_in_the_variants_index(page):
    client = APIClient()
    client.force_authenticate(page.creator)

    response = client.get(f"{detail_url(page)}variants/?mine=true")

    assert [row["language"] for row in response.data] == ["en", "es", "fr"]
    assert [row["is_published"] for row in response.data] == [True, True, False]


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_the_owner_can_still_fetch_the_draft_variant_directly(page):
    client = APIClient()
    client.force_authenticate(page.creator)

    response = client.get(f"{detail_url(page)}variants/fr/?mine=true")

    assert response.status_code == 200
    assert response.data["content"] == DRAFT_BODY


@pytest.mark.django_db
@pytest.mark.parametrize("variant_reads", [False, True])
def test_predeploy_owner_editor_gets_draft_variant_and_etag_without_mine(
    page, variant_reads
):
    """An already-open editor must not turn an existing draft into a blank one.

    Old editor bundles did not send ``mine`` to the exact variant route. The
    compatibility read must still be owner-scoped, return the draft body and
    provide the validator that makes the subsequent save conditional.
    """
    client = APIClient()
    client.force_authenticate(page.creator)

    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        response = client.get(f"{detail_url(page)}variants/fr/")
        stranger = APIClient().get(f"{detail_url(page)}variants/fr/")

    assert response.status_code == 200
    assert response.data["content"] == DRAFT_BODY
    assert response.headers.get("ETag")
    assert stranger.status_code == 404


@pytest.mark.django_db
@pytest.mark.parametrize("variant_reads", [False, True])
def test_predeploy_owner_editor_reads_variant_of_an_unpublished_page(
    page, variant_reads, creator_factory
):
    """The compatibility arm must also cover a page that is itself a draft.

    ``page`` above is published, so it never reaches the owner arm that
    ``get_queryset`` adds for variant reads; removing that arm left every other
    test in this module green. An old editor open on a never-published article
    is the common case, and without the arm it would see the draft translation
    as missing and could replace it with an unconditional save.
    """
    zPage.objects.filter(pk=page.pk).update(is_published=False)
    client = APIClient()
    client.force_authenticate(page.creator)
    stranger = APIClient()
    stranger.force_authenticate(creator_factory())

    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        own = client.get(f"{detail_url(page)}variants/fr/")
        own_index = client.get(f"{detail_url(page)}variants/")
        foreign = stranger.get(f"{detail_url(page)}variants/fr/")
        anonymous = APIClient().get(f"{detail_url(page)}variants/fr/")

    assert own.status_code == 200
    assert own.data["content"] == DRAFT_BODY
    assert own.headers.get("ETag")
    assert own_index.status_code == 200
    assert foreign.status_code == 404
    assert anonymous.status_code == 404


@pytest.mark.django_db
@pytest.mark.parametrize("variant_reads", [False, True])
def test_owner_plain_read_of_unpublished_page_keeps_public_representation(
    page, variant_reads, spy
):
    """The owner may address an unpublished page without `mine` (embed cards,
    ), but its draft translations stay behind `mine=true`: never
    rendered, never even loaded into the process."""
    zPage.objects.filter(pk=page.pk).update(is_published=False)
    client = APIClient()
    client.force_authenticate(page.creator)

    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        plain = client.get(detail_url(page), {"lang": "fr"})
        plain_seen = languages_seen(spy)
        private = client.get(detail_url(page), {"lang": "fr", "mine": "true"})

    assert plain.status_code == 200
    assert plain.data["actual_language"] != "fr"
    assert DRAFT_BODY not in plain.content.decode()
    assert "fr" not in plain.data["available_languages"]
    if variant_reads:
        assert "fr" not in plain_seen
    assert private.status_code == 200
    assert private.data["actual_language"] == "fr"


# --------------------------------------------------------------------------- #
# The source variant is kept unconditionally, and that is deliberate
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=True)
def test_an_unpublished_source_variant_is_still_loaded(page, spy, caplog):
    """Drift between the shapes must stay diagnosable, not become invisible.

    ``_variant_candidates`` treats "the page is published but its source
    variant says draft" as a DISCLOSURE case with its own ERROR log and its own
    fallback. Filtering the row out in SQL would silently reroute that into the
    "no source variant" branch, which logs something else -- turning one bug
    into a different, harder one. The source is a single row per page, so
    keeping it costs nothing worth measuring.
    """
    ZPageVariant.objects.filter(
        zpage=page, origin=ZPageVariant.SOURCE
    ).update(is_published=False)

    with caplog.at_level("ERROR"):
        response = APIClient().get(detail_url(page))

    assert response.status_code == 200
    assert "en" in languages_seen(spy)
    assert "origin='source' variant says unpublished" in caplog.text


# --------------------------------------------------------------------------- #
# The queryset helper on its own terms
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_visible_variants_keeps_published_and_source_only(page):
    anonymous = visible_variants(ZPageVariant.objects.all(), None)

    assert {row.language for row in anonymous} == {"en", "es"}

    owned = visible_variants(ZPageVariant.objects.all(), page.creator_id)
    assert {row.language for row in owned} == {"en", "es", "fr"}


@pytest.mark.django_db
def test_the_prefetch_carries_content_and_still_excludes_the_draft(page):
    """Not merely deferred -- excluded.

    A ``.only()`` that leaves ``content`` out would keep the bytes out too, but
    the detail route genuinely needs the body of whichever variant it renders.
    So the test that matters is: ``content`` IS selected, and the draft row is
    still absent.
    """
    prefetch = localized_variant_prefetch(with_content=True, viewer_id=None)
    rows = list(prefetch.queryset.filter(zpage=page))

    assert {row.language for row in rows} == {"en", "es"}
    assert all(
        "content" not in row.get_deferred_fields() for row in rows
    )


def test_viewer_id_is_none_for_anything_unauthenticated():
    class _Anonymous:
        is_authenticated = False

    class _Request:
        user = _Anonymous()

    assert viewer_id_from_request(None) is None
    assert viewer_id_from_request(_Request()) is None


# --------------------------------------------------------------------------- #
# The rollback state -- ZPAGE_VARIANT_READS off (codex review)
# --------------------------------------------------------------------------- #
@pytest.fixture
def translation_spy(monkeypatch):
    """The same instrumentation, on the legacy read source."""
    seen = []
    original = ZPageTranslation.from_db.__func__

    def record(cls, db, field_names, values):
        instance = original(cls, db, field_names, values)
        seen.append(instance)
        return instance

    monkeypatch.setattr(ZPageTranslation, "from_db", classmethod(record))
    return seen


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=False)
def test_the_legacy_read_source_excludes_drafts_too(page, translation_spy):
    """FAILS ON MAIN, and this is the state a rollback puts us in.

    ``ZPAGE_VARIANT_READS`` defaults to **false** and is the documented
    rollback, so a bound that only holds while the flag is on is a bound that
    disappears exactly when an incident turns it off. The plain
    ``"translations"`` string prefetch loaded every legacy draft body -- same
    100,000 characters, same absent draft ceiling, same anonymous route.
    (codex adversarial review.)
    """
    response = APIClient().get(detail_url(page))

    assert response.status_code == 200
    assert {row.language for row in translation_spy} == {"es"}
    assert response.data["available_languages"] == ["en", "es"]


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=False)
def test_the_owner_still_reads_their_draft_with_reads_off(
    page, translation_spy
):
    client = APIClient()
    client.force_authenticate(page.creator)

    response = client.get(f"{detail_url(page)}?lang=fr&mine=true")

    assert response.data["actual_language"] == "fr"
    assert response.data["content"] == DRAFT_BODY
    assert "fr" in {row.language for row in translation_spy}


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=False)
def test_the_variants_index_excludes_legacy_drafts_for_a_stranger(page):
    response = APIClient().get(f"{detail_url(page)}variants/")

    assert [row["language"] for row in response.data] == ["en", "es"]


@pytest.mark.django_db
@override_settings(ZPAGE_VARIANT_READS=False)
def test_the_owner_still_sees_the_full_index_with_reads_off(page):
    client = APIClient()
    client.force_authenticate(page.creator)

    response = client.get(f"{detail_url(page)}variants/?mine=true")

    assert [row["language"] for row in response.data] == ["en", "es", "fr"]


# --------------------------------------------------------------------------- #
# The feed prefetches (codex review)
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_the_list_feed_does_not_load_another_creators_drafts(
    page, translation_spy
):
    """FAILS ON MAIN.

    Each row here is ~1 kB rather than ~100 kB -- the excerpt is computed in
    SQL -- so this is the small end of the amplifier. The row COUNT is just as
    unbounded, though, and a feed fans out over a whole page of zPages.
    (codex adversarial review.)
    """
    response = APIClient().get("/api/zpage/")

    assert response.status_code == 200
    # The feed must actually contain the page, or this test proves nothing.
    listed = response.data["results"] if isinstance(
        response.data, dict
    ) else response.data
    assert any(
        row.get("free2zaddr") == page.free2zaddr for row in listed
    ), listed
    assert "es" in {row.language for row in translation_spy}
    assert "fr" not in {row.language for row in translation_spy}


@pytest.mark.django_db
def test_the_series_feed_does_not_load_another_creators_drafts(
    page, translation_spy
):
    """The public series endpoint is unpaginated, so it fans out furthest."""
    from dj.apps.g12f.models import PageOrder, Series

    series = Series.objects.create(creator=page.creator, name="A series")
    PageOrder.objects.create(series=series, page=page, order=0)

    response = APIClient().get(f"/api/g12f/zpage/{page.free2zaddr}/series/")

    assert response.status_code == 200
    assert "fr" not in {row.language for row in translation_spy}


@pytest.mark.django_db
def test_the_owner_still_sees_their_drafts_in_their_own_list(
    page, translation_spy
):
    client = APIClient()
    client.force_authenticate(page.creator)

    response = client.get("/api/zpage/?mine=true")

    assert response.status_code == 200
    assert "fr" in {row.language for row in translation_spy}
    assert "es" in {row.language for row in translation_spy}
