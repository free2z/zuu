"""Blank published zPages get AI tags applied; tagged ones never do.

Real Postgres throughout. The only stub is the paid completion, at
``dj.apps.tagging.services.tag_content`` (and Pub/Sub, which the root conftest
stubs for every test).
"""

import json
import uuid
from io import StringIO

import pytest
from django.core.management import call_command
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage
from dj.apps.tagging import services
from dj.apps.tagging.models import TagSuggestion, TagSuggestionRun

BODY = (
    "Recursive proof composition lets a verifier check a proof of a proof. "
    "In the Halo 2 setting the accumulator is folded across steps, which is "
    "what removes the trusted setup entirely. This paragraph exists to clear "
    "the TAGGING_MIN_CHARS floor with room to spare."
)
AI_TAGS = ["cryptography", "halo2 recursion", "zero-knowledge proofs"]


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


def _tags(page):
    return set(zPage.objects.get(pk=page.pk).tags.names())


@pytest.fixture(autouse=True)
def auto_apply_on(settings):
    """The shipped default, stated so a settings change cannot hide here."""
    settings.TAGGING_AUTO_APPLY_BLANK = True
    return settings


@pytest.fixture
def fake_tagger(mocker):
    return mocker.patch(
        "dj.apps.tagging.services.tag_content", return_value=list(AI_TAGS))


# ---------------------------------------------------------------------------
# The live pass
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_blank_published_page_gets_the_ai_tags_applied(
    creator_factory, fake_tagger
):
    page = _page(creator_factory())

    rows = services.suggest_tags_for_zpage(page)

    assert _tags(page) == set(AI_TAGS)
    # Provenance: a machine chose these, and nobody is recorded as deciding.
    stored = TagSuggestion.objects.filter(zpage=page)
    assert {row.status for row in stored} == {TagSuggestion.AUTO_APPLIED}
    assert all(row.decided_by_id is None for row in stored)
    assert all(row.decided_at is not None for row in stored)
    assert {row.name for row in rows} == set(AI_TAGS)
    # Nothing left for the editor to offer as a chip.
    assert services.pending_suggestions(page) == []


@pytest.mark.django_db
def test_a_creator_tagged_page_is_never_auto_tagged(
    creator_factory, fake_tagger
):
    page = _page(creator_factory(), tags=["my own tag"])

    services.suggest_tags_for_zpage(page)

    assert fake_tagger.call_count == 1
    assert _tags(page) == {"my own tag"}
    assert {
        row.status for row in TagSuggestion.objects.filter(zpage=page)
    } == {TagSuggestion.PENDING}


@pytest.mark.django_db
def test_a_tag_added_while_the_completion_is_in_flight_wins(
    creator_factory, mocker
):
    """Blank is decided at write time, under the row lock -- not at start."""
    page = _page(creator_factory())

    def creator_tags_meanwhile(prompt, model=None):
        # The creator saves a tag from another connection's point of view:
        # committed before the pass reaches its write transaction.
        zPage.objects.get(pk=page.pk).tags.add("written by hand")
        return list(AI_TAGS)

    mocker.patch(
        "dj.apps.tagging.services.tag_content",
        side_effect=creator_tags_meanwhile)

    services.suggest_tags_for_zpage(page)

    assert _tags(page) == {"written by hand"}
    assert {
        row.status for row in TagSuggestion.objects.filter(zpage=page)
    } == {TagSuggestion.PENDING}


@pytest.mark.django_db
def test_a_page_unpublished_mid_flight_is_not_tagged(creator_factory, mocker):
    page = _page(creator_factory())

    def unpublish_meanwhile(prompt, model=None):
        zPage.objects.filter(pk=page.pk).update(is_published=False)
        return list(AI_TAGS)

    mocker.patch(
        "dj.apps.tagging.services.tag_content", side_effect=unpublish_meanwhile)

    services.suggest_tags_for_zpage(page)

    assert _tags(page) == set()


