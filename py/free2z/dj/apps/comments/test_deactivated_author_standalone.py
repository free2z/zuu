"""A deactivated author's standalone converse posts must disappear --.

Standalone posts (``content_type IS NULL``) were the one comment shape with a
hard-coded "always public" answer: the object predicate returned True and the
bulk-list scope included them unconditionally. So deactivating an author took
their zPages down  but left their microblog corpus fully served —
username, avatar, body text and all — on every shared read path:

* ``GET /api/comments/`` (the bulk list),
* the anonymous ConverseFeed RSS (``/feeds/converse/recent.xml``),
* the OG/social crawler card (``/converse/<uuid>``),
* single-comment retrieve and the replies endpoint.

The fix lives once, in the shared visibility module
(``dj.apps.comments.visibility``): the standalone arm requires an active
author. zPage/Conversation comments are deliberately UNCHANGED — there the
*parent* governs visibility, not the comment's own author; that asymmetry is
pinned by ``test_comment_by_deactivated_author_on_visible_page_stays_visible``.

Every test marked regression below FAILS against unfixed main: the control
half of each pair proves the surface serves the post while the author is
active, so a green run on old code is impossible to confuse with a broken
fixture.
"""
import uuid

import pytest

from django.contrib.contenttypes.models import ContentType

from dj.apps.comments.models import Comment
from dj.apps.g12f.models import zPage

pytestmark = pytest.mark.django_db


def _deactivate(creator):
    """Just the flag — the state an admin untick leaves behind."""
    creator.is_active = False
    creator.save(update_fields=['is_active'])


def _standalone(author, content):
    return Comment.objects.create(author=author, content=content, tuzis=1)


@pytest.fixture
def poster(creator_factory):
    """The author whose posts get deactivated mid-test."""
    return creator_factory(username="poster", full_name="Poster Person")


@pytest.fixture
def keeper(creator_factory):
    """An author who stays active throughout."""
    return creator_factory(username="keeper")


# --------------------------------------------------------------------------
# GET /api/comments/ -- the bulk list
# --------------------------------------------------------------------------


def test_bulk_list_hides_deactivated_authors_standalone_posts(
    api_client, poster, keeper,
):
    hidden = _standalone(poster, "UNIQUE-POSTER-BODY soon gone")
    shown = _standalone(keeper, "UNIQUE-KEEPER-BODY stays")

    # Control: both serve while both authors are active.
    resp = api_client.get("/api/comments/")
    assert resp.status_code == 200, resp.content
    returned = {c["uuid"] for c in resp.data["results"]}
    assert str(hidden.uuid) in returned
    assert str(shown.uuid) in returned

    _deactivate(poster)

    resp = api_client.get("/api/comments/")
    assert resp.status_code == 200, resp.content
    returned = {c["uuid"] for c in resp.data["results"]}
    assert str(hidden.uuid) not in returned
    assert str(shown.uuid) in returned
    body = resp.content.decode()
    assert "UNIQUE-POSTER-BODY" not in body
    assert "poster" not in [c.get("author", {}).get("username", "")
                            for c in resp.data["results"]]


def test_retrieve_of_deactivated_authors_post_is_404(
    api_client, poster,
):
    post = _standalone(poster, "retrieve me while you can")
    assert api_client.get(f"/api/comments/{post.uuid}/").status_code == 200

    _deactivate(poster)

    resp = api_client.get(f"/api/comments/{post.uuid}/")
    assert resp.status_code == 404, resp.content
    assert b"retrieve me" not in resp.content


def test_replies_under_deactivated_authors_post_are_404(
    api_client, poster, keeper,
):
    top = _standalone(poster, "thread root")
    Comment.objects.create(
        author=keeper, content="a reply", tuzis=1, parent=top)
    assert api_client.get(
        f"/api/comments/{top.uuid}/replies/").status_code == 200

    _deactivate(poster)

    resp = api_client.get(f"/api/comments/{top.uuid}/replies/")
    assert resp.status_code == 404, resp.content
    assert b"a reply" not in resp.content


