"""`GET /api/tagging/hub/{slug}` and the `?any_tags=` filter behind it.

The load-bearing cases, and why each one is here rather than being obvious:

* **A deactivated creator's pages do not count and do not appear.**  found
  seven of eight zPage read paths remembering ``is_published`` and forgetting
  ``creator__is_active``;  closed the last of them. A brand-new read path
  is exactly where that gets forgotten again, and the symptom is silent: a
  banned account's article keeps ranking under its topic hub while its profile
  404s. When a deactivation empties a tag entirely the hub must 404 -- look
  identical to a tag that never existed -- not render an empty indexable page.
* **The slug collision resolves to a union, not to a winner.** Two tags on one
  URL is a correctness question, and the answer is written down here.
* **The quality gate has a negative control.** Below the threshold the hub
  still renders but is not indexable.
"""

import uuid
from urllib.parse import urlencode

import pytest

from taggit.models import Tag

from dj.apps.g12f.models import zPage
from dj.apps.tagging.models import TagAlias


def _page(creator, tags, *, published=True, title="Tag hub fixture"):
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"tag-hub-{uuid.uuid4()}",
        title=title,
        content="Fixture content",
        is_published=published,
    )
    page.tags.add(*tags)
    return page


def _deactivate(creator):
    """Flip `is_active` alone.

    Deliberately NOT `ban_and_soft_delete()`: that method also sweeps
    `Bannable` relations, and zPage is not one of them, so using it here would
    let a test pass for the wrong reason. The operator action this models is
    unticking one checkbox in the admin.
    """
    creator.is_active = False
    creator.save(update_fields=["is_active"])


@pytest.mark.django_db
def test_a_populated_tag_resolves(api_client, creator_factory):
    creator = creator_factory()
    for _ in range(3):
        _page(creator, ["zcash"])

    response = api_client.get("/api/tagging/hub/zcash")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["slug"] == "zcash"
    assert body["name"] == "zcash"
    assert body["names"] == ["zcash"]
    assert body["count"] == 3
    assert body["indexable"] is True


@pytest.mark.django_db
def test_a_hub_with_a_production_sized_tag_corpus_still_resolves(
    api_client, creator_factory
):
    """Unrelated tags must not trip the hub resolver's safety valve."""
    creator = creator_factory()
    for _ in range(3):
        _page(creator, ["large-corpus-root"])
    root = Tag.objects.get(name="large-corpus-root")
    TagAlias.objects.create(name="large corpus alias", canonical=root)
    Tag.objects.bulk_create([
        Tag(
            name=f"unrelated filler {index}",
            slug=f"unrelated-filler-{index}",
        )
        for index in range(10_001)
    ])

    response = api_client.get("/api/tagging/hub/large-corpus-root")

    assert response.status_code == 200, response.content
    assert response.json()["count"] == 3


@pytest.mark.django_db
@pytest.mark.parametrize("imported_name", ["t shirts", "t.shirts"])
def test_a_missing_identity_cannot_hide_a_colliding_live_tag(
    api_client, creator_factory, imported_name
):
    """A bulk-created spelling still joins a projected spelling's hub."""
    creator = creator_factory()
    projected = Tag.objects.create(name="T/Shirts")
    for _ in range(3):
        _page(creator, [projected])
    imported = Tag.objects.bulk_create([Tag(name=imported_name)])[0]
    assert not hasattr(imported, "tag_identity")
    for _ in range(3):
        _page(creator, [imported])

    response = api_client.get("/api/tagging/hub/t-shirts")

    assert response.status_code == 200, response.content
    assert set(response.json()["names"]) == {"T/Shirts", imported_name}
    assert response.json()["count"] == 6


@pytest.mark.django_db
def test_an_unrelated_alias_corpus_does_not_break_tag_filters(
    api_client, creator_factory
):
    """A no-alias term keeps the one indexed miss fast and successful."""
    creator = creator_factory()
    _page(creator, ["zcash"])
    canonical = Tag.objects.get(name="zcash")
    TagAlias.objects.bulk_create([
        TagAlias(
            name=f"unrelated alias {index}",
            name_key=f"unrelated alias {index}",
            canonical=canonical,
        )
        for index in range(5_100)
    ])

    response = api_client.get("/api/zpage/", {"tags": "zcash"})

    assert response.status_code == 200, response.content
    assert response.json()["count"] == 1