@pytest.mark.django_db
def test_content_replaced_mid_flight_is_not_labelled_with_old_tags(
    creator_factory, mocker
):
    """The output describes the text the pass read, not the text now there."""
    page = _page(creator_factory())

    def rewrite_meanwhile(prompt, model=None):
        zPage.objects.filter(pk=page.pk).update(
            content="An entirely different article about sourdough. " * 5)
        return list(AI_TAGS)

    mocker.patch(
        "dj.apps.tagging.services.tag_content", side_effect=rewrite_meanwhile)

    services.suggest_tags_for_zpage(page)

    assert _tags(page) == set()
    assert len(services.pending_suggestions(page)) == 3


@pytest.mark.django_db
def test_auto_applied_tags_requeue_the_search_index(
    creator_factory, fake_tagger, mocker
):
    """Tags are in the search document and `tags.add()` fires no post_save."""
    page = _page(creator_factory())
    reindex = mocker.patch("dj.apps.g12f.signals.reindex_published_zpage")

    services.suggest_tags_for_zpage(page)

    assert [call.args[0].pk for call in reindex.call_args_list] == [page.pk]


@pytest.mark.django_db
def test_a_failed_reindex_enqueue_does_not_lose_the_tags(
    creator_factory, fake_tagger, mocker
):
    page = _page(creator_factory())
    mocker.patch(
        "dj.apps.g12f.signals.reindex_published_zpage",
        side_effect=RuntimeError("queue is down"))

    services.suggest_tags_for_zpage(page)

    assert _tags(page) == set(AI_TAGS)


@pytest.mark.django_db
def test_a_failed_recording_releases_the_claim(
    creator_factory, fake_tagger, mocker
):
    page = _page(creator_factory())
    mocker.patch(
        "dj.apps.tagging.services.record_suggestions",
        side_effect=RuntimeError("db hiccup"))

    with pytest.raises(RuntimeError):
        services.suggest_tags_for_zpage(page)

    assert not TagSuggestionRun.objects.filter(zpage=page).exists()


@pytest.mark.django_db
def test_drafts_are_skipped_entirely(creator_factory, fake_tagger):
    draft = _page(creator_factory(), published=False)

    assert services.suggest_tags_for_zpage(draft) == []
    assert fake_tagger.call_count == 0
    assert _tags(draft) == set()
    assert not TagSuggestion.objects.filter(zpage=draft).exists()


@pytest.mark.django_db
def test_a_dismissed_tag_is_not_applied_even_to_a_blank_page(
    creator_factory, fake_tagger
):
    page = _page(creator_factory())
    TagSuggestion.objects.create(
        zpage=page, name="cryptography", status=TagSuggestion.DISMISSED)

    services.suggest_tags_for_zpage(page)

    assert _tags(page) == {"halo2 recursion", "zero-knowledge proofs"}


@pytest.mark.django_db
def test_a_page_whose_ai_tags_were_removed_is_left_alone(
    creator_factory, fake_tagger, settings
):
    """Auto-tagged once, blank again: somebody removed them. Hands off."""
    settings.TAGGING_MIN_INTERVAL_SECONDS = 0
    page = _page(creator_factory())
    services.suggest_tags_for_zpage(page)
    page.tags.clear()  # the creator emptying the tag field

    page.content = BODY + " A genuinely new paragraph about lattices."
    page.save()
    fake_tagger.return_value = ["lattices"]
    services.suggest_tags_for_zpage(page)

    assert _tags(page) == set()
    assert TagSuggestion.objects.get(
        zpage=page, name="lattices").status == TagSuggestion.PENDING


@pytest.mark.django_db
def test_the_switch_restores_suggestion_first(
    creator_factory, fake_tagger, settings
):
    settings.TAGGING_AUTO_APPLY_BLANK = False
    page = _page(creator_factory())

    services.suggest_tags_for_zpage(page)

    assert _tags(page) == set()
    assert len(services.pending_suggestions(page)) == 3


@pytest.mark.django_db
def test_the_subscriber_applies_tags_to_a_blank_page(
    creator_factory, fake_tagger, mocker
):
    from dj.apps.openai.management.commands import tag_zpages

    # Under pytest-django this would close the test's own connection.
    mocker.patch.object(tag_zpages, "close_old_connections", lambda: None)

    class Message:
        acked = 0

        def __init__(self, payload):
            self.data = json.dumps(payload).encode("utf-8")

        def ack(self):
            self.acked += 1

    page = _page(creator_factory())
    message = Message({"free2zaddr": page.free2zaddr})

    tag_zpages.callback(message)

    assert message.acked == 1
    assert _tags(page) == set(AI_TAGS)


