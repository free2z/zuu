"""Tests for the bounded, canonical-safe sitemap index feeds."""

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import contextlib
import json
import logging
import threading
import uuid

import pytest
from django.core.cache import cache
from django.db import (
    InterfaceError,
    OperationalError,
    ProgrammingError,
    connection,
    connections,
    transaction,
)
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage
from dj.apps.g12f.views.sitemap import (
    _CHUNK_STATEMENT_TIMEOUT_MS,
    _INDEX_DB_LOCK_ID,
    _INDEX_STATEMENT_TIMEOUT_MS,
    _SITEMAP_EVENT_MAX_BYTES,
    _build_chunk_under_statement_timeout,
    _build_index_under_statement_timeout,
    _chunk_lock_id,
    _database_lane,
    _database_error_fields,
    _database_error_kind,
    _log_sitemap_event,
    _safe_error_stack,
    _tag_queryset,
    SITEMAP_CHUNK_SIZE,
    SITEMAP_LEGACY_VARIANT_CAP,
    SITEMAP_MAX_DYNAMIC_PAGES,
    SITEMAP_MAX_PAGE,
    SITEMAP_MAX_VARIANTS_PER_ZPAGE,
    SITEMAP_WIDE_VARIANTS_GENERATION_CAP,
    SitemapDatabaseBusy,
    SitemapDatabaseUnavailable,
    build_sitemap_chunk,
    build_sitemap_index,
    make_sitemap_revision,
)
from dj.apps.g12f.models import ZPageTranslation
from dj.apps.uploads.models import GenericFile
from dj.apps.tagging.models import TagAlias
from taggit.models import Tag

from f2z import languages


def _image(creator):
    return GenericFile.objects.create(
        owner=creator,
        file=f"uploads/sitemap-test-{uuid.uuid4().hex}.png",  # one key, one row
        mime_type="image/png",
    )


def _listed_creator(creator_factory, username):
    creator = creator_factory(username=username)
    creator.avatar_image = _image(creator)
    creator.banner_image = _image(creator)
    creator.save()
    return creator


def _page(
    creator, *, canonical_url="", published=True, title="Article", vanity=None
):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=vanity if vanity is not None else f"article-{uuid.uuid4()}",
        title=title,
        content="Article body",
        canonical_url=canonical_url,
        is_published=published,
    )


def _page_number(instance, chunk_size=SITEMAP_CHUNK_SIZE):
    return (instance.pk - 1) // chunk_size


def _chunk_path(kind, page, count):
    revision = make_sitemap_revision(kind, page, count)
    return f"/api/sitemap/{kind}/{page}/{revision}/"


def _sitemap_log_payloads(caplog):
    return [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == "dj.apps.g12f.views.sitemap"
    ]


@pytest.mark.django_db
def test_index_and_chunks_are_slim_complete_and_exclude_external_canonicals(
    api_client, creator_factory
):
    creator = _listed_creator(creator_factory, "sitemap-author")
    internal = _page(creator)
    _page(creator, canonical_url="https://publisher.example/original")
    _page(creator, published=False)
    _page(creator, title="")

    index_response = api_client.get("/api/sitemap/")

    assert index_response.status_code == 200, index_response.data
    assert index_response["Cache-Control"] == "no-store"
    assert index_response["Content-Type"].startswith("application/json")
    assert "Cookie" not in index_response.get("Vary", "")
    assert "Accept" not in index_response.get("Vary", "")
    assert index_response.data == {
        "chunk_size": SITEMAP_CHUNK_SIZE,
        "creators": [{
            "page": _page_number(creator),
            "count": 1,
            "revision": make_sitemap_revision(
                "creators", _page_number(creator), 1
            ),
        }],
        "zpages": [{
            "page": _page_number(internal),
            "count": 1,
            "revision": make_sitemap_revision(
                "zpages", _page_number(internal), 1
            ),
        }],
        # The `/tag/<slug>` hubs. Empty here on purpose: these fixture
        # pages carry no tags, and a hub needs TAG_HUB_INDEX_MIN_PAGES before
        # it is worth submitting at all.
        "tags": [],
    }

    creator_response = api_client.get(
        _chunk_path("creators", _page_number(creator), 1)
    )
    zpage_response = api_client.get(
        _chunk_path("zpages", _page_number(internal), 1)
    )

    assert creator_response.status_code == 200
    assert creator_response.data == {
        "kind": "creators",
        "page": _page_number(creator),
        "creators": [{"username": creator.username}],
    }
    assert creator_response["Cache-Control"] == "no-store"
    assert "Cookie" not in creator_response.get("Vary", "")
    assert zpage_response.status_code == 200
    assert zpage_response.data == {
        "kind": "zpages",
        "page": _page_number(internal),
        "zpages": [{
            "username": creator.username,
            "vanity": internal.vanity,
            "updated_at": internal.updated_at.isoformat().replace("+00:00", "Z"),
            # An untranslated page has exactly one variant, so its clean URL is
            # still its own canonical and the SvelteKit renderer emits it
            # unchanged, with no hreflang cluster at all.
            "languages": ["und"],
            "source_language": "und",
        }],
    }

    negotiated = api_client.get(
        _chunk_path("zpages", _page_number(internal), 1),
        HTTP_X_FREE2Z_SITEMAP_CANONICAL_ADDRESS="1",
    )
    assert negotiated.status_code == 200
    assert negotiated.data["zpages"] == [{
        **zpage_response.data["zpages"][0],
        "free2zaddr": internal.free2zaddr,
    }]


@pytest.mark.django_db
def test_a_wide_variant_list_is_served_only_to_a_caller_that_asked(
    api_client, creator_factory
):
    """The rollout hazard  would otherwise have shipped.

    Django and SvelteKit are separate Deployments and `bin/bazel-apply.sh`
    rolls the backend FIRST. `parseZPageEntries` in
    ts/svelte/free2z/src/lib/server/sitemap.ts throws on a row whose
    `languages` is longer than the bound it was compiled with, and that throw
    503s the whole sitemap child -- up to 500 unrelated articles, for the
    length of the rollout, or indefinitely if the frontend roll fails.

    So the raise from 32 to 65 is negotiated with a request header, exactly as
    `free2zaddr` is. Found by the codex adversarial review.
    """
    creator = _listed_creator(creator_factory, "wide-variant-author")
    page = _page(creator)
    page.source_language = "en"
    page.save(update_fields=["source_language"])
    # More published translations than the legacy parser accepts, fewer than
    # the new one does. Real tags, or `_available_languages` drops them before
    # any cap is reached.
    filler = [
        code
        for code in (
            f"{first}{second}"
            for first in "abcdefghijklmnopqrstuvwxyz"
            for second in "abcdefghijklmnopqrstuvwxyz"
        )
        if code != "en" and languages.is_detectable(code)
    ][:SITEMAP_LEGACY_VARIANT_CAP + 6]
    assert len(filler) == SITEMAP_LEGACY_VARIANT_CAP + 6
    for code in filler:
        ZPageTranslation.objects.create(
            zpage=page,
            language=code,
            title="t",
            content="c",
            is_published=True,
        )

    path = _chunk_path("zpages", _page_number(page), 1)

    legacy = api_client.get(path)
    assert legacy.status_code == 200
    legacy_languages = legacy.data["zpages"][0]["languages"]
    assert len(legacy_languages) == SITEMAP_LEGACY_VARIANT_CAP
    # Truncated by the SAME rule, so the source -- which owns the clean URL and
    # the x-default -- survives on both shapes.
    assert "en" in legacy_languages

    wide = api_client.get(path, HTTP_X_FREE2Z_SITEMAP_WIDE_VARIANTS="1")
    assert wide.status_code == 200
    wide_languages = wide.data["zpages"][0]["languages"]
    assert len(wide_languages) == len(filler) + 1
    assert len(wide_languages) > SITEMAP_LEGACY_VARIANT_CAP
    assert len(wide_languages) <= SITEMAP_MAX_VARIANTS_PER_ZPAGE
    assert "en" in wide_languages
    # The legacy answer is a prefix-by-membership of the wide one, never a
    # different set of languages: one truncation rule, two caps.
    assert set(legacy_languages).issubset(set(wide_languages))