@pytest.mark.django_db
def test_a_tag_below_the_gate_renders_but_is_not_indexable(
    api_client, creator_factory
):
    """The negative control for the quality gate.

    LITERAL page counts, not `TAG_HUB_INDEX_MIN_PAGES - 1`. A fixture derived
    from the constant under test moves with it and can never fail -- the exact
    "test that passes without testing" shape AGENTS.md warns about, and the
    first draft of this test had it. With literals, moving the gate DOWN makes
    the two-page hub indexable and moving it UP makes the three-page hub
    unindexable, so either direction goes red.
    """
    creator = creator_factory()
    for _ in range(2):
        _page(creator, ["obscure"])
    for _ in range(3):
        _page(creator, ["popular"])

    thin = api_client.get("/api/tagging/hub/obscure")
    assert thin.status_code == 200, thin.content
    assert thin.json()["count"] == 2
    assert thin.json()["indexable"] is False, "the gate is not holding"

    fat = api_client.get("/api/tagging/hub/popular")
    assert fat.status_code == 200, fat.content
    assert fat.json()["count"] == 3
    assert fat.json()["indexable"] is True, "the gate is set too high"


@pytest.mark.django_db
def test_an_unknown_slug_is_404(api_client, creator_factory):
    creator_factory()
    assert api_client.get("/api/tagging/hub/nobody-uses-this").status_code == 404


@pytest.mark.django_db
def test_a_draft_only_tag_is_404(api_client, creator_factory):
    creator = creator_factory()
    _page(creator, ["secret"], published=False)
    assert api_client.get("/api/tagging/hub/secret").status_code == 404


@pytest.mark.django_db
def test_a_non_canonical_slug_is_404(api_client, creator_factory):
    creator = creator_factory()
    _page(creator, ["zcash"])
    for hostile in ("Zcash", "z--cash", "-zcash", "%2e%2e"):
        assert api_client.get(
            f"/api/tagging/hub/{hostile}"
        ).status_code == 404, hostile


@pytest.mark.django_db
def test_a_deactivated_creators_pages_do_not_count(api_client, creator_factory):
    """, on a read path that did not exist when it was written."""
    live = creator_factory()
    banned = creator_factory()
    _page(live, ["shared-topic"])
    for _ in range(5):
        _page(banned, ["shared-topic"])

    before = api_client.get("/api/tagging/hub/shared-topic").json()
    assert before["count"] == 6
    assert before["indexable"] is True

    _deactivate(banned)

    after = api_client.get("/api/tagging/hub/shared-topic").json()
    assert after["count"] == 1, "a banned account's pages are still counted"
    assert after["indexable"] is False


@pytest.mark.django_db
def test_a_tag_only_a_deactivated_creator_used_is_404(
    api_client, creator_factory
):
    """The whole tag goes away, not just its rows.

    404 rather than an empty 200: a takedown must make the URL look exactly
    like a tag that never existed, and an indexable page with nothing on it is
    a soft-404 that costs sitewide quality regardless.
    """
    banned = creator_factory()
    for _ in range(4):
        _page(banned, ["banned-topic"])

    assert api_client.get("/api/tagging/hub/banned-topic").status_code == 200

    _deactivate(banned)

    assert api_client.get("/api/tagging/hub/banned-topic").status_code == 404


@pytest.mark.django_db
def test_colliding_spellings_browse_together(api_client, creator_factory):
    """Two distinct tags, one URL. Documented, and this is the documentation.

    The display name is the spelling the most pages actually carry, and
    `count` counts PAGES, not tag rows -- a page carrying two of the colliding
    spellings is one page.
    """
    creator = creator_factory()
    for _ in range(3):
        _page(creator, ["t-shirts"])
    _page(creator, ["t shirts"])
    both = _page(creator, ["t-shirts", "T/Shirts"])
    assert both.pk

    response = api_client.get("/api/tagging/hub/t-shirts")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["name"] == "t-shirts", "the most-used spelling leads"
    assert sorted(body["names"]) == ["T/Shirts", "t shirts", "t-shirts"]
    # 3 + 1 + 1 pages. Summing per-tag usage would say 6.
    assert body["count"] == 5