@pytest.mark.django_db
def test_publishing_with_no_tags_broadcasts_the_page_update(
    creator_factory, mocker, django_capture_on_commit_callbacks
):
    """The subscriber only runs if the publish emits PAGE_UPDATE -- with
    ``tags: []`` too, which is what the editor sends for an untagged page."""
    published = []

    class Recorder:
        def publish(self, topic, payload, **kwargs):
            published.append(payload)

    mocker.patch("dj.apps.g12f.publication.PubSubClient", Recorder)
    creator = creator_factory()
    page = _page(creator, published=False)
    client = APIClient()
    client.force_authenticate(creator)

    with django_capture_on_commit_callbacks(execute=True):
        response = client.patch(
            f"/api/zpage/{page.free2zaddr}/",
            {"is_published": True, "tags": []},
            format="json",
        )

    assert response.status_code == 200, response.data
    assert [p["free2zaddr"] for p in published] == [page.free2zaddr]


# ---------------------------------------------------------------------------
# An editor still open on the page (the 412 the auto-apply would otherwise
# cause -- see g12f/preconditions.py)
# ---------------------------------------------------------------------------

def _autosave(**overrides):
    payload = {"title": "Recursion", "content": BODY + " typo fixed",
               "description": "", "tags": [], "is_published": True}
    payload.update(overrides)
    return payload


@pytest.mark.django_db
def test_a_stale_editor_autosave_neither_412s_nor_erases_ai_tags(
    creator_factory, fake_tagger
):
    creator = creator_factory()
    page = _page(creator)
    client = APIClient()
    client.force_authenticate(creator)
    etag = client.get(f"/api/zpage/{page.free2zaddr}/")["ETag"]

    services.suggest_tags_for_zpage(page)  # lands while the editor is open

    saved = client.put(
        f"/api/zpage/{page.free2zaddr}/", _autosave(), format="json",
        HTTP_IF_MATCH=etag,
    )

    assert saved.status_code == 200, saved.data
    assert _tags(page) == set(AI_TAGS)
    assert set(saved.data["tags"]) == set(AI_TAGS)
    assert zPage.objects.get(pk=page.pk).content.endswith("typo fixed")
    # The editor adopts the response's validator; the next read agrees.
    assert client.get(f"/api/zpage/{page.free2zaddr}/")["ETag"] == saved["ETag"]


@pytest.mark.django_db
@pytest.mark.parametrize("route", ["variants", "translations"])
def test_a_stale_translation_autosave_keeps_the_ai_tags(
    creator_factory, fake_tagger, route
):
    """A translation PUT writes `tags` onto the parent, and its validator
    embeds the canonical one -- same allowance, same echo rule."""
    from dj.apps.g12f.models import ZPageTranslation

    creator = creator_factory()
    page = _page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=False,
    )
    client = APIClient()
    client.force_authenticate(creator)
    etag = client.get(f"/api/zpage/{page.free2zaddr}/variants/fr/")["ETag"]
    services.suggest_tags_for_zpage(page)

    saved = client.put(
        f"/api/zpage/{page.free2zaddr}/{route}/fr/",
        {"title": "fr", "description": "fr", "content": "corps modifie",
         "tags": [], "is_published": False},
        format="json", HTTP_IF_MATCH=etag,
        HTTP_X_FREE2Z_SOURCE_LANGUAGE=page.source_language,
    )

    assert saved.status_code == 200, saved.data
    assert _tags(page) == set(AI_TAGS)


@pytest.mark.django_db
def test_a_stale_editor_choosing_its_own_tags_wins(creator_factory, fake_tagger):
    creator = creator_factory()
    page = _page(creator)
    client = APIClient()
    client.force_authenticate(creator)
    etag = client.get(f"/api/zpage/{page.free2zaddr}/")["ETag"]
    services.suggest_tags_for_zpage(page)

    saved = client.put(
        f"/api/zpage/{page.free2zaddr}/", _autosave(tags=["mine"]),
        format="json", HTTP_IF_MATCH=etag,
    )

    assert saved.status_code == 200, saved.data
    assert _tags(page) == {"mine"}