@pytest.mark.django_db
def test_each_reader_generation_gets_a_list_its_own_parser_can_read(
    api_client, creator_factory
):
    """The rollout contract, and the 503  would otherwise have shipped.

    `bin/bazel-apply.sh` rolls Django BEFORE SvelteKit, so for the length of
    every rollout an OLD reader is talking to a NEW backend. `parseLanguages`
    throws on a row longer than that reader's own bound, and the throw 503s the
    whole sitemap child -- up to 499 unrelated articles offline, indefinitely
    if the frontend roll fails.

     negotiated this with a BOOLEAN, which could only ever name the one
    width its generation was compiled with (65). Raising the publish cap to 96
    in  made this backend able to emit 97, so answering that boolean with
    "the current maximum" is exactly the failure above. The header is numeric
    now, and the boolean is frozen at the width it actually meant.

    Three generations of reader, one fixture, all three answered with a list
    they can parse.
    """
    creator = _listed_creator(creator_factory, "variant-negotiation-author")
    page = _page(creator)
    page.source_language = "en"
    page.save(update_fields=["source_language"])
    # Real tags -- `_available_languages` drops anything `is_detectable`
    # rejects, so synthetic filler would make every assertion below pass
    # against a list that never reached any cap ('s own fixture bug).
    # Enough of them to be over the  generation's width, so the frozen
    # boolean answer is distinguishable from the current maximum.
    filler = [
        code
        for code in (
            f"{first}{second}"
            for first in "abcdefghijklmnopqrstuvwxyz"
            for second in "abcdefghijklmnopqrstuvwxyz"
        )
        if code != "en" and languages.is_detectable(code)
    ][:SITEMAP_WIDE_VARIANTS_GENERATION_CAP + 8]
    assert len(filler) == SITEMAP_WIDE_VARIANTS_GENERATION_CAP + 8, (
        "the fixture must exceed the frozen generation width to test it"
    )
    assert len(filler) + 1 <= SITEMAP_MAX_VARIANTS_PER_ZPAGE, (
        "and must still be inside what the write path allows"
    )
    for code in filler:
        ZPageTranslation.objects.create(
            zpage=page,
            language=code,
            title="t",
            content="c",
            is_published=True,
        )

    path = _chunk_path("zpages", _page_number(page), 1)

    def languages_for(**headers):
        response = api_client.get(path, **headers)
        assert response.status_code == 200, response.data
        return response.data["zpages"][0]["languages"]

    # 1. Pre-: no header at all.
    legacy = languages_for()
    assert len(legacy) == SITEMAP_LEGACY_VARIANT_CAP

    # 2.: the boolean. Frozen at the width that generation's parser was
    #    compiled with -- NOT today's maximum, which is the whole point.
    boolean = languages_for(HTTP_X_FREE2Z_SITEMAP_WIDE_VARIANTS="1")
    assert len(boolean) == SITEMAP_WIDE_VARIANTS_GENERATION_CAP
    assert len(boolean) < len(filler) + 1, (
        "the fixture is not actually exercising the frozen width"
    )

    # 3.: the caller states its own number. The newest reader sends BOTH
    #    headers (so it also works against a Django that predates this change),
    #    and the numeric one must win.
    wide = languages_for(
        HTTP_X_FREE2Z_SITEMAP_MAX_VARIANTS=str(SITEMAP_MAX_VARIANTS_PER_ZPAGE),
        HTTP_X_FREE2Z_SITEMAP_WIDE_VARIANTS="1",
    )
    assert len(wide) == len(filler) + 1
    assert len(wide) > SITEMAP_WIDE_VARIANTS_GENERATION_CAP

    # A reader narrower than this backend gets exactly what it asked for...
    narrow = languages_for(HTTP_X_FREE2Z_SITEMAP_MAX_VARIANTS="40")
    assert len(narrow) == 40
    #...and a reader WIDER than this backend gets this backend's maximum,
    # never an error: a newer SvelteKit against an older Django is the other
    # half of every rollout.
    ahead = languages_for(HTTP_X_FREE2Z_SITEMAP_MAX_VARIANTS="100000")
    assert len(ahead) == len(filler) + 1

    # A representation hint on a READ never fails the read. An unusable value
    # degrades to the narrowest safe answer instead of a 4xx that hands the
    # crawler nothing.
    for junk in ("", "0", "-1", "sixty-five", "65.5", "  "):
        assert len(languages_for(HTTP_X_FREE2Z_SITEMAP_MAX_VARIANTS=junk)) == (
            SITEMAP_LEGACY_VARIANT_CAP
        ), f"{junk!r} should have degraded, not widened or failed"

    # Every generation's answer is a subset of the widest one, truncated by the
    # one shared rule -- never a different set of languages, and the source
    # (which owns the clean URL and the x-default) survives all of them.
    for answer in (legacy, boolean, narrow, wide, ahead):
        assert "en" in answer
        assert set(answer).issubset(set(wide))


@pytest.mark.django_db
def test_reserved_vanities_are_never_advertised_in_the_sitemap(
    api_client, creator_factory
):
    #`validate_vanity` has refused a new zPage with one of these
    # vanities since, but a row written before that reservation existed
    # can still carry one -- and the Django crawler tier already 404s all of
    # them via `_reject_reserved_vanity`. A published legacy row at
    # `dashboard` (lowercase, from RESERVED_VANITIES verbatim) or `Dashboard`
    # (mixed-case, the kind a pre- row can be) must not be handed to
    # Google as an article URL the reader tier refuses to serve.
    creator = _listed_creator(creator_factory, "reserved-vanity-author")
    reserved_lower = _page(creator, vanity="ppv")
    reserved_mixed_case = _page(creator, vanity="Dashboard")
    normal = _page(creator)

    index_response = api_client.get("/api/sitemap/")

    assert index_response.status_code == 200, index_response.data
    assert index_response.data["zpages"] == [{
        "page": _page_number(normal),
        "count": 1,
        "revision": make_sitemap_revision("zpages", _page_number(normal), 1),
    }]

    chunk_response = api_client.get(
        _chunk_path("zpages", _page_number(normal), 1)
    )
    assert chunk_response.status_code == 200
    vanities_in_chunk = {row["vanity"] for row in chunk_response.data["zpages"]}
    assert vanities_in_chunk == {normal.vanity}
    assert reserved_lower.vanity not in vanities_in_chunk
    assert reserved_mixed_case.vanity not in vanities_in_chunk


@pytest.mark.django_db
def test_primary_key_pages_are_deterministic_bounded_and_end_partial(
    creator_factory,
):
    creators = [
        _listed_creator(creator_factory, f"chunk-author-{index}")
        for index in range(5)
    ]
    expected_counts = Counter((creator.pk - 1) // 2 for creator in creators)

    manifest = build_sitemap_index(chunk_size=2)["creators"]

    assert manifest == [
        {
            "page": page,
            "count": count,
            "revision": make_sitemap_revision("creators", page, count),
        }
        for page, count in sorted(expected_counts.items())
    ]
    assert sum(item["count"] for item in manifest) == 5
    assert all(1 <= item["count"] <= 2 for item in manifest)
    assert any(item["count"] < 2 for item in manifest)

    for item in manifest:
        chunk = build_sitemap_chunk("creators", item["page"], chunk_size=2)
        assert chunk["page"] == item["page"]
        assert len(chunk["creators"]) == item["count"]
        expected = [
            creator.username
            for creator in sorted(creators, key=lambda value: value.pk)
            if (creator.pk - 1) // 2 == item["page"]
        ]
        assert [row["username"] for row in chunk["creators"]] == expected


@pytest.mark.django_db
def test_index_uses_one_bounded_cache_key_but_chunks_are_always_fresh(
    api_client, mocker
):
    cache.clear()
    index_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index",
        return_value={
            "chunk_size": SITEMAP_CHUNK_SIZE,
            "creators": [],
            "zpages": [],
            "tags": [],
        },
    )
    chunk_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk",
        return_value={
            "kind": "creators",
            "page": 0,
            "creators": [{"username": "cached"}],
        },
    )

    for _ in range(2):
        assert api_client.get("/api/sitemap/").status_code == 200
        assert api_client.get(_chunk_path("creators", 0, 1)).status_code == 200

    index_builder.assert_called_once_with()
    assert chunk_builder.call_count == 2
    chunk_builder.assert_called_with("creators", 0)


