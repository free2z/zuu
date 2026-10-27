"""The Python half of the cross-runtime tag-slug contract.

``ts/svelte/free2z/tests/tag-slug.test.mjs`` asserts the same golden table
against ``slugifyTag()``. A slug is computed in the browser (every tag chip's
href) and resolved in Django (the URL that href points at), so the only defect
that matters here is a disagreement between the two -- and no single-runtime
test can see it.
"""

import json
import pathlib

import pytest
from django.db import connection
from django.db.models.signals import post_save
from django.test.utils import CaptureQueriesContext

from taggit.models import Tag

from dj.apps.g12f.models import zPage
from dj.apps.tagging.models import TagAlias, TagIdentity
from dj.apps.tagging.slugs import (
    TAG_SLUG_MAX_LENGTH,
    TAG_HUB_MAX_ALIAS_ROWS,
    _alias_component,
    TagGraphTooLarge,
    _hub_aliases,
    canonical_slug_for_alias,
    is_canonical_slug,
    slugify_tag,
    tag_key,
    tags_for_hub_slug,
    tags_for_slug,
)


GOLDEN = json.loads(
    (
        pathlib.Path(__file__).parent / "testdata" / "tag_slug_parity.json"
    ).read_text(encoding="utf-8")
)


def _page(creator, tags, *, published=True, vanity=None):
    import uuid

    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=vanity or f"tag-slug-{uuid.uuid4()}",
        title="Tag slug fixture",
        content="Fixture content",
        is_published=published,
    )
    page.tags.add(*tags)
    return page


def test_every_golden_case_matches():
    assert len(GOLDEN["cases"]) >= 25
    for case in GOLDEN["cases"]:
        assert slugify_tag(case["name"]) == case["slug"], case["why"]


def test_the_golden_bound_is_the_bound_this_module_enforces():
    assert GOLDEN["max_length"] == TAG_SLUG_MAX_LENGTH


def test_slugifying_is_idempotent():
    """What makes the slug a canonical form, and what `is_canonical_slug`
    leans on to be the single spelling of "could we have emitted this?"."""
    for case in GOLDEN["cases"]:
        once = slugify_tag(case["name"])
        assert slugify_tag(once) == once


@pytest.mark.parametrize(
    "hostile",
    [
        "..",
        "../..",
        "../../etc/passwd",
        "....//",
        "%2e%2e",
        "/",
        "\\",
        "\x00",
    ],
)
def test_path_traversal_is_neutralised_by_the_rule_not_by_a_blocklist(hostile):
    slug = slugify_tag(hostile)
    assert ".." not in slug
    assert "/" not in slug
    assert "\\" not in slug
    assert "\x00" not in slug


@pytest.mark.parametrize(
    "value,expected",
    [
        ("zcash", True),
        ("t-shirts", True),
        ("日本語", True),
        ("café", True),
        ("a" * TAG_SLUG_MAX_LENGTH, True),
        ("", False),
        ("Zcash", False),
        ("a--b", False),
        ("-zcash", False),
        ("zcash-", False),
        ("..", False),
        ("t shirts", False),
        ("a" * (TAG_SLUG_MAX_LENGTH + 1), False),
    ],
)
def test_is_canonical_slug_accepts_only_what_slugify_emits(value, expected):
    assert is_canonical_slug(value) is expected


@pytest.mark.django_db
def test_a_slug_resolves_to_its_tag(creator_factory):
    creator = creator_factory()
    _page(creator, ["zcash"])
    assert [tag.name for tag in tags_for_slug("zcash")] == ["zcash"]


@pytest.mark.django_db
def test_case_and_separator_variants_all_resolve_to_the_same_slug(
    creator_factory,
):
    """The documented collision behaviour.

    `t-shirts`, `t shirts` and `T/Shirts` are three DISTINCT taggit rows that
    slug to one URL. Two tags on one URL would be a correctness bug if the hub
    silently picked one; instead every one of them is returned and the hub
    browses their union, so no tag is orphaned.
    """
    creator = creator_factory()
    _page(creator, ["t-shirts"])
    _page(creator, ["t shirts"])
    _page(creator, ["T/Shirts"])

    resolved = sorted(tag.name for tag in tags_for_slug("t-shirts"))
    assert resolved == ["T/Shirts", "t shirts", "t-shirts"]