@pytest.mark.django_db
def test_a_stale_editor_still_412s_on_any_other_change(
    creator_factory, fake_tagger
):
    """The allowance overlooks the AI tags and nothing else."""
    creator = creator_factory()
    page = _page(creator)
    client = APIClient()
    client.force_authenticate(creator)
    etag = client.get(f"/api/zpage/{page.free2zaddr}/")["ETag"]
    services.suggest_tags_for_zpage(page)
    other_tab = APIClient()
    other_tab.force_authenticate(creator)
    assert other_tab.patch(
        f"/api/zpage/{page.free2zaddr}/", {"content": BODY + " other tab"},
        format="json",
    ).status_code == 200

    refused = client.put(
        f"/api/zpage/{page.free2zaddr}/", _autosave(), format="json",
        HTTP_IF_MATCH=etag,
    )

    assert refused.status_code == 412


@pytest.mark.django_db
def test_an_accepted_suggestion_still_invalidates_the_validator(
    creator_factory, fake_tagger, settings
):
    """Only AUTO_APPLIED is overlooked: a tag the creator accepted in another
    tab is a human change, and the stale tab must be told."""
    settings.TAGGING_AUTO_APPLY_BLANK = False
    creator = creator_factory()
    page = _page(creator)
    client = APIClient()
    client.force_authenticate(creator)
    etag = client.get(f"/api/zpage/{page.free2zaddr}/")["ETag"]
    services.suggest_tags_for_zpage(page)
    services.decide_suggestions(page, accept=["cryptography"], user=creator)

    refused = client.put(
        f"/api/zpage/{page.free2zaddr}/", _autosave(), format="json",
        HTTP_IF_MATCH=etag,
    )

    assert refused.status_code == 412
    assert _tags(page) == {"cryptography"}


# ---------------------------------------------------------------------------
# The backfill
# ---------------------------------------------------------------------------

def _backfill(*args):
    out = StringIO()
    call_command("autotag_untagged_zpages", "--sleep=0", *args, stdout=out)
    return out.getvalue()


def _pending(page, *names, digest=None):
    """Pending rows proposed for the page's current content by default."""
    for name in names:
        TagSuggestion.objects.create(
            zpage=page, name=name, status=TagSuggestion.PENDING,
            source_digest=digest or services.page_digest(page))


@pytest.mark.django_db
def test_backfill_dry_run_writes_nothing_and_calls_nothing(
    creator_factory, fake_tagger
):
    creator = creator_factory()
    reuse = _page(creator)
    _pending(reuse, "zcash")
    fresh = _page(creator)

    output = _backfill("--dry-run")

    assert fake_tagger.call_count == 0
    assert _tags(reuse) == set() and _tags(fresh) == set()
    assert TagSuggestion.objects.get(zpage=reuse).status == TagSuggestion.PENDING
    assert not TagSuggestionRun.objects.exists()
    assert "reused_pending=1" in output and "new_pass=1" in output


@pytest.mark.django_db
def test_backfill_reuses_pending_suggestions_without_the_provider(
    creator_factory, fake_tagger
):
    page = _page(creator_factory())
    # The  pass already ran over this content and was paid for.
    TagSuggestionRun.objects.create(
        zpage=page, source_digest=services.page_digest(page))
    _pending(page, "zcash", "privacy")

    output = _backfill()

    assert fake_tagger.call_count == 0
    assert _tags(page) == {"zcash", "privacy"}
    assert {
        row.status for row in TagSuggestion.objects.filter(zpage=page)
    } == {TagSuggestion.AUTO_APPLIED}
    assert "reused_pending=1" in output


@pytest.mark.django_db
def test_backfill_does_not_reuse_suggestions_for_older_content(
    creator_factory, fake_tagger
):
    """A page rewritten since its last pass must not get its old subject."""
    page = _page(creator_factory())
    _pending(page, "cooking", digest="digest-of-the-previous-version")

    _backfill()

    assert fake_tagger.call_count == 1
    assert _tags(page) == set(AI_TAGS)
    assert TagSuggestion.objects.get(
        zpage=page, name="cooking").status == TagSuggestion.PENDING