@pytest.mark.django_db
def test_database_lane_rejects_parallel_sitemap_work_before_querying(
    api_client, mocker
):
    cache.clear()
    acquire = mocker.patch(
        "dj.apps.g12f.views.sitemap._acquire_database_lock",
        side_effect=SitemapDatabaseBusy,
    )
    index_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index"
    )
    chunk_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk"
    )

    # Capability validation remains ahead of database-lane coordination.
    forged = api_client.get(
        "/api/sitemap/creators/0/1-abcdefghijklmnop/"
    )
    index_response = api_client.get("/api/sitemap/")
    chunk_response = api_client.get(_chunk_path("creators", 0, 1))

    assert forged.status_code == 404
    for response in (index_response, chunk_response):
        assert response.status_code == 503
        assert response["Cache-Control"] == "no-store"
        assert response["Retry-After"] == "30"
        assert response["X-Sitemap-Protocol"] == "2"
    index_builder.assert_not_called()
    chunk_builder.assert_not_called()
    assert acquire.call_count == 2
    cache.clear()


@pytest.mark.django_db
def test_busy_child_lane_is_counted_by_its_existing_access_record(
    api_client, mocker, caplog
):
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")
    cache.clear()
    mocker.patch(
        "dj.apps.g12f.views.sitemap._acquire_database_lock",
        side_effect=SitemapDatabaseBusy,
    )

    response = api_client.get(_chunk_path("creators", 0, 1))

    assert response.status_code == 503
    assert response["X-Sitemap-Outcome"] == "lane_busy"
    assert _sitemap_log_payloads(caplog) == []


@pytest.mark.django_db
def test_revision_conflict_is_counted_by_its_existing_access_record(
    api_client, mocker, caplog
):
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")
    cache.clear()
    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk",
        return_value=None,
    )

    response = api_client.get(_chunk_path("zpages", 0, 1))

    assert response.status_code == 409
    assert response["X-Sitemap-Outcome"] == "revision_conflict"
    assert _sitemap_log_payloads(caplog) == []


@pytest.mark.django_db
def test_revision_conflict_is_not_a_django_request_warning(
    api_client, mocker, caplog
):
    """A stale child capability is a designed 409, not an error.

    `django.request` would otherwise log "Conflict: <path>" at WARNING, and
    a plain-text stderr line is graded ERROR in GKE. The access record is
    the one line this outcome gets.
    """
    caplog.set_level(logging.INFO, logger="django.request")
    cache.clear()
    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk",
        return_value=None,
    )

    response = api_client.get(_chunk_path("zpages", 0, 1))

    assert response.status_code == 409
    assert [
        record.getMessage()
        for record in caplog.records
        if record.name == "django.request"
    ] == []


@pytest.mark.django_db
def test_forged_sitemap_revision_is_still_a_logged_404(api_client, caplog):
    """Only the designed 409 is quiet; a bad capability still logs."""
    caplog.set_level(logging.INFO, logger="django.request")

    response = api_client.get("/api/sitemap/zpages/0/1-AAAAAAAAAAAAAAAA/")

    assert response.status_code == 404
    assert any(
        record.name == "django.request"
        and record.getMessage().startswith("Not Found:")
        for record in caplog.records
    )


@pytest.mark.django_db
def test_lock_acquisition_database_failure_is_not_counted_as_lane_contention(
    api_client, mocker, caplog
):
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")
    cache.clear()
    database_error = OperationalError("server closed the connection")
    unavailable = SitemapDatabaseUnavailable()
    unavailable.__cause__ = database_error
    mocker.patch(
        "dj.apps.g12f.views.sitemap._acquire_database_lock",
        side_effect=unavailable,
    )

    response = api_client.get(_chunk_path("creators", 0, 1))

    assert response.status_code == 503
    assert response["X-Sitemap-Outcome"] == "database_error"
    payload = _sitemap_log_payloads(caplog)[0]
    assert payload["outcome"] == "database_error"
    assert payload["operation"] == "advisory_lock_acquire"
    assert payload["error_category"] == "connection_closed"


@pytest.mark.django_db
def test_index_lock_database_failure_is_safely_observable(
    api_client, mocker, caplog
):
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")
    cache.clear()
    database_error = InterfaceError("connection already closed")
    unavailable = SitemapDatabaseUnavailable()
    unavailable.__cause__ = database_error
    mocker.patch(
        "dj.apps.g12f.views.sitemap._acquire_database_lock",
        side_effect=unavailable,
    )

    response = api_client.get("/api/sitemap/")

    assert response.status_code == 503
    assert response["X-Sitemap-Outcome"] == "database_error"
    payload = _sitemap_log_payloads(caplog)[0]
    assert payload["event"] == "sitemap_index"
    assert payload["operation"] == "advisory_lock_acquire"
    assert payload["error_type"] == "InterfaceError"


@pytest.mark.django_db(transaction=True)
def test_interface_error_during_lock_acquisition_remains_retryable(mocker):
    if connection.vendor != "postgresql":
        pytest.skip("advisory lanes are only exercised on PostgreSQL")

    mocker.patch.object(
        connection,
        "cursor",
        side_effect=InterfaceError("connection already closed"),
    )

    with pytest.raises(SitemapDatabaseUnavailable) as raised:
        with _database_lane(_INDEX_DB_LOCK_ID):
            raise AssertionError("the body must not run without the lane")

    assert isinstance(raised.value.__cause__, InterfaceError)


@pytest.mark.django_db
def test_operational_errors_emit_a_structured_observation_with_safe_class(
    api_client, mocker, caplog
):
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")
    cache.clear()
    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk",
        side_effect=OperationalError("canceling statement due to statement timeout"),
    )

    response = api_client.get(_chunk_path("creators", 0, 1))

    assert response.status_code == 503
    payloads = _sitemap_log_payloads(caplog)
    assert len(payloads) == 1
    payload = payloads[0]
    fingerprint = payload.pop("error_fingerprint")
    error_stack = payload.pop("error_stack")
    assert len(fingerprint) == 16
    assert all(character in "0123456789abcdef" for character in fingerprint)
    assert error_stack
    assert all("canceling statement" not in frame for frame in error_stack)
    assert payload == {
        "severity": "ERROR",
        "message": "Sitemap chunk read failed at the database.",
        "event": "sitemap_chunk",
        "outcome": "database_error",
        "sitemap_kind": "creators",
        "sitemap_page": 0,
        "operation": "chunk_read",
        "error_kind": "statement_timeout",
        "error_category": "statement_timeout",
        "error_type": "OperationalError",
    }
    sitemap_record = next(
        record
        for record in caplog.records
        if record.name == "dj.apps.g12f.views.sitemap"
    )
    assert "canceling statement" not in sitemap_record.getMessage()
    assert sitemap_record.exc_info is None


def test_safe_error_stack_keeps_origin_without_sensitive_exception_data():
    secret = "postgresql://dbuser:password@private-host/database"

    def raise_database_error():
        raise OperationalError(secret)

    try:
        raise_database_error()
    except OperationalError as exc:
        stack = _safe_error_stack(exc)

    encoded = json.dumps(stack)
    assert len(stack) <= 8
    assert any(":raise_database_error:" in frame for frame in stack)
    assert secret not in encoded
    assert "/home/" not in encoded