@pytest.mark.django_db
def test_a_non_canonical_slug_resolves_to_nothing(creator_factory):
    """No database work at all for a URL this platform never emits."""
    creator = creator_factory()
    _page(creator, ["zcash"])

    assert tags_for_slug("Zcash") == []
    assert tags_for_slug("..") == []
    assert tags_for_slug("z--cash") == []
    assert tags_for_slug("") == []


@pytest.mark.django_db
def test_slug_reads_keep_bulk_created_and_updated_tags_read_only(creator_factory):
    """The source Tag row remains authoritative when signals did not run."""
    creator_factory()
    Tag.objects.bulk_create([Tag(name="bulk-source-tag")])
    tag = Tag.objects.get(name="bulk-source-tag")
    assert TagIdentity.objects.filter(tag=tag).exists() is False
    assert [row.pk for row in tags_for_slug("bulk-source-tag")] == [tag.pk]
    assert TagIdentity.objects.filter(tag=tag).exists() is False

    Tag.objects.filter(pk=tag.pk).update(name="bulk-renamed-tag")
    assert tags_for_slug("bulk-source-tag") == []
    assert [row.pk for row in tags_for_slug("bulk-renamed-tag")] == [tag.pk]
    assert TagIdentity.objects.filter(tag=tag).exists() is False


@pytest.mark.django_db
def test_raw_tag_fixture_cannot_overwrite_a_fresh_identity(creator_factory):
    creator_factory()
    tag = Tag.objects.create(name="raw-tag")
    identity = TagIdentity.objects.get(tag=tag)
    # Reproduce loaddata's real shape: the in-memory fixture object may carry
    # a newer name than the already-persisted projection when post_save is
    # dispatched with raw=True. The guard is vacuous if both values derive to
    # the same slug.
    tag.name = "loaddata stale name"
    post_save.send(sender=Tag, instance=tag, raw=True, created=False)
    identity.refresh_from_db()
    assert identity.slug == "raw-tag"


@pytest.mark.django_db
def test_alias_component_uses_derived_source_key_when_projection_is_stale(
    creator_factory,
):
    creator_factory()
    source = Tag.objects.create(name="stale source name")
    target = Tag.objects.create(name="stale target")
    alias = TagAlias.objects.bulk_create([
        TagAlias(
            name=source.name,
            name_key="unrelated-stored-key",
            canonical=target,
        )
    ])[0]

    assert [row.pk for row in _alias_component([source])] == [alias.pk]


@pytest.mark.django_db
def test_empty_alias_slug_is_resolved_from_its_source_name(creator_factory):
    creator_factory()
    canonical = Tag.objects.create(name="alias-root")
    alias = TagAlias.objects.bulk_create([
        TagAlias(
            name="Legacy Alias",
            name_key=tag_key("Legacy Alias"),
            slug="",
            canonical=canonical,
        )
    ])[0]
    assert canonical_slug_for_alias("legacy-alias") == "alias-root"
    alias.refresh_from_db()
    # A read repairs the tag projection; it does not trust the empty slug.
    assert alias.slug == ""
    TagAlias.objects.filter(pk=alias.pk).update(slug="wrong-slug")
    assert canonical_slug_for_alias("legacy-alias") == "alias-root"


@pytest.mark.django_db
def test_deleted_source_tag_cannot_survive_as_a_projected_hub(creator_factory):
    creator_factory()
    tag = Tag.objects.create(name="deleted-source-tag")
    assert [row.pk for row in tags_for_slug("deleted-source-tag")] == [tag.pk]
    tag.delete()
    assert tags_for_slug("deleted-source-tag") == []


@pytest.mark.django_db
def test_alias_component_fails_closed_past_its_query_bound(creator_factory, monkeypatch):
    creator_factory()
    root = Tag.objects.create(name="bounded-graph-root")
    TagAlias.objects.bulk_create([
        TagAlias(
            name=f"bounded graph alias {index}",
            name_key=tag_key(f"bounded graph alias {index}"),
            canonical=root,
        )
        for index in range(4)
    ])
    import dj.apps.tagging.slugs as slugs

    monkeypatch.setattr(slugs, "TAG_HUB_MAX_COMPONENT_ALIASES", 2)
    with pytest.raises(TagGraphTooLarge):
        tags_for_hub_slug("bounded-graph-root")