@pytest.mark.django_db
def test_reuse_itself_refuses_suggestions_for_older_content(creator_factory):
    """The service re-checks under the lock; the command's filter is a read."""
    page = _page(creator_factory())
    _pending(page, "cooking", digest="digest-of-the-previous-version")
    _pending(page, "zcash")

    assert services.apply_pending_suggestions(page) == ["zcash"]
    assert _tags(page) == {"zcash"}


@pytest.mark.django_db
def test_a_re_proposed_pending_suggestion_becomes_current(
    creator_factory, fake_tagger, settings
):
    settings.TAGGING_AUTO_APPLY_BLANK = False
    page = _page(creator_factory())
    _pending(page, "cryptography", digest="older")

    services.suggest_tags_for_zpage(page)

    assert TagSuggestion.objects.get(
        zpage=page, name="cryptography"
    ).source_digest == services.page_digest(page)


@pytest.mark.django_db
def test_backfill_buys_one_pass_for_a_never_suggested_page(
    creator_factory, fake_tagger, settings
):
    # A recent run elsewhere must not debounce the backfill -- force=True.
    page = _page(creator_factory())

    _backfill()

    assert fake_tagger.call_count == 1
    assert _tags(page) == set(AI_TAGS)


@pytest.mark.django_db
def test_backfill_leaves_tagged_drafts_short_and_answered_pages_alone(
    creator_factory, fake_tagger
):
    creator = creator_factory()
    tagged = _page(creator, tags=["mine"])
    _pending(tagged, "zcash")
    draft = _page(creator, published=False)
    _pending(draft, "zcash")
    short = _page(creator, content="hi")
    answered = _page(creator)
    TagSuggestionRun.objects.create(
        zpage=answered, source_digest=services.page_digest(answered))
    TagSuggestion.objects.create(
        zpage=answered, name="nope", status=TagSuggestion.DISMISSED)

    output = _backfill()

    assert fake_tagger.call_count == 0
    assert _tags(tagged) == {"mine"}
    assert _tags(draft) == set()
    assert _tags(short) == set()
    assert _tags(answered) == set()
    assert "skipped_too_short=1" in output
    assert "skipped_already_suggested=1" in output


@pytest.mark.django_db
def test_backfill_is_idempotent_and_honours_limit(creator_factory, fake_tagger):
    creator = creator_factory()
    first, second = _page(creator), _page(creator)

    _backfill("--limit=1")
    assert _tags(first) == set(AI_TAGS) and _tags(second) == set()

    _backfill()
    _backfill()
    assert _tags(second) == set(AI_TAGS)
    assert fake_tagger.call_count == 2


@pytest.mark.django_db
def test_backfill_reclaims_a_claim_whose_process_died(
    creator_factory, fake_tagger
):
    """A kill during the completion leaves the claim behind with nothing
    recorded; the digest gate alone would refuse the page forever."""
    from datetime import timedelta
    from django.utils import timezone

    page = _page(creator_factory())
    run = TagSuggestionRun.objects.create(
        zpage=page, source_digest=services.page_digest(page))
    TagSuggestionRun.objects.filter(pk=run.pk).update(
        created_at=timezone.now() - timedelta(hours=2))

    output = _backfill()

    assert fake_tagger.call_count == 1
    assert _tags(page) == set(AI_TAGS)
    assert "reclaimed_orphan_claim=1" in output


@pytest.mark.django_db
def test_backfill_does_not_reclaim_a_claim_that_may_still_be_running(
    creator_factory, fake_tagger
):
    page = _page(creator_factory())
    TagSuggestionRun.objects.create(
        zpage=page, source_digest=services.page_digest(page))

    output = _backfill()

    assert fake_tagger.call_count == 0
    assert "skipped_already_suggested=1" in output


@pytest.mark.django_db
def test_backfill_stops_on_a_down_provider(creator_factory, mocker):
    from django.core.management.base import CommandError

    tagger = mocker.patch(
        "dj.apps.tagging.services.tag_content",
        side_effect=RuntimeError("provider is down"))
    creator = creator_factory()
    for _ in range(4):
        _page(creator)

    with pytest.raises(CommandError):
        call_command(
            "autotag_untagged_zpages", "--sleep=0", "--max-failures=2",
            stdout=StringIO(), stderr=StringIO())

    assert tagger.call_count == 2
    # Claims were released, so a re-run retries them.
    assert not TagSuggestionRun.objects.exists()