def test_sitemap_event_logging_has_a_hard_payload_bound(caplog):
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")

    _log_sitemap_event(
        "lane_busy",
        "INFO",
        "Sitemap chunk lane is busy; the crawler should retry.",
        future_request_controlled_field="x" * (_SITEMAP_EVENT_MAX_BYTES * 2),
    )

    record = next(
        record
        for record in caplog.records
        if record.name == "dj.apps.g12f.views.sitemap"
    )
    assert len(record.getMessage().encode("utf-8")) <= _SITEMAP_EVENT_MAX_BYTES
    assert json.loads(record.getMessage()) == {
        "severity": "INFO",
        "message": "Sitemap event exceeded its safe logging bound.",
        "event": "sitemap_chunk",
        "outcome": "lane_busy",
        "payload_truncated": True,
    }


def test_unknown_sitemap_event_severity_fails_closed_to_error_logging(caplog):
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")

    _log_sitemap_event(
        "database_error",
        "UNRECOGNIZED",
        "Sitemap database operation failed.",
        event="sitemap_index",
    )

    record = next(
        record
        for record in caplog.records
        if record.name == "dj.apps.g12f.views.sitemap"
    )
    assert record.levelno == logging.ERROR
    assert json.loads(record.getMessage())["event"] == "sitemap_index"


def test_oversized_database_event_retains_alert_metric_fields(caplog):
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")

    _log_sitemap_event(
        "database_error",
        "ERROR",
        "Sitemap chunk read failed at the database.",
        error_kind="statement_timeout",
        error_category="statement_timeout",
        operation="chunk_read",
        error_stack=["x" * (_SITEMAP_EVENT_MAX_BYTES * 2)],
    )

    payload = _sitemap_log_payloads(caplog)[0]
    assert payload["payload_truncated"] is True
    assert payload["outcome"] == "database_error"
    assert payload["error_kind"] == "statement_timeout"
    assert payload["operation"] == "chunk_read"


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("canceling statement due to statement timeout", "statement_timeout"),
        ("server closed the connection unexpectedly", "operational_error"),
    ],
)
def test_database_error_kind_does_not_require_driver_specific_exception_types(
    message, expected
):
    assert _database_error_kind(OperationalError(message)) == expected


def test_generic_query_cancellation_is_not_counted_as_a_statement_timeout():
    class DriverCancellation(Exception):
        pgcode = "57014"

    driver_error = DriverCancellation("canceling statement due to user request")
    wrapped_error = OperationalError("database operation failed")
    wrapped_error.__cause__ = driver_error

    fields = _database_error_fields(wrapped_error)

    assert fields["error_kind"] == "query_cancelled"
    assert fields["error_category"] == "query_cancelled"
    assert fields["error_type"] == "DriverCancellation"
    assert fields["sqlstate"] == "57014"
    assert len(fields["error_fingerprint"]) == 16


def test_database_fingerprint_cannot_oracle_sensitive_exception_text():
    first = _database_error_fields(
        OperationalError("password=first-secret host=private-one")
    )
    second = _database_error_fields(
        OperationalError("password=second-secret host=private-two")
    )

    assert first["error_fingerprint"] == second["error_fingerprint"]
    assert "secret" not in json.dumps(first)
    assert "private" not in json.dumps(second)


def test_database_classification_cannot_break_the_retryable_503_path():
    class BrokenDriverError(Exception):
        @property
        def sqlstate(self):
            raise RuntimeError("driver property failed")

        def __str__(self):
            raise RuntimeError("driver formatting failed")

    wrapped = OperationalError("database operation failed")
    wrapped.__cause__ = BrokenDriverError()

    fields = _database_error_fields(wrapped)

    assert fields["error_kind"] == "operational_error"
    assert fields["error_category"] == "operational_error"
    assert fields["error_type"] == "BrokenDriverError"


@pytest.mark.parametrize(
    ("message", "expected_category"),
    [
        ("connection refused", "connection_refused"),
        ("server closed the connection unexpectedly", "connection_closed"),
        ("could not translate host name db", "name_resolution"),
        ("connection timed out", "connection_timeout"),
        ("SSL connection was closed", "transport_security"),
        ("unknown driver failure", "operational_error"),
    ],
)
def test_database_error_fields_add_safe_diagnostic_category(
    message, expected_category
):
    first = _database_error_fields(OperationalError(message))
    second = _database_error_fields(OperationalError(message))

    assert first["error_category"] == expected_category
    assert first["error_fingerprint"] == second["error_fingerprint"]
    assert message not in json.dumps(first)


@pytest.mark.django_db
def test_unavailable_shared_cache_fails_before_manifest_aggregate(
    api_client, mocker
):
    cache.clear()
    mocker.patch.object(cache, "get", return_value=None)
    mocker.patch.object(cache, "add", return_value=False)
    index_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index"
    )

    response = api_client.get("/api/sitemap/")

    assert response.status_code == 503
    assert response["Cache-Control"] == "no-store"
    assert response["Retry-After"] == "30"
    index_builder.assert_not_called()


@pytest.mark.django_db
def test_read_only_shared_cache_fails_before_manifest_aggregate(
    api_client, mocker
):
    cache.clear()
    mocker.patch.object(cache, "add", return_value=None)
    mocker.patch.object(cache, "touch", return_value=False)
    # The first value is the manifest miss. The second models a stale readable
    # health marker that the old implementation trusted without proving this
    # request could write to Redis.
    cache_get = mocker.patch.object(cache, "get", side_effect=[None, True])
    index_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index"
    )

    response = api_client.get("/api/sitemap/")

    assert response.status_code == 503
    assert response["Cache-Control"] == "no-store"
    assert response["Retry-After"] == "30"
    cache_get.assert_called_once_with("sitemap:index:v3")
    index_builder.assert_not_called()


@pytest.mark.django_db
def test_index_overflow_is_memoized_under_the_fixed_manifest_key(
    api_client, mocker
):
    cache.clear()
    index_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index",
        return_value=None,
    )

    first = api_client.get("/api/sitemap/")
    second = api_client.get("/api/sitemap/")

    assert first.status_code == second.status_code == 503
    assert first["Retry-After"] == second["Retry-After"] == "300"
    index_builder.assert_called_once_with()
    cache.clear()


@pytest.mark.django_db
def test_index_accepts_exactly_50000_children_and_rejects_50001(
    api_client, mocker
):
    dynamic_pages = [
        {
            "page": page,
            "count": 1,
            "revision": make_sitemap_revision("creators", page, 1),
        }
        for page in range(SITEMAP_MAX_DYNAMIC_PAGES)
    ]
    manifest_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap._bounded_page_manifest",
        # Three kinds now: creators, zpages, tags. The budget is
        # consumed in that order, so the tag manifest is asked for last and
        # gets whatever the first two left.
        side_effect=[dynamic_pages, [], []],
    )

    exact = build_sitemap_index()

    assert exact is not None
    assert (
        len(exact["creators"])
        + len(exact["zpages"])
        + len(exact["tags"])
        + 1
    ) == 50_000
    assert manifest_builder.call_args_list[0].args[-1] == 49_999

    manifest_builder.reset_mock()
    manifest_builder.side_effect = [
        dynamic_pages + [{
            "page": SITEMAP_MAX_DYNAMIC_PAGES,
            "count": 1,
            "revision": make_sitemap_revision(
                "creators", SITEMAP_MAX_DYNAMIC_PAGES, 1
            ),
        }]
    ]
    assert build_sitemap_index() is None
    manifest_builder.assert_called_once()

    cache.clear()
    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index",
        return_value=None,
    )
    overflow = api_client.get("/api/sitemap/")
    assert overflow.status_code == 503
    assert overflow["Cache-Control"] == "no-store"
    assert overflow["Retry-After"] == "300"


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("path", "expected_status"),
    [
        ("/api/sitemap/?nonce=unique", 400),
        (_chunk_path("creators", 0, 1) + "?nonce=unique", 400),
        ("/api/sitemap/creators/00/1-abcdefghijklmnop/", 404),
        ("/api/sitemap/unknown/0/1-abcdefghijklmnop/", 404),
        (
            _chunk_path("zpages", SITEMAP_MAX_PAGE + 1, 1),
            404,
        ),
        ("/api/sitemap/zpages/999999/1-abcdefghijklmnop/", 404),
    ],
    ids=[
        "index-cache-bust",
        "creator-cache-bust",
        "leading-zero-page",
        "unknown-kind",
        "page-overflow",
        "unknown-page",
    ],
)
def test_invalid_and_cache_busting_requests_fail_before_building(
    api_client, mocker, path, expected_status
):
    cache.clear()
    index_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index"
    )
    chunk_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk"
    )

    response = api_client.get(path)

    assert response.status_code == expected_status
    if "/00/" not in path:
        assert response["Cache-Control"] == "no-store"
    index_builder.assert_not_called()
    chunk_builder.assert_not_called()


