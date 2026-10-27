"""zPage AI tagging is suggestion-first.

Every test here pins one of the three things that were wrong with the deployed
`zpage-tag` Deployment, and the properties are stated as behaviour rather than
as implementation:

* it wrote to the creator's article silently;
* ``tags.exists()`` was the whole gate, so one creator-authored tag switched
  AI tagging off for that page forever;
* nothing recorded that a pass had happened, so redeliveries and metadata-only
  saves each bought another completion.

The database is real Postgres. The ONLY thing stubbed is the OpenAI call
itself, at ``dj.apps.tagging.services.tag_content`` — the boundary to a paid
third-party service, not the boundary to our own storage.
"""

import uuid

import pytest

from dj.apps.g12f.models import zPage
from dj.apps.tagging import services
from dj.apps.tagging.models import TagSuggestion, TagSuggestionRun

BODY = (
    "Recursive proof composition lets a verifier check a proof of a proof. "
    "In the Halo 2 setting the accumulator is folded across steps, which is "
    "what removes the trusted setup entirely. This paragraph exists to clear "
    "the TAGGING_MIN_CHARS floor with room to spare."
)


def _page(creator, tags=(), published=True, content=BODY, title="Recursion"):
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"article-{uuid.uuid4()}",
        title=title,
        content=content,
        is_published=published,
    )
    if tags:
        page.tags.add(*tags)
    return page


@pytest.fixture(autouse=True)
def suggestion_first(settings):
    """Pin these tests to 's suggestion-first behaviour.

    a published page with ZERO tags is tagged directly, and most
    fixtures here are blank pages. What this module pins -- dismissal
    stickiness, the digest/debounce/budget gates, the decide API -- is all
    still true, and still the whole behaviour for any page that carries a tag;
    the blank-page write has its own module, ``test_autotag_blank_zpages.py``,
    which also covers this switch.
    """
    settings.TAGGING_AUTO_APPLY_BLANK = False
    return settings


@pytest.fixture
def no_debounce(settings):
    """Turn off the rate bound for tests that are ABOUT the digest gate.

    The debounce and the digest are two different bounds and both are real; a
    test that wants to prove the digest re-fires on edited content has to get
    the rate bound out of the way, and saying so explicitly is better than
    sleeping or freezing the clock.
    """
    settings.TAGGING_MIN_INTERVAL_SECONDS = 0
    return settings


@pytest.fixture
def fake_tagger(mocker):
    """Stub the paid call. Returns the mock so tests can count invocations."""
    return mocker.patch(
        "dj.apps.tagging.services.tag_content",
        return_value=["cryptography", "halo2 recursion", "zero-knowledge proofs"],
    )


# ---------------------------------------------------------------------------
# 1. It suggests. It does not write.
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_pass_writes_suggestions_and_never_touches_the_article(
    creator_factory, fake_tagger
):
    """The headline property of, asserted on the article itself."""
    page = _page(creator_factory())

    created = services.suggest_tags_for_zpage(page)

    assert {row.name for row in created} == {
        "cryptography", "halo2 recursion", "zero-knowledge proofs",
    }
    # The creator's article is untouched. This is the whole point.
    assert list(page.tags.names()) == []
    assert all(row.status == TagSuggestion.PENDING for row in created)


@pytest.mark.django_db
def test_accepting_is_the_only_thing_that_writes_a_tag(
    creator_factory, fake_tagger
):
    creator = creator_factory()
    page = _page(creator)
    services.suggest_tags_for_zpage(page)

    accepted, dismissed = services.decide_suggestions(
        page, accept=["halo2 recursion"], dismiss=["cryptography"],
        user=creator,
    )

    assert accepted == ["halo2 recursion"]
    assert dismissed == ["cryptography"]
    assert set(page.tags.names()) == {"halo2 recursion"}


@pytest.mark.django_db
def test_nothing_in_the_decision_path_can_remove_a_creator_tag(
    creator_factory, fake_tagger
):
    """Dismissing marks the suggestion, never the tag — even for a tag the
    creator wrote themselves that happens to share the name."""
    creator = creator_factory()
    page = _page(creator, tags=["zebra husbandry", "cryptography"])
    services.suggest_tags_for_zpage(page)

    services.decide_suggestions(
        page,
        dismiss=["zebra husbandry", "cryptography", "halo2 recursion"],
        user=creator,
    )

    assert set(page.tags.names()) == {"zebra husbandry", "cryptography"}


# ---------------------------------------------------------------------------
# 2. A creator-authored tag no longer switches tagging off (the  trap)
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_an_existing_creator_tag_does_not_suppress_suggestions(
    creator_factory, fake_tagger
):
    """`if tags.exists(): return` was the entire old gate.

    After  a creator could add their own tag, and doing so turned AI
    tagging off for that page permanently. Engagement must improve
    suggestions, not disable them.
    """
    page = _page(creator_factory(), tags=["my own tag"])

    created = services.suggest_tags_for_zpage(page)

    assert fake_tagger.call_count == 1
    assert {row.name for row in created} == {
        "cryptography", "halo2 recursion", "zero-knowledge proofs",
    }


