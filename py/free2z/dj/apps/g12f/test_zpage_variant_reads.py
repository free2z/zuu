""" M5 -- flipping reads onto ``ZPageVariant`` must change nothing.

This is a PARITY suite, not a feature suite, and the distinction is the whole
design. Every test here runs the same call twice -- once with
``ZPAGE_VARIANT_READS`` off, once with it on -- and asserts the two results are
equal. Nothing is compared against a hand-written expectation, because a
hand-written expectation is a second implementation of the thing under test and
it drifts. "The bytes are the same" is the only property M5 actually claims.

The corpus is the one  Part 9 asks for, plus two the reviewers asked for:

    und             a legacy page whose source language is the sentinel
    translated      a source with a published es and a published pt-BR
    lonely          a published page with no translations at all
    draft           an unpublished page (owner-visible only)
    paywalled       subscriber-only, with a translation
    partial         a page whose translation is a DRAFT
    unlabelled      source_language is NULL -- detection has not run, so this
                    page has NO source variant AT ALL, by design. It is a live
                    article and the flip must not blank it.

What is deliberately NOT asserted equal: nothing. If a field can differ, this
file says so in a test name and explains why, rather than quietly narrowing an
assertion.
"""
import uuid

import pytest
from django.core.management import call_command
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.db import connection

from dj.apps.g12f.localization import (
    resolve_zpage_variant,
    variant_reads_enabled,
    variant_summaries,
)
from dj.apps.g12f.models import zPage, ZPageTranslation, ZPageVariant
from dj.apps.g12f.views.sitemap import (
    SITEMAP_CHUNK_SIZE,
    build_sitemap_chunk,
)
from dj.apps.search.helpers import _index_variants


HOST = "testserver"

#Every language the corpus can be asked for, plus two it cannot serve, plus
#the "no explicit request" case that exercises negotiation.
REQUESTED = [None, "en", "es", "fr", "pt-BR", "de", "und"]


# --- corpus ---------------------------------------------------------------- #

def _page(creator, **overrides):
    values = {
        "creator": creator,
        "free2zaddr": str(uuid.uuid4()),
        "vanity": f"v-{uuid.uuid4().hex[:12]}",
        "title": "English title",
        "description": "English description",
        # Long enough that the 255-vs-365 excerpt difference between the feed's
        # source and translation rows is observable. A short body would let a
        # broken excerpt length pass.
        "content": "English body copy. " * 60,
        "source_language": "en",
        "is_published": True,
    }
    values.update(overrides)
    return zPage.objects.create(**values)


def _translation(page, language, **overrides):
    values = {
        "title": f"{language} title",
        "description": f"{language} description",
        "content": f"{language} body copy. " * 60,
        "is_published": True,
    }
    values.update(overrides)
    return ZPageTranslation.objects.create(
        zpage=page, language=language, **values
    )


@pytest.fixture
def corpus(creator_factory):
    creator = creator_factory()
    pages = {
        "und": _page(creator, source_language="und", title="Legacy title"),
        "translated": _page(creator),
        "lonely": _page(creator, description=""),
        "draft": _page(creator, is_published=False),
        "paywalled": _page(creator, is_subscriber_only=True),
        "partial": _page(creator),
    }
    _translation(pages["und"], "es")
    _translation(pages["translated"], "es")
    _translation(pages["translated"], "pt-BR")
    _translation(pages["draft"], "es")
    _translation(pages["paywalled"], "es")
    _translation(pages["partial"], "fr", is_published=False)

    # No source variant is ever created for this one: `ZPageVariant.language`
    # is NOT NULL, so `variants.sync_source_variant` skips it and migration
    # 0100 skips it. That is the shape M5 has to survive without blanking a
    # live article, so it is in the corpus rather than in a footnote.
    pages["unlabelled"] = _page(creator, source_language=None)

    return {"creator": creator, "pages": pages}


def both_modes(call):
    """``(legacy_result, variant_result)`` for one callable. Order matters.

    Legacy first, always: it is the behaviour in production today, so if the
    call itself has a side effect the reference run is the one that is not
    contaminated by the new path.
    """
    with override_settings(ZPAGE_VARIANT_READS=False):
        legacy = call()
    with override_settings(ZPAGE_VARIANT_READS=True):
        variant = call()
    return legacy, variant