@pytest.mark.django_db
def test_empty_and_overflow_chunks_fail_closed(api_client, mocker, caplog):
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")
    cache.clear()
    builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk",
        return_value=None,
    )
    empty = api_client.get(_chunk_path("zpages", 0, 1))
    assert empty.status_code == 409
    assert empty["Cache-Control"] == "no-store"
    builder.assert_called_once_with("zpages", 0)

    cache.clear()
    builder.reset_mock(side_effect=True)
    builder.side_effect = RuntimeError("fixed page bound exceeded")
    overflow = api_client.get(_chunk_path("zpages", 0, 1))
    assert overflow.status_code == 503
    assert overflow["Cache-Control"] == "no-store"
    assert overflow["Retry-After"] == "300"
    assert [payload["outcome"] for payload in _sitemap_log_payloads(caplog)] == [
        "bound_exceeded",
    ]
    assert empty["X-Sitemap-Outcome"] == "revision_conflict"


@pytest.mark.django_db
def test_cached_manifest_cannot_outlive_canonical_url_changes(
    api_client, creator_factory
):
    cache.clear()
    creator = _listed_creator(creator_factory, "canonical-transition-author")
    externalized = _page(creator)
    internal = _page(creator)
    page_number = _page_number(externalized)
    assert _page_number(internal) == page_number

    initial_index = api_client.get("/api/sitemap/")
    member = next(
        item
        for item in initial_index.data["zpages"]
        if item["page"] == page_number
    )
    child_path = (
        f"/api/sitemap/zpages/{page_number}/{member['revision']}/"
    )
    initial_child = api_client.get(child_path)
    assert initial_child.status_code == 200
    assert {row["vanity"] for row in initial_child.data["zpages"]} == {
        externalized.vanity,
        internal.vanity,
    }

    # The root manifest intentionally remains in its fixed five-minute cache.
    # A concurrent canonical mutation makes the signed count stale; the fresh
    # child must fail with 409 rather than return the now-external URL.
    externalized.canonical_url = "https://publisher.example/original"
    externalized.save()
    stale = api_client.get(child_path)
    assert stale.status_code == 409
    assert stale["Cache-Control"] == "no-store"

    # Once the bounded manifest cache refreshes, it issues a different signed
    # count capability and that child contains only the still-internal row.
    cache.clear()
    fresh_index = api_client.get("/api/sitemap/")
    fresh_member = next(
        item
        for item in fresh_index.data["zpages"]
        if item["page"] == page_number
    )
    assert fresh_member["count"] == 1
    assert fresh_member["revision"] != member["revision"]
    fresh = api_client.get(
        f"/api/sitemap/zpages/{page_number}/{fresh_member['revision']}/"
    )
    assert fresh.status_code == 200
    assert [row["vanity"] for row in fresh.data["zpages"]] == [internal.vanity]


@pytest.mark.django_db
def test_reused_count_capability_always_reads_current_canonical_rows(
    api_client, creator_factory
):
    cache.clear()
    creator = _listed_creator(creator_factory, "canonical-swap-author")
    externalized = _page(creator)
    internal = _page(creator)
    replacement = _page(
        creator,
        canonical_url="https://publisher.example/replacement",
    )
    page_number = _page_number(externalized)
    assert {
        _page_number(internal),
        _page_number(replacement),
    } == {page_number}

    member = next(
        item
        for item in api_client.get("/api/sitemap/").data["zpages"]
        if item["page"] == page_number
    )
    assert member["count"] == 2
    child_path = (
        f"/api/sitemap/zpages/{page_number}/{member['revision']}/"
    )

    # Keep the signed count unchanged while swapping which row is canonical.
    # The capability path is intentionally reused, but the uncached chunk must
    # still read current rows and can never return the newly external URL.
    externalized.canonical_url = "https://publisher.example/original"
    externalized.save()
    replacement.canonical_url = ""
    replacement.save()

    response = api_client.get(child_path)
    assert response.status_code == 200
    assert response["Cache-Control"] == "no-store"
    assert {row["vanity"] for row in response.data["zpages"]} == {
        internal.vanity,
        replacement.vanity,
    }
    assert externalized.vanity not in {
        row["vanity"] for row in response.data["zpages"]
    }


@contextlib.contextmanager
def _held_lane(lock_id):
    """Hold one advisory lane from a *different* database session."""
    acquired = threading.Event()
    release = threading.Event()
    problems = []

    def hold():
        # Held exactly the way production holds it: a
        # transaction-scoped lock, released by the end of the transaction.
        try:
            with transaction.atomic(using="default"):
                with connections["default"].cursor() as cursor:
                    cursor.execute(
                        "SELECT pg_try_advisory_xact_lock(%s)", [lock_id]
                    )
                    if not cursor.fetchone()[0]:
                        problems.append(f"lane {lock_id} was already held")
                acquired.set()
                release.wait(30)
        except Exception as exc:  # pragma: no cover - surfaced via `problems`
            problems.append(repr(exc))
            acquired.set()
        finally:
            connections["default"].close()

    worker = threading.Thread(target=hold, daemon=True)
    worker.start()
    assert acquired.wait(30), "holder thread never acquired the lane"
    try:
        assert not problems, problems
        yield
    finally:
        release.set()
        worker.join(30)
    assert not problems, problems


def _get_status_on_own_connection(path):
    """Issue one request from a thread with its own database session."""
    try:
        return APIClient().get(path).status_code
    finally:
        connections["default"].close()


def test_children_and_the_index_occupy_different_advisory_lanes():
    children = [("zpages", page) for page in range(256)]
    children += [("creators", page) for page in range(256)]
    lanes = [_chunk_lock_id(kind, page) for kind, page in children]

    # The whole defect in  was that every child took the index's single
    # lane, so any two concurrent sitemap requests contended.
    assert _INDEX_DB_LOCK_ID not in lanes
    # Distinct children get distinct lanes; that is what stops a parallel
    # crawl of the index from serializing.
    assert len(set(lanes)) == len(children)
    # Chunk lanes live in the negative int64 range and the index lane is
    # positive, so the two can never collide however the hash lands. They must
    # also fit a PostgreSQL bigint.
    assert all(-(2 ** 63) <= lane < 0 for lane in lanes)
    # Lanes must be identical in every process; PYTHONHASHSEED-dependent
    # hashing would silently give each pod a different mapping.
    assert _chunk_lock_id("zpages", 7) == _chunk_lock_id("zpages", 7)
    assert _chunk_lock_id("zpages", 7) != _chunk_lock_id("creators", 7)


@pytest.mark.django_db
def test_a_busy_index_lane_no_longer_503s_child_requests(
    api_client, creator_factory
):
    """The exact production failure: an index build blocking every child."""
    if connection.vendor != "postgresql":
        pytest.skip("advisory lanes are only exercised on PostgreSQL")

    cache.clear()
    creator = _listed_creator(creator_factory, "busy-lane-author")
    page_number = _page_number(creator)

    with _held_lane(_INDEX_DB_LOCK_ID):
        response = api_client.get(_chunk_path("creators", page_number, 1))

    assert response.status_code == 200, response.data
    assert response.data["creators"] == [{"username": creator.username}]
    cache.clear()


