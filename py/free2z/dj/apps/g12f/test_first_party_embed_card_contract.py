"""The API contract a first-party embed CARD relies on ( part 2).

`::embed[https://free2z.cash/<user>/<vanity>]` and
`::embed[https://free2z.cash/converse/<uuid>]` render as a text card built by
the SvelteKit loader from exactly two calls, made with the READER's cookie:

    GET /api/zpage/<identifier>/     (the call the zPage route makes)
    GET /api/comments/<uuid>/        (the call the converse route makes)

The frontend builds a card only from a ``200`` whose body is the full object —
never from a 404 and never from the ``{show_modal, page}`` subscriber upsell
(``ts/svelte/free2z/src/lib/utils/first-party-embed-cards.ts``). Everything
else is one neutral link card. So the security of the card is exactly the
visibility of these two endpoints, per reader, and this file pins it as a
matrix: every gated state x every kind of reader, against the real database.

If one of these rows changes, an embed card starts showing (or stops showing)
something to someone — which is why the matrix lives next to the thing it
constrains rather than being inferred from tests written for other reasons.
"""
import uuid

import pytest
from django.contrib.contenttypes.models import ContentType
from django.utils import timezone

from dj.apps.comments.models import Comment
from dj.apps.g12f.models import zPage
from dj.apps.g12f.models.creator import Subscription


CARD = "card"
NEUTRAL = "neutral"

BODY = "EMBED-CARD-SECRET-BODY"
COMMENT_BODY = "EMBED-CARD-SECRET-COMMENT"


# The only 404 bodies the two card reads produce: the zPage view's own and
# DRF's `get_object_or_404` on the comment. Not the resolver's HTML page.
VIEW_NOT_FOUND = (
    {"detail": "Not found."},
    {"detail": "No Comment matches the given query."},
)


def _card_decision(response):
    """The frontend's rule (zpageCardFromApi / converseCardFromApi), restated
    over the wire: a card only from a 200 carrying the full, ungated object.

    The frontend does treat every non-200 as neutral, but THIS contract only
    has two legitimate neutral answers -- the view's own JSON 404 and the 200
    upsell -- and anything else is a failure, not a neutral row. With
    ``!= 200 -> NEUTRAL`` a 500, a 400 or the URL resolver's HTML 404 for a
    deleted route satisfied every NEUTRAL row in both matrices.
    """
    if response.status_code == 404:
        assert response.get("Content-Type", "").startswith(
            "application/json"
        ) and response.json() in VIEW_NOT_FOUND, (
            f"not the view's own 404: {response.content[:200]!r}"
        )
        return NEUTRAL
    assert response.status_code == 200, (
        f"a card read answered neither 200 nor the view's 404: "
        f"{response.status_code} {response.content[:200]!r}"
    )
    body = response.json()
    if "show_modal" in body or "page" in body:
        return NEUTRAL
    return CARD


def _page(creator, **kwargs):
    kwargs.setdefault("vanity", f"embed-{uuid.uuid4().hex[:12]}")
    kwargs.setdefault("title", "Embedded title")
    kwargs.setdefault("content", BODY)
    kwargs.setdefault("is_published", True)
    return zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), **kwargs
    )


@pytest.fixture
def world(creator_factory):
    owner = creator_factory()
    stranger = creator_factory()
    subscriber = creator_factory()
    Subscription.objects.create(
        fan=subscriber, star=owner,
        expires=timezone.now() + timezone.timedelta(days=30),
    )
    return {"owner": owner, "stranger": stranger, "subscriber": subscriber}


def _as(api_client, world, reader):
    if reader != "anon":
        api_client.force_authenticate(world[reader])
    return api_client


def _make_state(world, state):
    owner = world["owner"]
    if state == "public":
        return _page(owner)
    if state == "draft":
        return _page(owner, is_published=False)
    if state == "subscriber_only":
        return _page(owner, is_subscriber_only=True)
    if state == "deactivated_creator":
        page = _page(owner)
        owner.is_active = False
        owner.save(update_fields=["is_active"])
        return page
    if state == "deleted":
        page = _page(owner)
        vanity, addr = page.vanity, page.free2zaddr
        page.delete()
        return zPage(vanity=vanity, free2zaddr=addr)
    raise AssertionError(state)


# (state, reader) -> what the embed shows that reader. The owner of a
# deactivated account is omitted: Django refuses to authenticate an inactive
# user, so that reader cannot exist outside `force_authenticate`.
ZPAGE_MATRIX = [
    ("public", "anon", CARD),
    ("public", "stranger", CARD),
    ("public", "subscriber", CARD),
    ("public", "owner", CARD),
    ("draft", "anon", NEUTRAL),
    ("draft", "stranger", NEUTRAL),
    ("draft", "subscriber", NEUTRAL),
    ("draft", "owner", CARD),
    ("subscriber_only", "anon", NEUTRAL),
    ("subscriber_only", "stranger", NEUTRAL),
    ("subscriber_only", "subscriber", CARD),
    ("subscriber_only", "owner", CARD),
    ("deactivated_creator", "anon", NEUTRAL),
    ("deactivated_creator", "stranger", NEUTRAL),
    ("deactivated_creator", "subscriber", NEUTRAL),
    ("deleted", "anon", NEUTRAL),
    ("deleted", "stranger", NEUTRAL),
    ("deleted", "subscriber", NEUTRAL),
    ("deleted", "owner", NEUTRAL),
]