def assert_identical(call, label=""):
    legacy, variant = both_modes(call)
    assert variant == legacy, f"{label}: variant reads changed the response"
    return legacy


# --- the flag itself -------------------------------------------------------- #



def test_the_helper_reads_the_setting():
    with override_settings(ZPAGE_VARIANT_READS=False):
        assert variant_reads_enabled() is False
    with override_settings(ZPAGE_VARIANT_READS=True):
        assert variant_reads_enabled() is True


# --- resolution ------------------------------------------------------------- #

@pytest.mark.django_db
def test_resolution_is_byte_identical_for_the_whole_corpus(corpus):
    """The single resolution point, over every page x language x visibility.

    ``resolve_zpage_variant`` is the one place a variant is chosen, so this is
    the assertion the other consumers inherit: if the resolver agrees in both
    modes, an endpoint can only disagree by loading the wrong rows, which is
    what the endpoint-level tests below cover.
    """
    for name, page in corpus["pages"].items():
        for requested in REQUESTED:
            for include_drafts in (False, True):
                def call(page=page, requested=requested,
                         include_drafts=include_drafts):
                    fresh = zPage.objects.get(pk=page.pk)
                    resolved = resolve_zpage_variant(
                        fresh, requested, include_drafts=include_drafts
                    )
                    return (
                        resolved.title,
                        resolved.description,
                        resolved.content,
                        resolved.is_published,
                        resolved.requested_language,
                        resolved.actual_language,
                        resolved.fallback_used,
                        resolved.available_languages,
                        resolved.origin,
                        resolved.is_stale,
                    )

                assert_identical(
                    call, f"{name} lang={requested} drafts={include_drafts}"
                )


@pytest.mark.django_db
def test_accept_language_negotiation_is_byte_identical(corpus):
    """Negotiation reads ``available``, which is the set the flip rebuilds."""
    page = corpus["pages"]["translated"]
    headers = [
        "es",
        "pt-BR,pt;q=0.9,en;q=0.8",
        "de,fr;q=0.9",
        "*",
        "es;q=0, en",
        "",
    ]
    for header in headers:
        def call(header=header):
            fresh = zPage.objects.get(pk=page.pk)
            resolved = resolve_zpage_variant(fresh, None, accept_language=header)
            return (resolved.actual_language, resolved.title,
                    resolved.fallback_used, resolved.available_languages)

        assert_identical(call, f"Accept-Language: {header!r}")


@pytest.mark.django_db
def test_an_unlabelled_page_still_renders_its_own_article(corpus):
    """NULL ``source_language`` has no source variant. It must not go blank.

    This is the failure mode that would have shipped a corpus-wide outage: a
    page created before detection runs owns no ``ZPageVariant`` row at all, so
    a resolver that trusted the variant table unconditionally would render an
    empty title and an empty body for every one of them.
    """
    page = corpus["pages"]["unlabelled"]
    assert not ZPageVariant.objects.filter(zpage=page).exists()

    with override_settings(ZPAGE_VARIANT_READS=True):
        resolved = resolve_zpage_variant(zPage.objects.get(pk=page.pk))

    assert resolved.title == page.title
    assert resolved.content == page.content
    assert resolved.actual_language is None


# --- the zPage API ---------------------------------------------------------- #