@pytest.mark.django_db
def test_a_tag_the_page_already_carries_is_not_re_proposed(
    creator_factory, fake_tagger
):
    page = _page(creator_factory(), tags=["Cryptography"])

    created = services.suggest_tags_for_zpage(page)

    # Case-insensitively already present, so it is not offered back.
    assert {row.name for row in created} == {
        "halo2 recursion", "zero-knowledge proofs",
    }


# ---------------------------------------------------------------------------
# 3. The digest gate: unchanged content is free
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_re_running_on_unchanged_content_buys_no_completion(
    creator_factory, fake_tagger
):
    """`PAGE_UPDATE` fires on every save; this is what makes that cheap."""
    page = _page(creator_factory())

    services.suggest_tags_for_zpage(page)
    services.suggest_tags_for_zpage(page)
    services.suggest_tags_for_zpage(page)

    assert fake_tagger.call_count == 1
    assert TagSuggestionRun.objects.filter(zpage=page).count() == 1


@pytest.mark.django_db
def test_edited_content_gets_a_fresh_pass(
    creator_factory, fake_tagger, no_debounce
):
    page = _page(creator_factory())
    services.suggest_tags_for_zpage(page)

    page.content = BODY + " A genuinely new paragraph about lattices."
    page.save()
    services.suggest_tags_for_zpage(page)

    assert fake_tagger.call_count == 2
    assert TagSuggestionRun.objects.filter(zpage=page).count() == 2


@pytest.mark.django_db
def test_a_retitle_is_a_content_change(
    creator_factory, fake_tagger, no_debounce
):
    """The prompt carries the title, so the digest must too."""
    page = _page(creator_factory())
    services.suggest_tags_for_zpage(page)

    page.title = "Something completely different"
    page.save()
    services.suggest_tags_for_zpage(page)

    assert fake_tagger.call_count == 2


@pytest.mark.django_db
def test_unpublished_and_tiny_pages_cost_nothing(creator_factory, fake_tagger):
    draft = _page(creator_factory(), published=False)
    stub = _page(creator_factory(), content="hi")

    assert services.suggest_tags_for_zpage(draft) == []
    assert services.suggest_tags_for_zpage(stub) == []
    assert fake_tagger.call_count == 0


@pytest.mark.django_db
def test_a_failed_completion_does_not_record_a_run(creator_factory, mocker):
    """Otherwise the digest gate would permanently suppress the retry."""
    mocker.patch(
        "dj.apps.tagging.services.tag_content",
        side_effect=RuntimeError("provider is down"),
    )
    page = _page(creator_factory())

    with pytest.raises(RuntimeError):
        services.suggest_tags_for_zpage(page)

    assert TagSuggestionRun.objects.filter(zpage=page).count() == 0


# ---------------------------------------------------------------------------
# 4. A dismissal is permanent for that page
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_dismissed_tag_is_never_proposed_again(
    creator_factory, mocker, no_debounce
):
    tagger = mocker.patch(
        "dj.apps.tagging.services.tag_content",
        return_value=["cryptography", "halo2 recursion"],
    )
    creator = creator_factory()
    page = _page(creator)
    services.suggest_tags_for_zpage(page)
    services.decide_suggestions(page, dismiss=["cryptography"], user=creator)

    # A later edit re-runs the pass and the model says the same thing again.
    page.content = BODY + " Another paragraph, same subject matter entirely."
    page.save()
    tagger.return_value = ["cryptography", "halo2 recursion", "elliptic curves"]
    services.suggest_tags_for_zpage(page)

    pending = {row.name for row in services.pending_suggestions(page)}
    assert "cryptography" not in pending
    assert pending == {"halo2 recursion", "elliptic curves"}


@pytest.mark.django_db
def test_dismissal_survives_a_case_change(
    creator_factory, mocker, no_debounce
):
    tagger = mocker.patch(
        "dj.apps.tagging.services.tag_content", return_value=["Cryptography"])
    creator = creator_factory()
    page = _page(creator)
    services.suggest_tags_for_zpage(page)
    services.decide_suggestions(page, dismiss=["cryptography"], user=creator)

    page.content = BODY + " More on the same, differently worded this time."
    page.save()
    tagger.return_value = ["CRYPTOGRAPHY"]
    services.suggest_tags_for_zpage(page)

    assert services.pending_suggestions(page) == []