@pytest.mark.django_db
@pytest.mark.parametrize("state,reader,expected", ZPAGE_MATRIX)
def test_zpage_card_matrix(api_client, world, state, reader, expected):
    page = _make_state(world, state)
    client = _as(api_client, world, reader)
    # Both identifier spellings the classifier can produce: the pretty
    # `/<user>/<vanity>` shape and the `/article/<free2zaddr>` fallback.
    for identifier in (page.vanity, page.free2zaddr):
        response = client.get(f"/api/zpage/{identifier}/", {"lang": "en"})
        assert _card_decision(response) == expected, (state, reader, identifier)
        if expected == NEUTRAL:
            # Neutral must mean the body never arrived either — the upsell
            # is redacted, a 404 carries nothing.
            assert BODY.encode() not in response.content, (state, reader)


@pytest.mark.django_db
def test_neutral_answers_do_not_distinguish_draft_from_nonexistent(
    api_client, world
):
    """The embed must not become an existence oracle: a stranger's view of a
    draft and of an identifier that never existed is the same status and the
    same body, so the card (and its absence) says nothing a visit would not."""
    draft = _page(world["owner"], is_published=False)
    client = _as(api_client, world, "stranger")
    hidden = client.get(f"/api/zpage/{draft.vanity}/")
    missing = client.get(f"/api/zpage/never-existed-{uuid.uuid4().hex[:8]}/")
    assert hidden.status_code == missing.status_code == 404
    assert hidden.json() == missing.json()


def _comment_on(page_or_none, author, **kwargs):
    kwargs.setdefault("content", COMMENT_BODY)
    if page_or_none is None:
        return Comment.objects.create(author=author, tuzis=1, **kwargs)
    return Comment.objects.create(
        author=author,
        tuzis=1,
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page_or_none.pk,
        **kwargs,
    )


COMMENT_MATRIX = [
    # A comment is exactly as visible as the page it is attached to.
    ("public", "anon", CARD),
    ("public", "stranger", CARD),
    ("public", "subscriber", CARD),
    ("public", "owner", CARD),
    ("draft", "anon", NEUTRAL),
    ("draft", "stranger", NEUTRAL),
    ("draft", "subscriber", NEUTRAL),
    ("draft", "owner", CARD),
    ("subscriber_only", "anon", NEUTRAL),
    ("subscriber_only", "stranger", NEUTRAL),
    ("subscriber_only", "subscriber", CARD),
    ("subscriber_only", "owner", CARD),
    ("deactivated_creator", "anon", NEUTRAL),
    ("deactivated_creator", "stranger", NEUTRAL),
    ("deactivated_creator", "subscriber", NEUTRAL),
]


@pytest.mark.django_db
@pytest.mark.parametrize("state,reader,expected", COMMENT_MATRIX)
def test_comment_card_matrix(
    api_client, world, creator_factory, state, reader, expected
):
    commenter = creator_factory()
    # Build the page BEFORE any deactivation so the comment can attach to it.
    page = _page(world["owner"])
    comment = _comment_on(page, commenter)
    if state == "draft":
        zPage.objects.filter(pk=page.pk).update(is_published=False)
    elif state == "subscriber_only":
        zPage.objects.filter(pk=page.pk).update(is_subscriber_only=True)
    elif state == "deactivated_creator":
        world["owner"].is_active = False
        world["owner"].save(update_fields=["is_active"])

    client = _as(api_client, world, reader)
    response = client.get(f"/api/comments/{comment.uuid}/")
    assert _card_decision(response) == expected, (state, reader)
    if expected == NEUTRAL:
        assert COMMENT_BODY.encode() not in response.content


@pytest.mark.django_db
@pytest.mark.parametrize("reader", ["anon", "stranger", "subscriber", "owner"])
def test_standalone_converse_post_matrix(api_client, world, reader):
    """A top-level converse post is public while its author is active, and a
    neutral card for everyone once the author is deactivated or it is gone."""
    post = _comment_on(None, world["owner"])
    client = _as(api_client, world, reader)
    assert _card_decision(client.get(f"/api/comments/{post.uuid}/")) == CARD

    post_uuid = post.uuid
    post.delete()
    deleted = client.get(f"/api/comments/{post_uuid}/")
    assert _card_decision(deleted) == NEUTRAL
    assert COMMENT_BODY.encode() not in deleted.content


@pytest.mark.django_db
@pytest.mark.parametrize("reader", ["anon", "stranger", "subscriber"])
def test_converse_post_by_deactivated_author(
    api_client, world, creator_factory, reader
):
    author = creator_factory()
    post = _comment_on(None, author)
    author.is_active = False
    author.save(update_fields=["is_active"])
    client = _as(api_client, world, reader)
    response = client.get(f"/api/comments/{post.uuid}/")
    assert _card_decision(response) == NEUTRAL
    assert COMMENT_BODY.encode() not in response.content


@pytest.mark.django_db
def test_card_reads_have_no_side_effects(api_client, world):
    """A card is resolved on every render of every article that embeds the
    page, so the read it uses must not count, charge or notify anything."""
    page = _page(world["owner"])
    before = zPage.objects.values().get(pk=page.pk)
    for _ in range(3):
        api_client.get(f"/api/zpage/{page.vanity}/", {"lang": "en"})
    after = zPage.objects.values().get(pk=page.pk)
    assert before == after