def _detail(client, page, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
    url = f"/api/zpage/{page.free2zaddr}/"
    if query:
        url = f"{url}?{query}"
    response = client.get(url, HTTP_HOST=HOST)
    return response.status_code, response.json() if response.content else None


@pytest.mark.django_db
def test_the_zpage_detail_api_is_byte_identical(corpus, api_client):
    for name, page in corpus["pages"].items():
        for lang in (None, "es", "fr", "pt-BR"):
            assert_identical(
                lambda page=page, lang=lang: _detail(api_client, page, lang=lang),
                f"anonymous detail {name} lang={lang}",
            )


@pytest.mark.django_db
def test_the_owners_zpage_detail_api_is_byte_identical(corpus, api_client):
    """The explicit owner read sees drafts identically in both modes."""
    api_client.force_authenticate(corpus["creator"])
    for name, page in corpus["pages"].items():
        for lang in (None, "es", "fr"):
            assert_identical(
                lambda page=page, lang=lang: _detail(
                    api_client, page, lang=lang, mine=True
                ),
                f"owner detail {name} lang={lang}",
            )


@pytest.mark.django_db
def test_the_zpage_list_feed_is_byte_identical(corpus, api_client):
    """Including the 255-character source excerpt, which is not 365."""
    def call(lang=None):
        url = "/api/zpage/" + (f"?lang={lang}" if lang else "")
        payload = api_client.get(url, HTTP_HOST=HOST).json()
        return sorted(payload["results"], key=lambda row: row["free2zaddr"])

    for lang in (None, "es", "pt-BR"):
        assert_identical(lambda lang=lang: call(lang), f"list lang={lang}")


@pytest.mark.django_db
def test_the_related_feed_is_byte_identical(corpus, api_client):
    page = corpus["pages"]["translated"]

    def call(lang=None):
        url = f"/api/zpage/{page.free2zaddr}/related/"
        if lang:
            url = f"{url}?lang={lang}"
        payload = api_client.get(url, HTTP_HOST=HOST).json()
        return sorted(payload, key=lambda row: row["free2zaddr"])

    for lang in (None, "es"):
        assert_identical(lambda lang=lang: call(lang), f"related lang={lang}")


# --- the variants API  ----------------------------------------------- #

@pytest.mark.django_db
def test_the_variants_index_is_byte_identical(corpus, api_client):
    for name, page in corpus["pages"].items():
        def call(page=page):
            response = api_client.get(
                f"/api/zpage/{page.free2zaddr}/variants/",
                HTTP_HOST=HOST,
            )
            expected_status = 200 if page.is_published else 404
            assert response.status_code == expected_status, response.content
            return response.json()

        assert_identical(
            call,
            f"anonymous variants index {name}",
        )


@pytest.mark.django_db
def test_the_owners_variants_index_is_byte_identical(corpus, api_client):
    api_client.force_authenticate(corpus["creator"])
    for name, page in corpus["pages"].items():
        def call(page=page):
            response = api_client.get(
                f"/api/zpage/{page.free2zaddr}/variants/?mine=true",
                HTTP_HOST=HOST,
            )
            assert response.status_code == 200, response.content
            return response.json()

        assert_identical(
            call,
            f"owner variants index {name}",
        )


@pytest.mark.django_db
def test_variant_retrieve_including_its_404s_is_byte_identical(
    corpus, api_client
):
    """The 404 gate matters as much as the body.

    ``GET /variants/{lang}/`` is exact addressing: it must not fall back. A
    gate that consults the legacy shape while the renderer reads the variant
    table would 404 content it can see, or 200 with the wrong language.
    """
    for name, page in corpus["pages"].items():
        for lang in ("en", "es", "fr", "pt-BR"):
            for authenticated in (False, True):
                def call(page=page, lang=lang, authenticated=authenticated):
                    if authenticated:
                        api_client.force_authenticate(corpus["creator"])
                    else:
                        api_client.force_authenticate(None)
                    response = api_client.get(
                        f"/api/zpage/{page.free2zaddr}/variants/{lang}/"
                        + ("?mine=true" if authenticated else ""),
                        HTTP_HOST=HOST,
                    )
                    body = response.json() if response.content else None
                    return response.status_code, body

                assert_identical(
                    call, f"variant retrieve {name}/{lang} auth={authenticated}"
                )


@pytest.mark.django_db
def test_the_variants_index_never_loads_a_body_with_reads_flipped(corpus):
    """'s bound survives the flip.

    The index renders no content, so it must load none -- an unpaginated
    anonymous route over 100,000-character bodies with nothing bounding the
    variant count is an OOM, not a slow response. A query-count test cannot see
    this: the query count is identical either way and only the bytes differ, so
    the assertion is on the deferred field.
    """
    from dj.apps.g12f.localization import localized_variant_prefetch

    with override_settings(ZPAGE_VARIANT_READS=True):
        prefetch = localized_variant_prefetch(with_content=False)
        rows = list(prefetch.queryset.all()[:1])

    assert rows, "corpus should have variants"
    assert "content" in rows[0].get_deferred_fields()


# --- series ----------------------------------------------------------------- #

@pytest.mark.django_db
def test_the_series_feed_is_byte_identical(corpus, api_client):
    from dj.apps.g12f.models import PageOrder, Series

    series = Series.objects.create(
        creator=corpus["creator"], name="A series"
    )
    for index, name in enumerate(("translated", "lonely", "und")):
        PageOrder.objects.create(
            series=series, page=corpus["pages"][name], order=index
        )

    anchor = corpus["pages"]["translated"]

    def call(lang=None):
        url = f"/api/g12f/zpage/{anchor.free2zaddr}/series/"
        if lang:
            url = f"{url}?lang={lang}"
        return api_client.get(url, HTTP_HOST=HOST).json()

    for lang in (None, "es"):
        assert_identical(lambda lang=lang: call(lang), f"series lang={lang}")


# --- the crawler / prerender tier  ----------------------------------- #

@pytest.mark.django_db
def test_the_crawler_card_is_byte_identical(corpus, client):
    """Whole rendered document, so canonical and every hreflang are covered."""
    for name in ("und", "translated", "lonely", "paywalled", "partial",
                 "unlabelled"):
        page = corpus["pages"][name]
        for lang in (None, "es", "fr", "pt-BR"):
            def call(page=page, lang=lang):
                url = f"/{page.creator.username}/{page.vanity}"
                if lang:
                    url = f"{url}?lang={lang}"
                response = client.get(url, HTTP_HOST=HOST)
                return response.status_code, response.content

            assert_identical(call, f"card {name} lang={lang}")


@pytest.mark.django_db
def test_a_draft_page_still_404s_the_crawler_in_both_modes(corpus, client):
    page = corpus["pages"]["draft"]

    def call():
        return client.get(
            f"/{page.creator.username}/{page.vanity}", HTTP_HOST=HOST
        ).status_code

    assert assert_identical(call, "draft card") == 404


# --- sitemaps  -------------------------------------------------------- #

@pytest.mark.django_db
def test_the_sitemap_chunk_is_byte_identical(corpus):
    page = corpus["pages"]["translated"]
    chunk_page = (page.pk - 1) // SITEMAP_CHUNK_SIZE

    def call():
        chunk = build_sitemap_chunk("zpages", chunk_page)
        return sorted(
            (row["vanity"], tuple(row["languages"]), row["source_language"])
            for row in chunk["zpages"]
        )

    assert_identical(call, "sitemap chunk")


@pytest.mark.django_db
def test_the_sitemap_lastmod_is_not_taken_from_the_mirror(corpus):
    """``updated_at`` is not mirrored, so M5 must not source ``lastmod`` from it.

    ``ZPageVariant.updated_at`` is ``auto_now``: it records when the MIRROR was
    written, and for every row migration 0100 created that is the date of the
    backfill. Sourcing ``lastmod`` from it would tell every crawler that the
    whole corpus changed on deploy day.
    """
    page = corpus["pages"]["translated"]
    chunk_page = (page.pk - 1) // SITEMAP_CHUNK_SIZE
    translation = page.translations.get(language="es")

    # Push the mirror far ahead of the legacy row, exactly as a backfill does.
    ZPageVariant.objects.filter(zpage=page, language="es").update(
        updated_at=translation.updated_at.replace(year=translation.updated_at.year + 1)
    )

    def call():
        chunk = build_sitemap_chunk("zpages", chunk_page)
        row = next(
            item for item in chunk["zpages"] if item["vanity"] == page.vanity
        )
        return row["updated_at"]

    assert_identical(call, "sitemap lastmod")


# --- search indexing ('s rollout contract) ------------------------------ #

@pytest.mark.django_db
def test_the_search_index_context_is_byte_identical(corpus):
    """The embedded text, per page. Same blocks, same order, same budget split."""
    for name, page in corpus["pages"].items():
        assert_identical(
            lambda page=page: _index_variants(zPage.objects.get(pk=page.pk)),
            f"index context {name}",
        )


def test_the_multilingual_index_task_keeps_its_name():
    """'s rollout contract is a NAME, and M5 must not rename it.

    A worker that predates this change indexes from ``ZPageTranslation`` and,
    under dual write, produces byte-identical input -- which is why the flip
    needs no new task name. What it must not do is take the existing one away:
    an old worker silently claiming translation-aware work and reporting
    success is the exact failure the dedicated name and queue prevent.
    """
    from dj.apps.search.tasks import index_multilingual_zpage

    assert index_multilingual_zpage.name == "search.index_multilingual_zpage"
    assert index_multilingual_zpage.queue == "search-multilingual"


# --- security: the two places a resolution bug becomes a disclosure bug ------ #

@pytest.mark.django_db
def test_a_paywalled_translation_never_reaches_a_stranger_in_either_mode(
    corpus, api_client
):
    page = corpus["pages"]["paywalled"]
    body = page.translations.get(language="es").content

    for mode in (False, True):
        with override_settings(ZPAGE_VARIANT_READS=mode):
            status, payload = _detail(api_client, page, lang="es")
        assert status in (200, 302, 403), (mode, status)
        if status == 200:
            # A paywalled page answers 200 with the modal envelope, not the
            # article: `RedirectWithModalException` sets `_redact_content` and
            # re-serializes. Reach through it so this asserts on the real body
            # rather than on the absence of a key.
            article = payload.get("page", payload)
            assert body not in article["content"], mode
            assert article["content"] == "Subscribe for exclusive content", mode


@pytest.mark.django_db
def test_a_draft_variant_is_invisible_to_a_stranger_in_either_mode(
    corpus, api_client
):
    """The unpublished French translation of ``partial``."""
    page = corpus["pages"]["partial"]
    draft = page.translations.get(language="fr")

    for mode in (False, True):
        with override_settings(ZPAGE_VARIANT_READS=mode):
            status, payload = _detail(api_client, page, lang="fr")
            index = api_client.get(
                f"/api/zpage/{page.free2zaddr}/variants/", HTTP_HOST=HOST
            ).json()
            exact = api_client.get(
                f"/api/zpage/{page.free2zaddr}/variants/fr/", HTTP_HOST=HOST
            )

        assert status == 200, mode
        assert payload["content"] != draft.content, mode
        assert payload["actual_language"] == "en", mode
        assert "fr" not in payload["available_languages"], mode
        assert [row["language"] for row in index] == ["en"], mode
        assert draft.title not in str(index), mode
        assert exact.status_code == 404, mode


@pytest.mark.django_db
def test_an_unpublished_page_is_invisible_to_a_stranger_in_either_mode(
    corpus, api_client
):
    page = corpus["pages"]["draft"]
    for mode in (False, True):
        with override_settings(ZPAGE_VARIANT_READS=mode):
            status, _payload = _detail(api_client, page)
        assert status == 404, mode


# --- drift: what the reconciler is the gate for ------------------------------ #

@pytest.mark.django_db
def test_drift_is_detectable_repairable_and_parity_returns(corpus, capsys):
    """Plant divergence, prove the reconciler sees it, repair, prove parity.

    The three shapes drift takes, all three of which 's docstring says the
    M2 backfill cannot fix, and all three of which are invisible until reads
    flip:

      * diverged  -- a variant whose text no longer matches the legacy row
      * orphan    -- a variant whose translation was deleted with no mirror
      * missing   -- a translation whose variant was never written
    """
    page = corpus["pages"]["translated"]

    def resolved(lang):
        fresh = zPage.objects.get(pk=page.pk)
        return resolve_zpage_variant(fresh, lang)

    def compare(lang):
        return both_modes(lambda: resolved(lang).content)

    # Baseline: the shapes agree, so the flag changes nothing.
    assert compare("es")[0] == compare("es")[1]

    # 1. DIVERGED. A queryset update on the mirror -- the shape an old pod
    #    writing the legacy row during a rollout leaves behind.
    ZPageVariant.objects.filter(zpage=page, language="es").update(
        content="DIVERGED spanish body"
    )
    legacy, variant = compare("es")
    assert legacy != variant
    assert variant == "DIVERGED spanish body", (
        "with reads flipped, a reader sees the DIVERGED text -- which is "
        "exactly why a clean reconcile is the gate"
    )

    # 2. ORPHAN. The creator deleted a translation while no mirror was running.
    #    Reads pinned off alongside it, because the switch is only honoured
    #    while reads are off -- see `variants.dual_write_enabled`. Staging an
    #    old pod means staging BOTH halves of what an old pod had.
    with override_settings(
        ZPAGE_VARIANT_READS=False, ZPAGE_VARIANT_DUAL_WRITE=False
    ):
        page.translations.filter(language="pt-BR").delete()

    # 3. MISSING. A translation written with no mirror at all.
    with override_settings(
        ZPAGE_VARIANT_READS=False, ZPAGE_VARIANT_DUAL_WRITE=False
    ):
        _translation(page, "fr")

    call_command("reconcile_zpage_variants", show=0)
    report = capsys.readouterr().out
    assert "diverged-translation" in report
    assert "orphan-variant" in report
    assert "missing-translation" in report

    call_command("reconcile_zpage_variants", "--repair", "--fail-on-drift",
                 show=0)
    clean = capsys.readouterr().out
    assert "No drift" in clean

    for lang in ("en", "es", "fr", "pt-BR"):
        legacy, variant = compare(lang)
        assert legacy == variant, lang


@pytest.mark.django_db
def test_a_missing_source_variant_serves_the_legacy_columns_and_logs(
    corpus, caplog
):
    """The worst drift shape: the article's own row is gone.

    A blank article is never the right answer. The reader keeps seeing what
    they saw yesterday and an ERROR names the page, which is what a human
    needs to run ``reconcile_zpage_variants --repair``.
    """
    page = corpus["pages"]["translated"]
    ZPageVariant.objects.filter(
        zpage=page, origin=ZPageVariant.SOURCE
    ).delete()

    with override_settings(ZPAGE_VARIANT_READS=True):
        with caplog.at_level("ERROR"):
            resolved = resolve_zpage_variant(zPage.objects.get(pk=page.pk))

    assert resolved.title == page.title
    assert resolved.content == page.content
    assert "no origin='source' variant" in caplog.text

    call_command("reconcile_zpage_variants", "--repair", "--fail-on-drift",
                 show=0)
    assert ZPageVariant.objects.filter(
        zpage=page, origin=ZPageVariant.SOURCE
    ).exists()


@pytest.mark.django_db
def test_a_drifted_unpublished_source_variant_is_never_rendered(
    corpus, api_client, caplog
):
    """The codex adversarial review's RISKIEST LINE, pinned.

    A published page whose mirror says its source variant is a DRAFT. Every
    caller reaching resolution was authorized against ``zPage.is_published``,
    so the page is public; the mirror row is then text written while the two
    shapes were out of step -- a stale revision, possibly the private draft the
    creator edited before publishing. Rendering it turns drift into a
    disclosure, so it is refused exactly like a missing row: the legacy columns
    win and an ERROR names the page.
    """
    page = corpus["pages"]["lonely"]
    ZPageVariant.objects.filter(
        zpage=page, origin=ZPageVariant.SOURCE
    ).update(is_published=False, content="PRIVATE DRAFT BODY",
             title="PRIVATE DRAFT TITLE")

    with override_settings(ZPAGE_VARIANT_READS=True):
        with caplog.at_level("ERROR"):
            resolved = resolve_zpage_variant(zPage.objects.get(pk=page.pk))
        status, payload = _detail(api_client, page)
        blocks = _index_variants(zPage.objects.get(pk=page.pk))

    assert resolved.title == page.title
    assert resolved.content == page.content
    assert resolved.is_published is True
    assert "says unpublished" in caplog.text

    assert status == 200
    assert "PRIVATE DRAFT" not in payload["title"]
    assert "PRIVATE DRAFT" not in payload["content"]

    # And it must not reach a provider call / search summary either.
    assert not any("PRIVATE DRAFT" in block for block in blocks)


@pytest.mark.django_db
def test_the_crawler_card_variant_bound_matches_when_there_is_no_source_row(
    corpus, client, creator_factory
):
    """The third codex finding: the extra slot is for the SOURCE row.

    A published page with a NULL ``source_language`` has no source variant, so
    a naive ``CARD_MAX_VARIANTS + 1`` slice would admit one more TRANSLATION
    than the legacy path -- and that extra language would enter the card's
    hreflang cluster while the sitemap, bounded at 32, never emits it.
    """
    from dj.apps.g12f.views.crawler import CARD_MAX_VARIANTS

    creator = corpus["creator"]
    page = _page(creator, source_language=None)
    for index in range(CARD_MAX_VARIANTS + 1):
        _translation(page, f"x{index}" if index else "es")

    def call():
        response = client.get(
            f"/{creator.username}/{page.vanity}", HTTP_HOST=HOST
        )
        return response.status_code, response.content

    assert_identical(call, "card with no source row at the variant bound")


@pytest.mark.django_db
def test_a_flipped_detail_request_does_not_load_legacy_bodies_too(
    corpus, api_client
):
    """The second codex finding: one copy of the bodies, not two.

    With reads flipped the article body comes from ``ZPageVariant``. Keeping
    the legacy ``"translations"`` prefetch as well would materialize BOTH
    copies of every translation -- 100,000 characters each, unbounded in count,
    on an anonymous route. A query-count test cannot see it; only the deferred
    columns can.
    """
    page = corpus["pages"]["translated"]

    with override_settings(ZPAGE_VARIANT_READS=True):
        with CaptureQueriesContext(connection) as captured:
            response = api_client.get(
                f"/api/zpage/{page.free2zaddr}/", HTTP_HOST=HOST
            )

    assert response.status_code == 200

    translation_sql = [
        query["sql"] for query in captured.captured_queries
        if "g12f_zpagetranslation" in query["sql"]
    ]
    assert translation_sql, "the legacy prefetch should still run, metadata-only"
    for sql in translation_sql:
        assert '"g12f_zpagetranslation"."content"' not in sql

    variant_sql = [
        query["sql"] for query in captured.captured_queries
        if "g12f_zpagevariant" in query["sql"]
    ]
    assert any(
        '"g12f_zpagevariant"."content"' in sql for sql in variant_sql
    ), "exactly one shape should be carrying the bodies, and it is this one"


@pytest.mark.django_db
def test_the_reconciler_gate_exits_non_zero_while_drift_remains(corpus):
    page = corpus["pages"]["translated"]
    ZPageVariant.objects.filter(zpage=page, language="es").update(
        content="DIVERGED"
    )
    with pytest.raises(SystemExit):
        call_command("reconcile_zpage_variants", "--fail-on-drift", show=0)


# --- dual write keeps running (M6 is not this change) ------------------------ #

@pytest.mark.django_db
def test_flipping_reads_does_not_stop_the_mirror(corpus):
    """M5 flips reads. M6 stops writing. Conflating them loses the rollback.

    With reads flipped, a write must STILL land in both shapes -- that is what
    makes turning the flag back off a no-op rather than a data loss.
    """
    page = corpus["pages"]["lonely"]

    with override_settings(ZPAGE_VARIANT_READS=True):
        page.title = "Retitled while flipped"
        page.content = "Rewritten while flipped"
        page.save()
        _translation(page, "es", title="Nueva")

    page.refresh_from_db()
    assert page.title == "Retitled while flipped"
    source = ZPageVariant.objects.get(zpage=page, origin=ZPageVariant.SOURCE)
    assert source.title == "Retitled while flipped"
    assert source.content == "Rewritten while flipped"
    assert ZPageTranslation.objects.filter(zpage=page, language="es").exists()
    assert ZPageVariant.objects.filter(zpage=page, language="es").exists()

    # And the round trip is clean in both directions.
    with override_settings(ZPAGE_VARIANT_READS=False):
        legacy = resolve_zpage_variant(zPage.objects.get(pk=page.pk), "es")
    with override_settings(ZPAGE_VARIANT_READS=True):
        flipped = resolve_zpage_variant(zPage.objects.get(pk=page.pk), "es")
    assert legacy.title == flipped.title == "Nueva"


@pytest.mark.django_db
def test_a_write_response_is_byte_identical(corpus, api_client):
    """Writes render a response too, and it resolves like any other read."""
    api_client.force_authenticate(corpus["creator"])
    page = corpus["pages"]["lonely"]

    def call():
        response = api_client.patch(
            f"/api/zpage/{page.free2zaddr}/",
            {"description": "edited"},
            format="json",
            HTTP_HOST=HOST,
        )
        payload = response.json()
        # `updated_at` moves with the clock, not with the flag.
        payload.pop("updated_at", None)
        return response.status_code, payload

    assert_identical(call, "patch response")


# --- cost -------------------------------------------------------------------- #

@pytest.mark.django_db
def test_the_flag_off_costs_exactly_what_it_costs_today(corpus, api_client):
    """No variant query is issued while M5 is off, on any read path.

    ``feed_variant_prefetch`` returns an empty tuple rather than a prefetch
    that is loaded and ignored, so the staged rollout really is free until it
    is turned on.
    """
    paths = [
        "/api/zpage/",
        f"/api/zpage/{corpus['pages']['translated'].free2zaddr}/",
    ]
    for path in paths:
        with override_settings(ZPAGE_VARIANT_READS=False):
            with CaptureQueriesContext(connection) as captured:
                api_client.get(path, HTTP_HOST=HOST)
        variant_queries = [
            query for query in captured.captured_queries
            if "g12f_zpagevariant" in query["sql"]
        ]
        if path == "/api/zpage/":
            assert variant_queries == [], (
                "the feed must not touch the variant table while M5 is off"
            )


@pytest.mark.django_db
def test_the_feed_adds_exactly_one_query_when_flipped(corpus, api_client):
    """One prefetch for the whole page of results, not one per row."""
    with override_settings(ZPAGE_VARIANT_READS=True):
        with CaptureQueriesContext(connection) as captured:
            api_client.get("/api/zpage/", HTTP_HOST=HOST)

    variant_queries = [
        query for query in captured.captured_queries
        if "g12f_zpagevariant" in query["sql"]
    ]
    assert len(variant_queries) == 1, variant_queries


# --- admin ------------------------------------------------------------------- #

def test_the_variant_admin_is_readable_and_not_writable():
    """Staff need to see the table readers now resolve out of -- and only see it.

    Nothing mirrors a variant edit back to the legacy columns, so an editable
    admin would manufacture the drift the reconciler exists to remove.
    """
    from django.contrib import admin

    variant_admin = admin.site._registry[ZPageVariant]
    assert variant_admin.has_add_permission(None) is False
    assert variant_admin.has_change_permission(None) is False
    assert variant_admin.has_delete_permission(None) is False


@pytest.mark.django_db
def test_admin_edits_still_reach_both_shapes(corpus):
    """The admin writes the legacy shape; dual write carries it across."""
    page = corpus["pages"]["lonely"]
    with override_settings(ZPAGE_VARIANT_READS=True):
        zpage = zPage.objects.get(pk=page.pk)
        zpage.title = "Edited in admin"
        zpage.save()

    assert ZPageVariant.objects.get(
        zpage=page, origin=ZPageVariant.SOURCE
    ).title == "Edited in admin"


# --- summaries --------------------------------------------------------------- #

@pytest.mark.django_db
def test_variant_summaries_are_byte_identical(corpus):
    for name, page in corpus["pages"].items():
        for include_drafts in (False, True):
            def call(page=page, include_drafts=include_drafts):
                fresh = zPage.objects.get(pk=page.pk)
                return [
                    (row.language, row.origin, row.is_published, row.is_stale,
                     row.title, row.description, row.updated_at)
                    for row in variant_summaries(
                        fresh, include_drafts=include_drafts
                    )
                ]

            assert_identical(call, f"summaries {name} drafts={include_drafts}")