@pytest.mark.django_db
def test_hub_slug_filter_keeps_pages_after_the_bounded_name_list(
    api_client, creator_factory
):
    creator = creator_factory()
    separators = list("!@#$%^&*()_+=[]{}|;:',.<>?/~`")
    assert len(separators) > 20
    for index in range(51):
        separator = separators[index % len(separators)]
        name = f"crowded{separator}{index} topic"
        # Every name needs the same public slug but must remain a distinct row.
        name = name.replace(str(index), "")
        _page(creator, [name], title=f"crowded page {index}")

    # The punctuation variants collapse to one slug; add distinct whitespace
    # variants to make the fixture exceed the response's 50-name budget.
    for index in range(51):
        name = "crowded" + (" " * (index + 1)) + "topic"
        _page(creator, [name], title=f"crowded whitespace {index}")

    response = api_client.get("/api/tagging/hub/crowded-topic")
    assert response.status_code == 200, response.content
    body = response.json()
    assert len(body["names"]) == 50
    # Every punctuation and whitespace spelling is a distinct Tag row even
    # though all 102 rows share one public slug.
    expected_count = 51 + 51
    assert body["count"] == expected_count
    _page(creator, ["outside-crowded-hub"], title="outside hub")

    listed = api_client.get("/api/zpage/?hub_slug=crowded-topic")
    assert listed.status_code == 200, listed.content
    assert listed.json()["count"] == expected_count
    assert len(listed.json()["results"]) == 12


@pytest.mark.django_db
def test_an_alias_slug_reports_the_canonical_slug(api_client, creator_factory):
    creator = creator_factory()
    for _ in range(3):
        _page(creator, ["zcash"])
    TagAlias.objects.create(
        name="ZCASh money",
        canonical=Tag.objects.get(name="zcash"),
        source="human",
    )

    response = api_client.get("/api/tagging/hub/zcash-money")

    assert response.status_code == 200, response.content
    # A DIFFERENT slug than the one requested is the caller's cue to 301.
    assert response.json()["slug"] == "zcash"


@pytest.mark.django_db
def test_bulk_alias_with_missing_projection_still_redirects_safely(
    api_client, creator_factory
):
    creator = creator_factory()
    for _ in range(3):
        _page(creator, ["projection-root"])
    canonical = Tag.objects.get(name="projection-root")
    TagAlias.objects.bulk_create([
        TagAlias(
            name="Projection Alias",
            name_key="",
            slug="",
            canonical=canonical,
        )
    ])

    response = api_client.get("/api/tagging/hub/projection-alias")

    assert response.status_code == 200, response.content
    assert response.json()["slug"] == "projection-root"


@pytest.mark.django_db
def test_oversized_historical_alias_component_stays_a_404(
    api_client, creator_factory, monkeypatch
):
    creator = creator_factory()
    _page(creator, ["redirect-root"], title="root")
    root = Tag.objects.get(name="redirect-root")
    TagAlias.objects.create(name="oversized redirect one", canonical=root)
    TagAlias.objects.create(name="oversized redirect two", canonical=root)

    import dj.apps.tagging.slugs as slugs

    monkeypatch.setattr(slugs, "TAG_HUB_MAX_COMPONENT_ALIASES", 1)

    response = api_client.get("/api/tagging/hub/oversized-redirect-one")

    assert response.status_code == 404