@pytest.mark.django_db
def test_one_busy_child_lane_does_not_503_a_different_child(
    api_client, creator_factory
):
    if connection.vendor != "postgresql":
        pytest.skip("advisory lanes are only exercised on PostgreSQL")

    cache.clear()
    creator = _listed_creator(creator_factory, "sibling-lane-author")
    page_number = _page_number(creator)
    sibling_lane = _chunk_lock_id("zpages", page_number)
    assert sibling_lane != _chunk_lock_id("creators", page_number)

    with _held_lane(sibling_lane):
        response = api_client.get(_chunk_path("creators", page_number, 1))

    assert response.status_code == 200, response.data
    cache.clear()


@pytest.mark.django_db
def test_every_advertised_child_fetched_in_parallel_is_served(mocker):
    """Reproduce the crawler access pattern that returned 10/15 503s."""
    if connection.vendor != "postgresql":
        pytest.skip("advisory lanes are only exercised on PostgreSQL")

    cache.clear()
    children = 15

    def slow_build(kind, page):
        # Long enough that every request genuinely overlaps every other one.
        threading.Event().wait(0.05)
        return {"kind": kind, "page": page, kind: [{"username": f"u{page}"}]}

    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk",
        side_effect=slow_build,
    )
    paths = [_chunk_path("creators", page, 1) for page in range(children)]

    with ThreadPoolExecutor(max_workers=children) as pool:
        statuses = list(pool.map(_get_status_on_own_connection, paths))

    # Before 's fix these all took one lane: pg_try_advisory_lock is
    # non-blocking, so all but one returned 503 in ~0.17s.
    assert statuses == [200] * children
    cache.clear()


@pytest.mark.django_db
def test_replays_of_one_child_still_serialize_on_that_childs_lane(
    api_client, creator_factory
):
    """The 503 backstop is kept: it just stops firing for *different* children."""
    if connection.vendor != "postgresql":
        pytest.skip("advisory lanes are only exercised on PostgreSQL")

    cache.clear()
    creator = _listed_creator(creator_factory, "replay-lane-author")
    page_number = _page_number(creator)

    with _held_lane(_chunk_lock_id("creators", page_number)):
        response = api_client.get(_chunk_path("creators", page_number, 1))

    assert response.status_code == 503
    assert response["Cache-Control"] == "no-store"
    assert response["Retry-After"] == "30"
    assert response["X-Sitemap-Protocol"] == "2"
    cache.clear()


@pytest.mark.django_db(transaction=True)
def test_the_index_statement_timeout_needs_its_own_transaction(mocker):
    """The index timeout must cover its aggregates, not just SET LOCAL."""
    if connection.vendor != "postgresql":
        pytest.skip("statement_timeout is only set on PostgreSQL")

    observed = []

    def probe():
        with connection.cursor() as cursor:
            cursor.execute("SHOW statement_timeout")
            observed.append(cursor.fetchone()[0])
        return {
            "chunk_size": SITEMAP_CHUNK_SIZE,
            "creators": [],
            "zpages": [],
            "tags": [],
        }

    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index", side_effect=probe
    )

    _build_index_under_statement_timeout()

    assert observed == [f"{_INDEX_STATEMENT_TIMEOUT_MS // 1000}s"]
    with connection.cursor() as cursor:
        cursor.execute("SHOW statement_timeout")
        assert cursor.fetchone()[0] == "0"


@pytest.mark.django_db(transaction=True)
def test_the_index_statement_timeout_does_not_leak_into_an_ambient_transaction(
    mocker,
):
    if connection.vendor != "postgresql":
        pytest.skip("statement_timeout is only set on PostgreSQL")

    observed = []

    def probe():
        with connection.cursor() as cursor:
            cursor.execute("SHOW statement_timeout")
            observed.append(cursor.fetchone()[0])
        return {
            "chunk_size": SITEMAP_CHUNK_SIZE,
            "creators": [],
            "zpages": [],
            "tags": [],
        }

    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index",
        side_effect=probe,
    )

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('statement_timeout', '100ms', true)"
            )
        _build_index_under_statement_timeout()

        assert observed == ["100ms"]
        with connection.cursor() as cursor:
            cursor.execute("SHOW statement_timeout")
            assert cursor.fetchone()[0] == "100ms"


@pytest.mark.django_db(transaction=True)
def test_normal_lock_release_preserves_ambient_transaction(mocker):
    if connection.vendor != "postgresql":
        pytest.skip("advisory lanes are only exercised on PostgreSQL")

    close_if_unusable = mocker.patch.object(
        connection, "close_if_unusable_or_obsolete"
    )
    close = mocker.patch.object(connection, "close")

    with transaction.atomic():
        with _database_lane(_INDEX_DB_LOCK_ID):
            pass
        # The lane was only a savepoint here; the ambient transaction is
        # still open and usable.
        assert connection.in_atomic_block
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")

    close_if_unusable.assert_not_called()
    close.assert_not_called()


@pytest.mark.django_db(transaction=True)
def test_an_index_read_that_overruns_its_timeout_degrades_to_503(
    api_client, mocker, caplog
):
    if connection.vendor != "postgresql":
        pytest.skip("statement_timeout is only set on PostgreSQL")

    cache.clear()
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")
    mocker.patch(
        "dj.apps.g12f.views.sitemap._INDEX_STATEMENT_TIMEOUT_MS", 100
    )

    def stall():
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_sleep(5)")
        raise AssertionError("pg_sleep should have been cancelled")

    index_builder = mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index", side_effect=stall
    )

    response = api_client.get("/api/sitemap/")

    assert response.status_code == 503
    assert response["Cache-Control"] == "no-store"
    assert response["Retry-After"] == "30"
    assert response["X-Sitemap-Protocol"] == "2"
    assert response["X-Sitemap-Outcome"] == "database_error"
    payload = _sitemap_log_payloads(caplog)[-1]
    assert payload["event"] == "sitemap_index"
    assert payload["outcome"] == "database_error"
    assert payload["operation"] == "index_build"
    assert payload["error_kind"] == "statement_timeout"
    assert payload["sqlstate"] == "57014"
    assert all(
        record.exc_info is None
        for record in caplog.records
        if record.name == "dj.apps.g12f.views.sitemap"
    )

    # A real PostgreSQL cancellation must roll back the aggregate transaction
    # and release the session-owned fleet-wide lane before the retry window.
    with _held_lane(_INDEX_DB_LOCK_ID):
        pass

    retry = api_client.get("/api/sitemap/")
    assert retry.status_code == 503
    assert retry["Retry-After"] == "30"
    index_builder.assert_called_once_with()
    cache.clear()


@pytest.mark.django_db
def test_a_non_transient_index_database_error_is_not_hidden_behind_a_503(
    api_client, mocker
):
    """A bad rollout must keep producing a traceback, not a generic 503."""
    if connection.vendor != "postgresql":
        pytest.skip("advisory lanes are only exercised on PostgreSQL")

    cache.clear()


    def schema_error():
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT * FROM "g12f_creator_that_does_not_exist"'
            )

    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_index",
        side_effect=schema_error,
    )

    with pytest.raises(ProgrammingError):
        api_client.get("/api/sitemap/")

    # The index lane must not leak when the build fails before caching.
    with _held_lane(_INDEX_DB_LOCK_ID):
        pass
    cache.clear()