# --------------------------------------------------------------------------
# GET /api/comments/{uuid}/replies/ -- replies are scoped, not just the parent
# --------------------------------------------------------------------------


def test_replies_endpoint_hides_deactivated_authors_reply_under_active_post(
    api_client, poster, keeper,
):
    """The parent gate alone is not enough: create() copies the parent's
    content_type/object_id onto a reply, so a reply under a standalone
    converse post has content_type IS NULL and IS itself a standalone post
    . It must vanish from the replies list when its OWN author is
    deactivated — even though the thread root's author stays active and the
    endpoint still 200s."""
    top = _standalone(keeper, "active author thread root")
    gone_reply = Comment.objects.create(
        author=poster, content="UNIQUE-GONE-REPLY body", tuzis=1, parent=top)

    # Control: the reply serves while its author is active.
    resp = api_client.get(f"/api/comments/{top.uuid}/replies/")
    assert resp.status_code == 200, resp.content
    assert str(gone_reply.uuid) in {c["uuid"] for c in resp.data["results"]}

    _deactivate(poster)

    resp = api_client.get(f"/api/comments/{top.uuid}/replies/")
    assert resp.status_code == 200, resp.content
    returned = {c["uuid"] for c in resp.data["results"]}
    assert str(gone_reply.uuid) not in returned
    assert b"UNIQUE-GONE-REPLY" not in resp.content
    assert "poster" not in [
        c.get("author", {}).get("username", "") for c in resp.data["results"]
    ]


def test_replies_endpoint_keeps_active_authors_reply(api_client, keeper):
    """Positive control: an active author's reply is unaffected by the scoping."""
    top = _standalone(keeper, "thread root stays up")
    reply = Comment.objects.create(
        author=keeper, content="STILL-LISTED-REPLY", tuzis=1, parent=top)

    resp = api_client.get(f"/api/comments/{top.uuid}/replies/")
    assert resp.status_code == 200, resp.content
    returned = {c["uuid"] for c in resp.data["results"]}
    assert str(reply.uuid) in returned
    assert b"STILL-LISTED-REPLY" in resp.content


def test_replies_author_filter_cannot_resurface_deactivated_authors_reply(
    api_client, poster, keeper,
):
    """`?author=<username>` narrows the queryset AFTER scoping must have
    applied: it must never turn the hidden reply back into an existence or
    content oracle."""
    top = _standalone(keeper, "filter probe thread root")
    Comment.objects.create(
        author=poster, content="FILTERABLE-GONE-REPLY", tuzis=1, parent=top)

    _deactivate(poster)

    for query in ("?author=poster", "?author=&parent__isnull=0"):
        resp = api_client.get(f"/api/comments/{top.uuid}/replies/{query}")
        assert resp.status_code == 200, resp.content
        assert b"FILTERABLE-GONE-REPLY" not in resp.content
        assert resp.data["results"] == []


# --------------------------------------------------------------------------
# Anonymous ConverseFeed RSS
# --------------------------------------------------------------------------


def test_rss_feed_drops_deactivated_authors_posts(api_client, poster):
    feed_url = "/feeds/converse/recent.xml"
    _standalone(poster, "RSS-SYNDICATED-BODY unique enough to grep")

    resp = api_client.get(feed_url)
    assert resp.status_code == 200, resp.content
    assert "RSS-SYNDICATED-BODY".encode() in resp.content

    _deactivate(poster)

    resp = api_client.get(feed_url)
    assert resp.status_code == 200, resp.content
    assert "RSS-SYNDICATED-BODY".encode() not in resp.content


def test_rss_feed_keeps_active_authors_posts(api_client, keeper):
    _standalone(keeper, "STILL-SYNDICATED-BODY")
    resp = api_client.get("/feeds/converse/recent.xml")
    assert resp.status_code == 200, resp.content
    assert "STILL-SYNDICATED-BODY".encode() in resp.content


# --------------------------------------------------------------------------
# OG / social crawler card
# --------------------------------------------------------------------------