@pytest.mark.django_db
def test_a_live_casefold_alias_uses_one_canonical_hub(api_client, creator_factory):
    """A live alias with a different slug must widen the canonical hub.

    ``straße`` and ``STRASSE`` share ``tag_key`` because normalization uses
    casefolding, but ``slugify_tag`` deliberately uses lowercasing so the
    browser and server can share a JavaScript-compatible URL rule. This is
    the narrow state that otherwise creates two indexable hubs with different
    result sets.
    """
    creator = creator_factory()
    for index in range(3):
        _page(creator, ["straße"], title=f"canonical {index}")
    _page(creator, ["STRASSE"], title="live alias")
    _page(creator, [" straSSe "], title="whitespace alias")
    canonical = Tag.objects.get(name="straße")
    TagAlias.objects.create(
        name="STRASSE", canonical=canonical, source="human"
    )

    canonical_response = api_client.get("/api/tagging/hub/straße")
    alias_response = api_client.get("/api/tagging/hub/strasse")
    assert canonical_response.status_code == 200, canonical_response.content
    assert alias_response.status_code == 200, alias_response.content

    canonical_body = canonical_response.json()
    alias_body = alias_response.json()
    assert canonical_body["slug"] == "straße"
    assert alias_body["slug"] == "straße"
    assert canonical_body["names"] == alias_body["names"] == [
        "straße", " straSSe ", "STRASSE",
    ]
    assert set(canonical_body["names"]) == {
        "straße", "STRASSE", " straSSe ",
    }
    assert canonical_body["count"] == alias_body["count"] == 5
    assert canonical_body["indexable"] is True
    assert alias_body["indexable"] is True

    # The hub metadata and the paginated list must describe the same union.
    query = urlencode([
        ("any_tags", name) for name in canonical_body["names"]
    ])
    listed = api_client.get(f"/api/zpage/?{query}")
    assert listed.status_code == 200, listed.content
    assert listed.json()["count"] == 5
    assert sorted(row["title"] for row in listed.json()["results"]) == [
        "canonical 0", "canonical 1", "canonical 2", "live alias",
        "whitespace alias",
    ]


@pytest.mark.django_db
def test_a_stale_alias_projection_still_redirects_the_live_slug(
    api_client, creator_factory
):
    """A raw alias write cannot split a live spelling from its canonical hub."""
    creator = creator_factory()
    for _ in range(3):
        _page(creator, ["STRASSE"])
    canonical = Tag.objects.create(name="straße")
    live_alias = Tag.objects.get(name="STRASSE")
    TagAlias.objects.bulk_create([
        TagAlias(
            name=live_alias.name,
            name_key="stale-projection",
            slug="",
            canonical=canonical,
        )
    ])

    response = api_client.get("/api/tagging/hub/strasse")

    assert response.status_code == 200, response.content
    assert response.json()["slug"] == "straße"


@pytest.mark.django_db
def test_an_alias_cycle_converges_on_one_stable_root(
    api_client, creator_factory
):
    creator = creator_factory()
    first = Tag.objects.create(name="cycle-alpha")
    second = Tag.objects.create(name="cycle-beta")
    for _ in range(3):
        _page(creator, [first])
        _page(creator, [second])
    TagAlias.objects.create(name=first.name, canonical=second)
    TagAlias.objects.create(name=second.name, canonical=first)

    alpha = api_client.get("/api/tagging/hub/cycle-alpha")
    beta = api_client.get("/api/tagging/hub/cycle-beta")
    assert alpha.status_code == beta.status_code == 200
    assert alpha.json()["slug"] == beta.json()["slug"] == "cycle-alpha"


@pytest.mark.django_db
def test_a_historical_alias_chain_resolves_directly_to_its_final_root(
    api_client, creator_factory
):
    creator = creator_factory()
    final = Tag.objects.create(name="chain-final")
    old_b = Tag.objects.create(name="old-b")
    for index in range(3):
        _page(creator, [final], title=f"chain page {index}")
    TagAlias.objects.create(name="old-a", canonical=old_b)
    TagAlias.objects.create(name="old-b", canonical=final)

    response = api_client.get("/api/tagging/hub/old-a")

    assert response.status_code == 200, response.content
    assert response.json()["slug"] == "chain-final"
    assert response.json()["count"] == 3