@pytest.mark.django_db
def test_an_underscore_tag_is_reachable_by_its_slug(creator_factory):
    """The case the `iexact` half of the lookup cannot find on its own: the
    slug is `hello-world` and no tag is named that, nor `hello world`."""
    creator = creator_factory()
    _page(creator, ["hello_world"])
    assert [tag.name for tag in tags_for_slug("hello-world")] == ["hello_world"]


@pytest.mark.django_db
def test_the_longest_storable_tag_name_round_trips(creator_factory):
    """The bug the codex adversarial review found, pinned in both directions.

    `slugify_tag` truncates but `tags_for_slug` matches an ANCHORED regex, so
    a slug shorter than its own name can never find it: every tag chip points
    at a 404 and `sitemap_tag_queryset` — which truncates nothing — publishes
    that broken URL. TAG_SLUG_MAX_LENGTH now sits above the longest slug any
    storable tag can produce, which is what makes this pass.

    `taggit.models.Tag.name` is `max_length=100`, so this is the worst case the
    database can hold. Two shapes, because the failure needs a multi-segment
    name to reach the regex path at all.
    """
    creator = creator_factory()
    single = "z" * 100
    multi = (("segment " * 13).strip() + " tail")[:100].strip()
    assert len(multi) <= 100 and " " in multi
    _page(creator, [single])
    _page(creator, [multi])

    assert [tag.name for tag in tags_for_slug(slugify_tag(single))] == [single]
    assert [tag.name for tag in tags_for_slug(slugify_tag(multi))] == [multi]
    # And the slug really is the whole name, not a prefix of it.
    assert len(slugify_tag(single)) == 100


@pytest.mark.django_db
def test_a_single_segment_slug_does_not_scan_the_tag_table(creator_factory):
    """`^abc$` under `~*` selects exactly what `name__iexact='abc'` selects.

    Running it anyway costs a sequential scan of `taggit_tag` on an
    anonymously reachable, deliberately unthrottled endpoint — the cheapest
    abuse shape being a flood of random single-token slugs. Asserted on the
    query builder rather than on a plan, because a plan assertion over a
    fixture table proves nothing.
    """
    from dj.apps.tagging.slugs import _candidate_regex

    assert _candidate_regex("zcash") is None
    assert _candidate_regex("t-shirts") == "^t[^[:alnum:]]+shirts$"

    # And the exact lookup still works with the regex branch absent.
    creator = creator_factory()
    _page(creator, ["zcash"])
    assert [tag.name for tag in tags_for_slug("zcash")] == ["zcash"]


@pytest.mark.django_db
def test_an_exact_match_survives_a_crowded_candidate_list(creator_factory):
    """The cap orders by pk, so an ORed query could cut the exact match off.

    Every `x-N` below slugs to a different slug, but they all MATCH the regex
    for `x-1`? No — they do not, and that is why this fixture instead crowds
    the table with rows that DO match `^x[^[:alnum:]]+1$` case-insensitively
    only through the exact arm. What it really pins is that the exact-name tag
    is returned even when it was created last, i.e. has the highest pk.
    """
    creator = creator_factory()
    for index in range(60):
        _page(creator, [f"filler {index}"])
    _page(creator, ["x-1"])

    assert [tag.name for tag in tags_for_slug("x-1")] == ["x-1"]


@pytest.mark.django_db
def test_a_true_spelling_after_regex_false_positives_is_not_dropped():
    """The candidate ceiling is a fast path, never a correctness boundary."""
    import unicodedata

    marks = [
        chr(codepoint) for codepoint in range(0x300, 0x370)
        if unicodedata.category(chr(codepoint)) in {"Mn", "Mc"}
    ]
    false_positives = [f"alpha{mark}-beta" for mark in marks]
    assert len(false_positives) > 50
    Tag.objects.bulk_create([
        Tag(name=name, slug=f"false-positive-{index}")
        for index, name in enumerate(false_positives)
    ])
    true_spelling = Tag.objects.create(name="alpha-beta")

    assert [tag.pk for tag in tags_for_slug("alpha-beta")] == [
        true_spelling.pk
    ]