def test_og_card_404s_for_deactivated_authors_post(api_client, poster):
    post = _standalone(poster, "OG-CARD-BODY crawl me")
    card_url = f"/converse/{post.uuid}"

    # Control: the card renders while the author is active.
    ok = api_client.get(card_url)
    assert ok.status_code == 200, ok.content
    assert b"OG-CARD-BODY" in ok.content

    _deactivate(poster)

    gone = api_client.get(card_url)
    assert gone.status_code == 404, gone.content
    assert b"OG-CARD-BODY" not in gone.content
    assert b"Poster Person" not in gone.content
    assert b"poster" not in gone.content


def test_og_card_still_serves_active_authors_post(api_client, keeper):
    post = _standalone(keeper, "ACTIVE-AUTHOR-CARD")
    resp = api_client.get(f"/converse/{post.uuid}")
    assert resp.status_code == 200, resp.content
    assert b"ACTIVE-AUTHOR-CARD" in resp.content


# --------------------------------------------------------------------------
# The asymmetry that must NOT change: parent-governed comments
# --------------------------------------------------------------------------


def test_comment_by_deactivated_author_on_visible_page_stays_visible(
    api_client, keeper, creator_factory,
):
    """zPage/Conversation threads are gated by the PARENT's visibility, not
    the commenter's account state. Deactivating a commenter must not scrub
    their historical remarks off someone else's active public page — only
    their OWN standalone microblog corpus goes away."""
    page_owner = creator_factory(username="pageowner")
    page = zPage.objects.create(
        creator=page_owner,
        title="public page",
        content="body",
        free2zaddr=str(uuid.uuid4()),
        vanity=f"pub-{page_owner.username}",
        is_published=True,
    )
    ct = ContentType.objects.get_for_model(zPage)
    remark = Comment.objects.create(
        author=keeper,
        content="HISTORICAL-REMARK on a visible page",
        tuzis=1,
        content_type=ct,
        object_id=str(page.id),
    )

    # The author of the COMMENT (not the page) gets deactivated.
    _deactivate(keeper)

    resp = api_client.get(f"/api/comments/zpage/{page.free2zaddr}/")
    assert resp.status_code == 200, resp.content
    returned = {c["uuid"] for c in resp.data["results"]}
    assert str(remark.uuid) in returned


def test_comment_search_deindexes_a_deactivated_authors_full_name(
    api_client, creator_factory,
):
    """A historical remark stays public, but its author's hidden real name
    must not remain a way to discover it.

    ``full_name`` is public for an active creator: the public profile and
    creator directory both serialize it, and the creator directory searches
    it. Preserve that product contract here. After deactivation, the same
    remark remains visible because its active zPage parent governs visibility,
    and the public username remains searchable because it is still serialized
    on the remark. Only the now-redacted full name must stop matching.
    """
    page_owner = creator_factory(username="searchpageowner")
    commenter = creator_factory(
        username="searchhistorian",
        full_name="OracleNameOnly1424",
    )
    page = zPage.objects.create(
        creator=page_owner,
        title="public page",
        content="body",
        free2zaddr=str(uuid.uuid4()),
        vanity=f"pub-{page_owner.username}",
        is_published=True,
    )
    remark = Comment.objects.create(
        author=commenter,
        content="A historical remark with no identifying name in its text.",
        tuzis=1,
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=str(page.id),
    )

    # Positive control: active creators publish full_name, so it is a valid
    # search key before the account is deactivated.
    response = api_client.get("/api/comments/?search=OracleNameOnly1424")
    assert response.status_code == 200, response.content
    assert {row["uuid"] for row in response.data["results"]} == {
        str(remark.uuid)
    }

    _deactivate(commenter)

    # The row is deliberately still public and its serialized username remains
    # a valid search key. A zero below therefore cannot pass because some other
    # visibility gate happened to remove the comment.
    response = api_client.get("/api/comments/?search=searchhistorian")
    assert response.status_code == 200, response.content
    assert {row["uuid"] for row in response.data["results"]} == {
        str(remark.uuid)
    }

    response = api_client.get("/api/comments/?search=OracleNameOnly1424")
    assert response.status_code == 200, response.content
    assert response.data["count"] == 0
    assert response.data["results"] == []