@pytest.mark.django_db
def test_chunk_reads_run_under_a_bounded_statement_timeout(api_client, mocker):
    """gunicorn runs one sync worker per pod; an unbounded read costs the pod.

    NOTE: this runs under plain django_db, so pytest-django's own test
    transaction is ambient and would supply the transaction that SET LOCAL
    needs even if the helper's ``transaction.atomic()`` were deleted. The
    test that actually pins that atomic in place is
    ``test_the_chunk_statement_timeout_needs_its_own_transaction`` below.
    """
    if connection.vendor != "postgresql":
        pytest.skip("statement_timeout is only set on PostgreSQL")

    cache.clear()
    observed = {}

    def probe(kind, page):
        with connection.cursor() as cursor:
            cursor.execute("SHOW statement_timeout")
            observed["timeout"] = cursor.fetchone()[0]
        return {"kind": kind, "page": page, kind: [{"username": "probe"}]}

    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk", side_effect=probe
    )

    response = api_client.get(_chunk_path("creators", 0, 1))

    assert response.status_code == 200, response.data
    assert observed["timeout"] == f"{_CHUNK_STATEMENT_TIMEOUT_MS // 1000}s"
    cache.clear()


@pytest.mark.django_db(transaction=True)
def test_the_chunk_statement_timeout_needs_its_own_transaction(mocker):
    """Pins ``transaction.atomic()`` in _build_chunk_under_statement_timeout.

    Deleting that atomic -- the shape a well-meaning "simplify this" refactor
    takes -- silently removes the timeout in production and every other test
    still passes, because they run inside pytest-django's ambient transaction.
    In autocommit, set_config(..., is_local=True) is scoped to its own implicit
    single-statement transaction and is gone by the next statement:

        $ psql -c "SELECT set_config('statement_timeout','1000ms',true);" \
               -c "SHOW statement_timeout;"
         1s
         0

    transaction=True removes the ambient transaction, so this asserts the
    timeout is PRESENT during the build -- which only holds if the helper
    opened a real transaction of its own.
    """
    if connection.vendor != "postgresql":
        pytest.skip("statement_timeout is only set on PostgreSQL")

    observed = {}

    def probe(kind, page):
        with connection.cursor() as cursor:
            cursor.execute("SHOW statement_timeout")
            observed["timeout"] = cursor.fetchone()[0]
        return {"kind": kind, "page": page, kind: []}

    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk", side_effect=probe
    )

    _build_chunk_under_statement_timeout("creators", 0)

    assert observed["timeout"] == f"{_CHUNK_STATEMENT_TIMEOUT_MS // 1000}s"


@pytest.mark.django_db(transaction=True)
def test_the_chunk_statement_timeout_never_outlives_its_transaction(mocker):
    """CONN_MAX_AGE is 60s: a session-level SET would poison later requests."""
    if connection.vendor != "postgresql":
        pytest.skip("statement_timeout is only set on PostgreSQL")

    # transaction=True so this test is NOT itself inside an atomic block:
    # SET LOCAL is scoped to the OUTERMOST transaction, and on a real GET
    # (AtomicMiddleware only wraps write methods, ATOMIC_REQUESTS is off) the
    # atomic in _build_chunk_under_statement_timeout is that outermost one.
    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk",
        return_value={"kind": "creators", "page": 0, "creators": []},
    )

    _build_chunk_under_statement_timeout("creators", 0)

    with connection.cursor() as cursor:
        cursor.execute("SHOW statement_timeout")
        assert cursor.fetchone()[0] == "0"


@pytest.mark.django_db
def test_a_chunk_read_that_overruns_its_timeout_degrades_to_503(
    api_client, mocker, caplog
):
    if connection.vendor != "postgresql":
        pytest.skip("statement_timeout is only set on PostgreSQL")

    cache.clear()
    caplog.set_level(logging.INFO, logger="dj.apps.g12f.views.sitemap")
    mocker.patch(
        "dj.apps.g12f.views.sitemap._CHUNK_STATEMENT_TIMEOUT_MS", 100
    )

    def stall(kind, page):
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_sleep(5)")
        raise AssertionError("pg_sleep should have been cancelled")

    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk", side_effect=stall
    )

    response = api_client.get(_chunk_path("creators", 0, 1))

    assert response.status_code == 503
    assert response["Cache-Control"] == "no-store"
    assert response["Retry-After"] == "30"
    assert response["X-Sitemap-Protocol"] == "2"
    payload = _sitemap_log_payloads(caplog)[-1]
    assert payload["outcome"] == "database_error"
    assert payload["error_kind"] == "statement_timeout"
    assert payload["error_category"] == "statement_timeout"
    assert payload["operation"] == "chunk_read"
    assert payload["sqlstate"] == "57014"
    assert len(payload["error_fingerprint"]) == 16
    sitemap_records = [
        record
        for record in caplog.records
        if record.name == "dj.apps.g12f.views.sitemap"
    ]
    assert sitemap_records[-1].exc_info is None
    cache.clear()


@pytest.mark.django_db
def test_a_non_transient_database_error_is_not_hidden_behind_a_503(
    api_client, mocker
):
    """A bad rollout must keep producing a traceback, not a generic 503."""
    if connection.vendor != "postgresql":
        pytest.skip("advisory lanes are only exercised on PostgreSQL")

    cache.clear()
    mocker.patch(
        "dj.apps.g12f.views.sitemap.build_sitemap_chunk",
        side_effect=ProgrammingError('relation "g12f_creator" does not exist'),
    )

    with pytest.raises(ProgrammingError):
        api_client.get(_chunk_path("creators", 0, 1))

    # And the lane must not leak: the next request has to be able to take it.
    with _held_lane(_chunk_lock_id("creators", 0)):
        pass
    cache.clear()


# --- the `tags` kind  ------------------------------------------------


def _tagged(creator, tag, count):
    for _ in range(count):
        _page(creator).tags.add(tag)


@pytest.mark.django_db
def test_only_tags_that_clear_the_quality_gate_reach_the_sitemap(
    api_client, creator_factory
):
    """The gate and the hub's `indexable` flag are ONE constant.

    A URL that is submitted and then renders `noindex` is reported forever in
    Search Console as submitted-but-excluded, so the sitemap must not be able
    to disagree with the page. Drop `TAG_HUB_INDEX_MIN_PAGES` to 1 and the
    `thin` assertion below fails.
    """
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-tag-author")
    # LITERAL counts, deliberately. Deriving them from the constant under test
    # makes the fixture move with the gate, and the test can then never fail.
    _tagged(creator, "zcash", 3)
    _tagged(creator, "thin", 2)

    slugs = _sitemap_tag_slugs(api_client)

    assert "zcash" in slugs
    assert "thin" not in slugs


@pytest.mark.django_db
def test_sitemap_emits_one_canonical_slug_for_live_aliases(
    api_client, creator_factory
):
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-tag-alias")
    _tagged(creator, "straße", 3)
    _tagged(creator, "STRASSE", 3)
    canonical = Tag.objects.get(name="straße")
    TagAlias.objects.create(name="STRASSE", canonical=canonical)

    assert _sitemap_tag_slugs(api_client) == ["straße"]


@pytest.mark.django_db
def test_conflicting_historical_aliases_do_not_abort_the_sitemap_index(
    api_client, creator_factory
):
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-tag-conflict")
    _tagged(creator, "conflict-alpha", 3)
    _tagged(creator, "conflict-beta", 3)
    _tagged(creator, "unrelated-topic", 3)
    first = Tag.objects.get(name="conflict-alpha")
    second = Tag.objects.get(name="conflict-beta")
    TagAlias.objects.create(name="conflict spelling", canonical=first)
    TagAlias.objects.create(name="CONFLICT SPELLING", canonical=second)

    index = api_client.get("/api/sitemap/")

    assert index.status_code == 200, index.data
    assert index.data["creators"]
    assert index.data["zpages"]
    assert _sitemap_tag_slugs(api_client) == ["unrelated-topic"]