@pytest.mark.django_db
def test_live_hub_alias_discovery_is_hard_bounded(creator_factory):
    creator = creator_factory()
    _page(creator, ["bounded-root"])
    canonical = Tag.objects.get(name="bounded-root")
    TagAlias.objects.bulk_create([
        TagAlias(
            name=f"bounded alias {index}",
            name_key=tag_key(f"bounded alias {index}"),
            canonical=canonical,
        )
        for index in range(TAG_HUB_MAX_ALIAS_ROWS + 25)
    ])

    with CaptureQueriesContext(connection) as captured:
        aliases = _hub_aliases([canonical])
    assert len(aliases) == TAG_HUB_MAX_ALIAS_ROWS
    assert any(
        f"LIMIT {TAG_HUB_MAX_ALIAS_ROWS}" in query["sql"]
        for query in captured.captured_queries
    )
    canonical_slug, tags = tags_for_hub_slug("bounded-root")
    assert canonical_slug == "bounded-root"
    assert [tag.name for tag in tags] == ["bounded-root"]


@pytest.mark.django_db
def test_live_alias_after_display_cap_converges_with_bounded_queries(
    creator_factory,
):
    creator = creator_factory()
    _page(creator, ["cap-root"], vanity="cap-root-page")
    requested = "requested live alias"
    _page(creator, [requested], vanity="requested-live-alias")
    canonical = Tag.objects.get(name="cap-root")

    rows = [
        TagAlias(
            name=f"historical alias {index}",
            name_key=tag_key(f"historical alias {index}"),
            slug=slugify_tag(f"historical alias {index}"),
            canonical=canonical,
        )
        for index in range(TAG_HUB_MAX_ALIAS_ROWS + 1)
    ]
    rows.append(
        TagAlias(
            name=requested,
            name_key=tag_key(requested),
            slug=slugify_tag(requested),
            canonical=canonical,
        )
    )
    TagAlias.objects.bulk_create(rows)

    with CaptureQueriesContext(connection) as captured:
        canonical_slug, tags = tags_for_hub_slug(slugify_tag(requested))

    assert canonical_slug == "cap-root"
    assert {tag.name for tag in tags} >= {"cap-root", requested}
    # The authoritative source verification for a multi-segment slug is one
    # bounded read in addition to the projection/identity reads. Keep this
    # budget honest: stale projections must not be made correct by dropping
    # that source check.
    assert len(captured.captured_queries) <= 9, [
        query["sql"] for query in captured.captured_queries
    ]


@pytest.mark.django_db
def test_alias_component_fails_closed_past_query_budget(
    creator_factory, monkeypatch
):
    creator = creator_factory()
    _page(creator, ["budget-root"])
    root = Tag.objects.get(name="budget-root")
    middle = Tag.objects.create(name="budget-middle")
    final = Tag.objects.create(name="budget-final")
    TagAlias.objects.create(name=root.name, canonical=middle)
    TagAlias.objects.create(name=middle.name, canonical=final)

    import dj.apps.tagging.slugs as slugs

    monkeypatch.setattr(slugs, "TAG_HUB_MAX_COMPONENT_QUERIES", 1)
    with pytest.raises(TagGraphTooLarge):
        tags_for_hub_slug("budget-root")


@pytest.mark.django_db
def test_an_alias_slug_reports_the_canonical_one(creator_factory):
    """ records a merged spelling rather than destroying it, so the old
    URL is still a URL Google holds. It must 301, not 404 and not serve a
    duplicate of the canonical hub."""
    creator = creator_factory()
    _page(creator, ["zcash"])
    canonical = Tag.objects.get(name="zcash")
    TagAlias.objects.create(
        name="ZCASh money", canonical=canonical, source="human"
    )

    assert canonical_slug_for_alias("zcash-money") == "zcash"
    # A slug that IS a live tag keeps its own hub -- the alias path is only
    # consulted when the direct lookup found nothing.
    assert canonical_slug_for_alias("zcash") is None