@pytest.mark.django_db
def test_a_name_sent_as_both_accept_and_dismiss_is_accepted(
    creator_factory, fake_tagger
):
    """The constructive outcome. The alternative silently loses a tag the
    creator asked for."""
    creator = creator_factory()
    page = _page(creator)
    services.suggest_tags_for_zpage(page)

    accepted, dismissed = services.decide_suggestions(
        page, accept=["halo2 recursion"], dismiss=["halo2 recursion"],
        user=creator,
    )

    assert accepted == ["halo2 recursion"]
    assert dismissed == []
    assert "halo2 recursion" in page.tags.names()


@pytest.mark.django_db
def test_deciding_an_unknown_name_is_a_no_op_not_an_error(
    creator_factory, fake_tagger
):
    creator = creator_factory()
    page = _page(creator)
    services.suggest_tags_for_zpage(page)

    accepted, dismissed = services.decide_suggestions(
        page, accept=["a tag nobody suggested"], user=creator)

    assert accepted == []
    assert list(page.tags.names()) == []


# ---------------------------------------------------------------------------
# 5. The API
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_owner_reads_pending_suggestions_with_a_breadth_level(
    api_client, creator_factory, fake_tagger
):
    creator = creator_factory()
    page = _page(creator)
    services.suggest_tags_for_zpage(page)
    api_client.force_authenticate(user=creator)

    response = api_client.get(
        f"/api/tagging/zpage/{page.free2zaddr}/suggestions")

    assert response.status_code == 200, response.content
    names = {row["name"] for row in response.data}
    assert names == {
        "cryptography", "halo2 recursion", "zero-knowledge proofs"}
    assert all(row["level"] in ("broad", "narrow") for row in response.data)
    assert all(isinstance(row["count"], int) for row in response.data)


@pytest.mark.django_db
def test_suggestions_are_owner_only(api_client, creator_factory, fake_tagger):
    page = _page(creator_factory())
    services.suggest_tags_for_zpage(page)

    # A different logged-in creator: 404, not 403 — whether someone else's
    # page has suggestions is not a fact this API hands out.
    api_client.force_authenticate(user=creator_factory())
    assert api_client.get(
        f"/api/tagging/zpage/{page.free2zaddr}/suggestions"
    ).status_code == 404

    api_client.force_authenticate(user=None)
    assert api_client.get(
        f"/api/tagging/zpage/{page.free2zaddr}/suggestions"
    ).status_code in (401, 403)


@pytest.mark.django_db
def test_decide_endpoint_applies_and_returns_the_new_state(
    api_client, creator_factory, fake_tagger
):
    creator = creator_factory()
    page = _page(creator, tags=["zebra husbandry"])
    services.suggest_tags_for_zpage(page)
    api_client.force_authenticate(user=creator)

    response = api_client.post(
        f"/api/tagging/zpage/{page.free2zaddr}/suggestions/decide",
        {"accept": ["halo2 recursion"], "dismiss": ["cryptography"]},
        format="json",
    )

    assert response.status_code == 200, response.content
    assert response.data["accepted"] == ["halo2 recursion"]
    assert response.data["dismissed"] == ["cryptography"]
    # The creator's own tag is still there, and the response is authoritative.
    assert set(response.data["tags"]) == {"zebra husbandry", "halo2 recursion"}
    assert {row["name"] for row in response.data["suggestions"]} == {
        "zero-knowledge proofs"}


@pytest.mark.django_db
def test_decide_endpoint_is_owner_only(
    api_client, creator_factory, fake_tagger
):
    page = _page(creator_factory())
    services.suggest_tags_for_zpage(page)
    api_client.force_authenticate(user=creator_factory())

    response = api_client.post(
        f"/api/tagging/zpage/{page.free2zaddr}/suggestions/decide",
        {"accept": ["halo2 recursion"]},
        format="json",
    )

    assert response.status_code == 404
    assert list(page.tags.names()) == []


@pytest.mark.django_db
def test_decide_endpoint_bounds_the_payload(
    api_client, creator_factory, fake_tagger
):
    creator = creator_factory()
    page = _page(creator)
    api_client.force_authenticate(user=creator)

    response = api_client.post(
        f"/api/tagging/zpage/{page.free2zaddr}/suggestions/decide",
        {"accept": [f"tag-{n}" for n in range(500)]},
        format="json",
    )

    assert response.status_code == 400


# ---------------------------------------------------------------------------
# 6. The subscriber itself
# ---------------------------------------------------------------------------

@pytest.fixture
def subscriber_callback(mocker):
    """The real callback, with only its connection lifecycle neutralized.

    ``close_old_connections()`` exists because the subscriber is a long-lived
    worker process; under pytest-django it closes the connection holding the
    test's rollback transaction, which is a property of the harness and not of
    the code. Everything else — the query, the service, the ack — is real.
    """
    from dj.apps.openai.management.commands import tag_zpages

    mocker.patch.object(tag_zpages, "close_old_connections", lambda: None)
    return tag_zpages.callback