@pytest.mark.django_db
def test_sitemap_index_and_chunk_share_slug_collision_representatives(
    api_client, creator_factory
):
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-tag-collision")
    _tagged(creator, "Foo Bar", 3)
    _tagged(creator, "foo-bar", 3)

    index = api_client.get("/api/sitemap/")

    assert index.status_code == 200, index.data
    assert len(index.data["tags"]) == 1
    entry = index.data["tags"][0]
    assert entry["count"] == 1
    chunk = api_client.get(_chunk_path("tags", entry["page"], entry["count"]))
    assert chunk.status_code == 200, chunk.data
    assert chunk.data["tags"] == [{"slug": "foo-bar"}]


@pytest.mark.django_db
def test_sitemap_collision_representative_is_global_across_pk_chunks(
    api_client, creator_factory
):
    """A later chunk must not re-publish a slug represented by an earlier one."""
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-cross-chunk")
    root = Tag.objects.create(name="Cross Chunk")
    for _ in range(3):
        _page(creator).tags.add(root)

    Tag.objects.bulk_create([
        Tag(
            name=f"cross-chunk filler {index}",
            slug=f"cross-chunk-filler-{index}",
        )
        for index in range(SITEMAP_CHUNK_SIZE + 1)
    ])
    variant = Tag.objects.create(
        name="cross-chunk", slug="cross-chunk-variant"
    )
    for _ in range(3):
        _page(creator).tags.add(variant)

    root_page = _page_number(root)
    variant_page = _page_number(variant)
    assert root_page != variant_page

    index = api_client.get("/api/sitemap/")
    assert index.status_code == 200, index.data
    entry = next(item for item in index.data["tags"] if item["page"] == root_page)
    assert entry["count"] == 1
    root_chunk = api_client.get(
        _chunk_path("tags", root_page, entry["count"])
    )
    assert root_chunk.status_code == 200, root_chunk.data
    assert root_chunk.data["tags"] == [{"slug": "cross-chunk"}]

    # The representative set is global, so the later PK range is empty even
    # though it contains a live tag with the same public slug.
    assert build_sitemap_chunk("tags", variant_page) is None


@pytest.mark.django_db
def test_oversized_alias_component_does_not_abort_unrelated_sitemap(
    creator_factory, monkeypatch
):
    creator = creator_factory()
    _tagged(creator, "oversized-sitemap-root", 3)
    _tagged(creator, "healthy-sitemap-topic", 3)
    root = Tag.objects.get(name="oversized-sitemap-root")
    TagAlias.objects.create(name="oversized alias one", canonical=root)
    TagAlias.objects.create(name="oversized alias two", canonical=root)

    import dj.apps.tagging.slugs as slugs

    monkeypatch.setattr(slugs, "TAG_HUB_MAX_COMPONENT_ALIASES", 1)

    assert list(_tag_queryset().values_list("name", flat=True)) == [
        "healthy-sitemap-topic"
    ]


@pytest.mark.django_db
def test_sitemap_serializes_root_slug_when_only_alias_clears_gate(
    api_client, creator_factory
):
    """A qualifying alias must not publish the below-gate root's name."""
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-root-below-gate")
    _tagged(creator, "canonical-root", 1)
    _tagged(creator, "published-alias", 3)
    root = Tag.objects.get(name="canonical-root")
    TagAlias.objects.create(name="published-alias", canonical=root)

    assert _sitemap_tag_slugs(api_client) == ["canonical-root"]

    index = api_client.get("/api/sitemap/")
    entry = index.data["tags"][0]
    chunk = api_client.get(_chunk_path("tags", entry["page"], entry["count"]))
    assert chunk.status_code == 200, chunk.data
    assert chunk.data["tags"] == [{"slug": "canonical-root"}]
    assert entry["revision"] == make_sitemap_revision(
        "tags", entry["page"], entry["count"]
    )


@pytest.mark.django_db
def test_a_deactivated_creators_pages_do_not_keep_a_tag_in_the_sitemap(
    api_client, creator_factory
):
    """'s actual failure, one layer up.

    A takedown that leaves the topic hub enumerated goes on handing Google the
    list of pages to fetch. The tag has to fall below the gate exactly as the
    hub does.
    """
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-tag-banned")
    _tagged(creator, "banned-topic", 5)
    assert "banned-topic" in _sitemap_tag_slugs(api_client)

    creator.is_active = False
    creator.save(update_fields=["is_active"])
    cache.clear()

    assert "banned-topic" not in _sitemap_tag_slugs(api_client)


@pytest.mark.django_db
def test_a_tag_with_no_slug_never_reaches_the_sitemap(
    api_client, creator_factory
):
    """An emoji-only tag has no `/tag/` URL at all.

    The exclusion has to happen in SQL: the index COUNTS rows and the chunk
    RENDERS them, so a row dropped in Python would leave that child answering
    409 forever rather than merely omitting a URL.
    """
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-tag-emoji")
    _tagged(creator, "\U0001f525", 4)
    _tagged(creator, "privacy", 3)

    slugs = _sitemap_tag_slugs(api_client)

    assert slugs == ["privacy"]
    assert "" not in slugs


@pytest.mark.django_db
def test_every_tag_row_the_index_counted_is_rendered_by_the_chunk(
    api_client, creator_factory
):
    """The invariant a 409 would break, asserted directly."""
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-tag-count")
    for name in ("alpha", "beta", "\U0001f525", "gamma!!"):
        _tagged(creator, name, 3)

    index = api_client.get("/api/sitemap/")
    assert index.status_code == 200, index.data
    for entry in index.data["tags"]:
        chunk = api_client.get(
            _chunk_path("tags", entry["page"], entry["count"])
        )
        assert chunk.status_code == 200, chunk.data
        assert len(chunk.data["tags"]) == entry["count"]
        assert all(row["slug"] for row in chunk.data["tags"])


def _sitemap_tag_slugs(api_client):
    index = api_client.get("/api/sitemap/")
    assert index.status_code == 200, index.data
    slugs = []
    for entry in index.data["tags"]:
        chunk = api_client.get(
            _chunk_path("tags", entry["page"], entry["count"])
        )
        assert chunk.status_code == 200, chunk.data
        slugs.extend(row["slug"] for row in chunk.data["tags"])
    return sorted(slugs)


@pytest.mark.django_db
def test_every_sitemapped_tag_is_indexable_on_its_hub(
    api_client, creator_factory
):
    """The invariant, asserted directly rather than inferred from two rules.

    The sitemap gates per stored tag and the hub gates per slug, over the union
    of colliding spellings — so the two can disagree, and the codex adversarial
    review found it. The disagreement is one-directional and this is what pins
    that: a submitted URL must never answer `noindex`. (The converse, an
    indexable hub the sitemap omits, is a discovery cost and is documented in
    `sitemap_tag_queryset`.)
    """
    cache.clear()
    creator = _listed_creator(creator_factory, "sitemap-tag-invariant")
    _tagged(creator, "zcash", 4)
    _tagged(creator, "thin", 2)
    # The collision that produces the documented gap: three pages, three
    # spellings, one slug.
    _tagged(creator, "t-shirts", 1)
    _tagged(creator, "t shirts", 1)
    _tagged(creator, "T/Shirts", 1)

    for slug in _sitemap_tag_slugs(api_client):
        hub = api_client.get(f"/api/tagging/hub/{slug}")
        assert hub.status_code == 200, (slug, hub.content)
        assert hub.json()["indexable"] is True, (
            f"/tag/{slug} is in the sitemap but renders noindex"
        )


@pytest.mark.django_db
def test_sitemap_tag_canonicalization_is_bulk_and_regex_free(creator_factory):
    """Many candidate tags stay a fixed-query bulk operation."""
    creator = creator_factory()
    for index in range(60):
        _tagged(creator, f"bulk sitemap topic {index}", 3)

    with CaptureQueriesContext(connection) as captured:
        rows = list(_tag_queryset().values_list("name", flat=True))

    assert len(rows) == 60
    assert len(captured.captured_queries) <= 5, [
        query["sql"] for query in captured.captured_queries
    ]
    assert not any(
        "iregex" in query["sql"].lower()
        or " ~* " in query["sql"].lower()
        for query in captured.captured_queries
    )