@pytest.mark.django_db
def test_conflicting_alias_targets_use_one_stable_root(
    api_client, creator_factory
):
    creator = creator_factory()
    first = Tag.objects.create(name="conflict-alpha")
    second = Tag.objects.create(name="conflict-beta")
    for _ in range(3):
        _page(creator, [first])
        _page(creator, [second])
    TagAlias.objects.create(name="conflict spelling", canonical=first)
    TagAlias.objects.create(name="CONFLICT SPELLING", canonical=second)

    alias = api_client.get("/api/tagging/hub/conflict-spelling")
    first_hub = api_client.get("/api/tagging/hub/conflict-alpha")
    second_hub = api_client.get("/api/tagging/hub/conflict-beta")
    # The write path refuses this conflict. Read paths must fail closed rather
    # than choose an insertion-order winner and erase one live hub's URL.
    assert alias.status_code == 503, alias.content
    assert first_hub.status_code == second_hub.status_code == 503


@pytest.mark.django_db
def test_alias_redirect_does_not_strand_an_unrelated_slug_collision(
    api_client, creator_factory
):
    creator = creator_factory()
    _page(creator, ["Foo Bar"])
    _page(creator, ["foo/bar"])
    topic = Tag.objects.create(name="Topic")
    TagAlias.objects.create(name="Foo Bar", canonical=topic)

    response = api_client.get("/api/tagging/hub/foo-bar")

    assert response.status_code == 503, response.content


@pytest.mark.django_db
def test_a_component_past_the_public_bound_fails_closed(
    api_client, creator_factory, monkeypatch
):
    creator_factory()
    root = Tag.objects.create(name="over-cap-root")
    for index in range(4):
        TagAlias.objects.create(
            name=f"over cap alias {index}", canonical=root
        )

    import dj.apps.tagging.slugs as slugs

    monkeypatch.setattr(slugs, "TAG_HUB_MAX_COMPONENT_ALIASES", 2)
    response = api_client.get("/api/tagging/hub/over-cap-root")

    assert response.status_code == 503
    assert "temporarily" in response.json()["detail"].lower()


@pytest.mark.django_db
def test_any_tags_is_an_or_and_tags_is_still_an_and(
    api_client, creator_factory
):
    """The filter the hub lists through.

    `?tags=` is unchanged (AND); `?any_tags=` is the new OR group, and the two
    compose. Without OR semantics a hub for colliding spellings would list
    only the pages carrying every one of them -- usually zero.
    """
    creator = creator_factory()
    _page(creator, ["t-shirts"], title="dash")
    _page(creator, ["t shirts"], title="space")
    _page(creator, ["t-shirts", "zcash"], title="both")

    def titles(query):
        response = api_client.get(f"/api/zpage/?{query}")
        assert response.status_code == 200, response.content
        return sorted(item["title"] for item in response.json()["results"])

    assert titles("any_tags=t-shirts&any_tags=t shirts") == [
        "both", "dash", "space",
    ]
    # AND, unchanged.
    assert titles("tags=t-shirts,zcash") == ["both"]
    # The two compose: zcash AND (t-shirts OR t shirts).
    assert titles("tags=zcash&any_tags=t-shirts&any_tags=t shirts") == ["both"]
    # A name containing a comma survives, which is why this parameter repeats
    # rather than comma-joining.
    _page(creator, ["a,b"], title="comma")
    assert titles("any_tags=a,b") == ["comma"]


@pytest.mark.django_db
def test_any_tags_hides_a_deactivated_creators_pages(
    api_client, creator_factory
):
    """The listing half of the  check.

    The hub's count and its rendered rows come from two different endpoints; a
    takedown that only reached one of them would leave a page listing articles
    it says do not exist.
    """
    live = creator_factory()
    banned = creator_factory()
    _page(live, ["shared-topic"], title="live page")
    _page(banned, ["shared-topic"], title="banned page")

    def titles():
        response = api_client.get("/api/zpage/?any_tags=shared-topic")
        assert response.status_code == 200, response.content
        return sorted(item["title"] for item in response.json()["results"])

    assert titles() == ["banned page", "live page"]

    _deactivate(banned)

    assert titles() == ["live page"]