class _FakeMessage:
    """The two bits of a Pub/Sub message this callback touches."""

    def __init__(self, payload):
        self.data = payload.encode("utf-8")
        self.acked = 0

    def ack(self):
        self.acked += 1


@pytest.mark.django_db
def test_the_subscriber_proposes_instead_of_writing(
    creator_factory, fake_tagger, subscriber_callback
):
    """The `zpage-tag` Deployment used to do `instance.tags.add(*tags)` here."""
    import json

    page = _page(creator_factory())
    message = _FakeMessage(json.dumps({"free2zaddr": page.free2zaddr}))

    subscriber_callback(message)

    assert message.acked == 1
    assert list(page.tags.names()) == []
    assert TagSuggestion.objects.filter(zpage=page).count() == 3


@pytest.mark.django_db
def test_a_deleted_page_is_acked_not_redelivered(
    creator_factory, fake_tagger, subscriber_callback
):
    """The subscription has no DLQ, so a poison message must not loop —
    every redelivery would buy another completion."""
    import json

    message = _FakeMessage(json.dumps({"free2zaddr": str(uuid.uuid4())}))

    subscriber_callback(message)

    assert message.acked == 1
    assert fake_tagger.call_count == 0


@pytest.mark.django_db
def test_a_provider_failure_is_acked_and_logged(
    creator_factory, mocker, subscriber_callback
):
    import json

    mocker.patch(
        "dj.apps.tagging.services.tag_content",
        side_effect=RuntimeError("provider is down"),
    )
    page = _page(creator_factory())
    message = _FakeMessage(json.dumps({"free2zaddr": page.free2zaddr}))

    subscriber_callback(message)

    assert message.acked == 1
    # No run recorded, so a later edit still gets a pass.
    assert TagSuggestionRun.objects.filter(zpage=page).count() == 0


# ---------------------------------------------------------------------------
# 7. Spend bounds beyond the digest (codex adversarial review)
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_autosave_churn_does_not_buy_a_completion_per_save(
    creator_factory, fake_tagger
):
    """The bound the digest alone does NOT give you.

    A published page autosaves every few seconds while someone types. Every
    save is different text, so every save is a different digest and another
    `PAGE_UPDATE` — a digest-only gate would buy a completion each time, which
    is *worse* than the `tags.exists()` code it replaces (that stopped after
    one). The debounce is what makes a writing session one pass.
    """
    page = _page(creator_factory())

    for n in range(12):
        page.content = f"{BODY} Revision number {n}, still being written."
        page.save()
        services.suggest_tags_for_zpage(page)

    assert fake_tagger.call_count == 1


@pytest.mark.django_db
def test_a_page_has_a_lifetime_run_budget(
    creator_factory, fake_tagger, no_debounce, settings
):
    """The debounce bounds the rate; this bounds the total."""
    settings.TAGGING_MAX_RUNS_PER_PAGE = 3
    page = _page(creator_factory())

    for n in range(10):
        page.content = f"{BODY} Revision number {n}, a real rewrite each time."
        page.save()
        services.suggest_tags_for_zpage(page)

    assert fake_tagger.call_count == 3
    assert TagSuggestionRun.objects.filter(zpage=page).count() == 3


@pytest.mark.django_db
def test_a_second_concurrent_delivery_does_not_pay_twice(
    creator_factory, fake_tagger
):
    """The digest is claimed BEFORE the completion is bought.

    `should_suggest()` is a read, so two deliveries of the same Pub/Sub message
    both pass it. Only the unique constraint can settle that, which means the
    run row has to be written first — this asserts the second caller finds the
    claim taken rather than buying its own completion.
    """
    page = _page(creator_factory())
    digest = services.page_digest(page)
    TagSuggestionRun.objects.create(zpage=page, source_digest=digest)

    # `force` skips `should_suggest` exactly the way a racing delivery would
    # have skipped it by reading before the other one wrote.
    assert services.suggest_tags_for_zpage(page, force=True) == []
    assert fake_tagger.call_count == 0


@pytest.mark.django_db
def test_a_casefold_expanding_tag_does_not_blow_up_the_key_column(
    creator_factory, mocker
):
    """`casefold()` can EXPAND: 100 x `\u00df` becomes a 200-character key.

    The name is inside `Tag.name`'s 100-character limit, so it must not be the
    derived key that fails the insert and loses the whole pass.
    """
    mocker.patch(
        "dj.apps.tagging.services.tag_content",
        return_value=["\u00df" * 100, "halo2 recursion"],
    )
    page = _page(creator_factory())

    created = services.suggest_tags_for_zpage(page)

    assert {row.name for row in created} == {"\u00df" * 100, "halo2 recursion"}
