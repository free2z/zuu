"""Access-control tests for comment threads (issues  and ).

A comment is only as visible as the thing it is attached to. Before this change
the comments app derived visibility from almost nothing:

* ``ai_conversation`` threads checked *nothing* — a private conversation's thread
  was world-readable and world-writable to anyone holding the UUID;
* ``zpage`` threads checked only for a non-empty ``vanity`` slug, ignoring
  ``is_published`` / ``is_subscriber_only``;
* ``GET /api/comments/`` bulk-returned every comment on the platform;
* replies (``/comments/<uuid>/replies/``) never checked their parent's
  visibility.

Every test here FAILS against ``main`` (see the ``test_*_regression`` markers in
the docstrings). Real Postgres — the DB is never mocked (project rule).
"""
import uuid

import pytest

from django.contrib.contenttypes.models import ContentType

from dj.apps.comments.models import Comment
from dj.apps.comments.serializers import CommentListSerializer
from dj.apps.g12f.models import zPage
from dj.apps.g12f.models.creator import Subscription
from dj.apps.openai.models import AIModel, Conversation

from django.utils import timezone
from datetime import timedelta


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture
def owner(creator_factory):
    return creator_factory(username="owner")


@pytest.fixture
def other(creator_factory):
    return creator_factory(username="other")


@pytest.fixture
def ai_model(db):
    return AIModel.objects.create(
        model="gpt-test",
        display_name="Test Model",
        system_message="be helpful",
        max_tokens=4096,
        is_ga=True,
    )


def _make_zpage(owner, *, published, subscriber_only=False, vanity="pg"):
    # free2zaddr must be a UUID: the comments route is <uuid:uuid>, so a
    # non-UUID addr 404s at routing before the view is even reached.
    return zPage.objects.create(
        creator=owner,
        title="t",
        content="c",
        free2zaddr=str(uuid.uuid4()),
        vanity=f"{vanity}-{owner.username}",
        is_published=published,
        is_subscriber_only=subscriber_only,
    )


def _make_conversation(owner, ai_model, *, is_public, subscriber_only=False):
    return Conversation.objects.create(
        ai_model=ai_model,
        user=owner,
        display_name="chat",
        is_public=is_public,
        is_subscriber_only=subscriber_only,
    )


def _comment_on(parent, author):
    ct = ContentType.objects.get_for_model(type(parent))
    return Comment.objects.create(
        author=author,
        content="a comment",
        tuzis=1,
        content_type=ct,
        object_id=str(parent.id),
    )


def _zpage_list_url(page):
    return f"/api/comments/zpage/{page.free2zaddr}/"


def _thread_access(comment):
    return CommentListSerializer(comment).data["thread_access"]


def _thread_access_owner_id(comment):
    return CommentListSerializer(comment).data["thread_access_owner_id"]


@pytest.mark.django_db
def test_comment_serializer_reports_public_thread_access(owner):
    standalone = Comment.objects.create(author=owner, content="post")
    public_page = _make_zpage(owner, published=True)
    page_comment = _comment_on(public_page, owner)

    assert _thread_access(standalone) == "public"
    assert _thread_access(page_comment) == "public"


@pytest.mark.django_db
def test_comment_serializer_reports_members_thread_access(owner):
    page = _make_zpage(owner, published=True, subscriber_only=True)

    assert _thread_access(_comment_on(page, owner)) == "members"


@pytest.mark.django_db
def test_comment_serializer_reports_zpage_owner_not_comment_author(
    owner, other
):
    page = _make_zpage(owner, published=True, subscriber_only=True)

    assert _thread_access_owner_id(_comment_on(page, other)) == owner.id


@pytest.mark.django_db
def test_comment_serializer_reports_no_media_owner_for_standalone_or_ai(
    owner, ai_model
):
    standalone = Comment.objects.create(author=owner, content="post")
    conversation = _make_conversation(owner, ai_model, is_public=True)

    assert _thread_access_owner_id(standalone) is None
    assert _thread_access_owner_id(_comment_on(conversation, owner)) is None


@pytest.mark.django_db
def test_comment_serializer_reports_private_thread_access(
    owner, ai_model
):
    draft = _make_zpage(owner, published=False)
    private_conversation = _make_conversation(
        owner, ai_model, is_public=False
    )

    assert _thread_access(_comment_on(draft, owner)) == "private"
    assert _thread_access(_comment_on(private_conversation, owner)) == "private"


@pytest.mark.django_db
def test_zpage_comment_url_escapes_a_reserved_creator_namespace(
    api_client,
    creator_factory,
):
    page_owner = creator_factory(username="api")
    commenter = creator_factory()
    page = _make_zpage(page_owner, published=True, vanity="comment-page")
    comment = _comment_on(page, commenter)
    reply = Comment.objects.create(
        author=commenter,
        content="a reply",
        parent=comment,
        content_type=comment.content_type,
        object_id=comment.object_id,
    )

    legacy_url = CommentListSerializer(comment).data["content_url"]
    legacy_response = api_client.get(_zpage_list_url(page))
    unknown_revision_response = api_client.get(
        _zpage_list_url(page),
        HTTP_X_FREE2Z_CANONICAL_CONTENT_URL="true",
    )
    response = api_client.get(
        _zpage_list_url(page),
        HTTP_X_FREE2Z_CANONICAL_CONTENT_URL="1",
    )
    assert legacy_response.status_code == 200
    assert response.status_code == 200
    assert (
        legacy_response.json()["results"][0]["content_url"]
        == page.get_url()
    )
    assert unknown_revision_response.status_code == 200
    assert (
        unknown_revision_response.json()["results"][0]["content_url"]
        == page.get_url()
    )
    content_url = response.json()["results"][0]["content_url"]

    assert legacy_url == page.get_url()
    assert content_url == f"/article/{page.free2zaddr}"
    assert content_url == page.get_public_url()
    assert content_url != page.get_url()
    assert "X-Free2Z-Canonical-Content-URL" in legacy_response["Vary"]
    assert "X-Free2Z-Canonical-Content-URL" in response["Vary"]

    for url, response_key, expected_uuid in (
        ("/api/comments/", "results", None),
        (f"/api/comments/{comment.uuid}/", None, comment.uuid),
        (f"/api/comments/{comment.uuid}/replies/", "results", reply.uuid),
    ):
        route_response = api_client.get(
            url,
            HTTP_X_FREE2Z_CANONICAL_CONTENT_URL="1",
        )
        assert route_response.status_code == 200
        payload = route_response.json()
        item = payload[response_key][0] if response_key else payload
        if expected_uuid:
            assert item["uuid"] == str(expected_uuid)
        assert item["content_url"] == page.get_public_url()
        assert "X-Free2Z-Canonical-Content-URL" in route_response["Vary"]

    preflight = api_client.options(
        _zpage_list_url(page),
        HTTP_ORIGIN="http://localhost:3000",
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS=(
            "x-free2z-canonical-content-url"
        ),
    )
    assert preflight.status_code == 200
    assert "x-free2z-canonical-content-url" in preflight[
        "Access-Control-Allow-Headers"
    ].lower()


def _conv_list_url(conv):
    return f"/api/comments/ai_conversation/{conv.id}/"


# --------------------------------------------------------------------------
#  ai_conversation thread
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_private_conversation_thread_hidden_from_other_user(
    api_client, owner, other, ai_model
):
    """: a non-owner must not read the thread on a PRIVATE conversation."""
    conv = _make_conversation(owner, ai_model, is_public=False)
    _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get(_conv_list_url(conv))
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_private_conversation_thread_hidden_from_anonymous(
    api_client, owner, ai_model
):
    conv = _make_conversation(owner, ai_model, is_public=False)
    _comment_on(conv, owner)

    resp = api_client.get(_conv_list_url(conv))
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_other_user_cannot_post_to_private_conversation_thread(
    api_client, owner, other, ai_model
):
    """: a non-owner must not WRITE a comment onto a private conversation."""
    conv = _make_conversation(owner, ai_model, is_public=False)

    api_client.force_authenticate(user=other)
    resp = api_client.post(
        _conv_list_url(conv),
        {"content": "sneaky", "tuzis": 1},
        format="json",
    )
    assert resp.status_code == 404, resp.content
    assert not Comment.objects.filter(author=other).exists()


@pytest.mark.django_db
def test_owner_can_read_and_post_on_own_private_conversation(
    api_client, owner, ai_model
):
    """Owner keeps full access to their own conversation's thread."""
    conv = _make_conversation(owner, ai_model, is_public=False)

    api_client.force_authenticate(user=owner)
    read = api_client.get(_conv_list_url(conv))
    assert read.status_code == 200, read.content

    post = api_client.post(
        _conv_list_url(conv),
        {"content": "mine", "tuzis": 1},
        format="json",
    )
    assert post.status_code == 201, post.content


@pytest.mark.django_db
def test_public_conversation_thread_readable_by_anyone(
    api_client, owner, other, ai_model
):
    """A PUBLIC conversation's thread stays readable to everyone."""
    conv = _make_conversation(owner, ai_model, is_public=True)
    _comment_on(conv, owner)

    resp = api_client.get(_conv_list_url(conv))
    assert resp.status_code == 200, resp.content
    assert resp.data["count"] == 1


# --------------------------------------------------------------------------
#  zpage thread publication / paywall
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_unpublished_zpage_thread_hidden_from_other(api_client, owner, other):
    page = _make_zpage(owner, published=False)
    _comment_on(page, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get(_zpage_list_url(page))
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_unpublished_zpage_thread_hidden_from_anonymous(api_client, owner):
    page = _make_zpage(owner, published=False)
    _comment_on(page, owner)

    resp = api_client.get(_zpage_list_url(page))
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_other_cannot_post_on_unpublished_zpage(api_client, owner, other):
    page = _make_zpage(owner, published=False)

    api_client.force_authenticate(user=other)
    resp = api_client.post(
        _zpage_list_url(page),
        {"content": "leak", "tuzis": 1},
        format="json",
    )
    assert resp.status_code == 404, resp.content
    assert not Comment.objects.filter(author=other).exists()


@pytest.mark.django_db
def test_subscriber_only_zpage_thread_hidden_from_nonsubscriber(
    api_client, owner, other
):
    page = _make_zpage(owner, published=True, subscriber_only=True)
    _comment_on(page, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get(_zpage_list_url(page))
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_subscriber_only_zpage_thread_visible_to_subscriber(
    api_client, owner, other
):
    page = _make_zpage(owner, published=True, subscriber_only=True)
    _comment_on(page, owner)
    Subscription.objects.create(
        star=owner, fan=other, expires=timezone.now() + timedelta(days=30)
    )

    api_client.force_authenticate(user=other)
    resp = api_client.get(_zpage_list_url(page))
    assert resp.status_code == 200, resp.content
    assert resp.data["count"] == 1


@pytest.mark.django_db
def test_published_public_zpage_thread_readable_by_anonymous(api_client, owner):
    """Legitimate behavior preserved: public pages show threads to anyone."""
    page = _make_zpage(owner, published=True)
    _comment_on(page, owner)

    resp = api_client.get(_zpage_list_url(page))
    assert resp.status_code == 200, resp.content
    assert resp.data["count"] == 1


@pytest.mark.django_db
def test_owner_sees_own_unpublished_zpage_thread(api_client, owner):
    page = _make_zpage(owner, published=False)
    _comment_on(page, owner)

    api_client.force_authenticate(user=owner)
    resp = api_client.get(_zpage_list_url(page))
    assert resp.status_code == 200, resp.content


# --------------------------------------------------------------------------
#  bulk list GET /api/comments/
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_bulk_list_excludes_hidden_parents(api_client, owner, other, ai_model):
    """The corpus list must not leak comments on hidden parents."""
    public_page = _make_zpage(owner, published=True, vanity="pub")
    draft = _make_zpage(owner, published=False, vanity="draft")
    subonly = _make_zpage(owner, published=True, subscriber_only=True, vanity="sub")
    private_conv = _make_conversation(owner, ai_model, is_public=False)

    c_public = _comment_on(public_page, owner)
    _comment_on(draft, owner)
    _comment_on(subonly, owner)
    _comment_on(private_conv, owner)
    # A standalone converse post (no parent) — always public.
    converse = Comment.objects.create(author=owner, content="hi", tuzis=1)

    resp = api_client.get("/api/comments/")
    assert resp.status_code == 200, resp.content
    returned = {c["uuid"] for c in resp.data["results"]}
    assert str(c_public.uuid) in returned
    assert str(converse.uuid) in returned
    assert len(returned) == 2


@pytest.mark.django_db
def test_bulk_list_owner_sees_own_hidden_parents(api_client, owner, ai_model):
    draft = _make_zpage(owner, published=False, vanity="draft")
    private_conv = _make_conversation(owner, ai_model, is_public=False)
    _comment_on(draft, owner)
    _comment_on(private_conv, owner)

    api_client.force_authenticate(user=owner)
    resp = api_client.get("/api/comments/")
    assert resp.status_code == 200, resp.content
    assert resp.data["count"] == 2


# --------------------------------------------------------------------------
#  retrieve a single comment
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_retrieve_comment_on_private_conversation_404(
    api_client, owner, other, ai_model
):
    conv = _make_conversation(owner, ai_model, is_public=False)
    c = _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get(f"/api/comments/{c.uuid}/")
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_retrieve_comment_on_public_zpage_ok(api_client, owner):
    page = _make_zpage(owner, published=True)
    c = _comment_on(page, owner)

    resp = api_client.get(f"/api/comments/{c.uuid}/")
    assert resp.status_code == 200, resp.content


# --------------------------------------------------------------------------
#  replies under a hidden parent
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_replies_under_private_conversation_hidden(
    api_client, owner, other, ai_model
):
    conv = _make_conversation(owner, ai_model, is_public=False)
    top = _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get(f"/api/comments/{top.uuid}/replies/")
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_reply_injection_into_private_conversation_blocked(
    api_client, owner, other, ai_model
):
    conv = _make_conversation(owner, ai_model, is_public=False)
    top = _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.post(
        f"/api/comments/{top.uuid}/replies/",
        {"content": "sneaky reply", "tuzis": 1},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert resp.status_code == 404, resp.content
    assert not Comment.objects.filter(author=other).exists()


@pytest.mark.django_db
def test_replies_on_public_zpage_thread_ok(api_client, owner):
    page = _make_zpage(owner, published=True)
    top = _comment_on(page, owner)

    resp = api_client.get(f"/api/comments/{top.uuid}/replies/")
    assert resp.status_code == 200, resp.content


@pytest.mark.django_db
def test_replies_on_standalone_converse_post_ok(api_client, owner):
    """Replies on a parentless converse post stay public."""
    top = Comment.objects.create(author=owner, content="hi", tuzis=1)

    resp = api_client.get(f"/api/comments/{top.uuid}/replies/")
    assert resp.status_code == 200, resp.content


# --------------------------------------------------------------------------
# Codex review follow-ups: vote, deleted parent, tagging autocomplete
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_vote_on_comment_with_hidden_parent_blocked(
    api_client, owner, other, ai_model
):
    """A 2Z vote must not reach a comment on a private conversation."""
    conv = _make_conversation(owner, ai_model, is_public=False)
    c = _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.post(
        f"/api/comments/{c.uuid}/vote/", {"vote": "up"}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_vote_on_public_comment_ok(api_client, owner, other):
    page = _make_zpage(owner, published=True)
    c = _comment_on(page, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.post(
        f"/api/comments/{c.uuid}/vote/", {"vote": "up"}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert resp.status_code == 200, resp.content


@pytest.mark.django_db
def test_deleted_parent_fails_closed(api_client, owner, ai_model):
    """A stale generic pointer (parent row deleted) must not read as public.

    Deleting the Conversation leaves the comment with a non-null content_type
    and a now-dangling object_id, so content_object resolves to None. That must
    fail closed, not be mistaken for a parentless (public) converse post.
    """
    conv = _make_conversation(owner, ai_model, is_public=True)
    top = _comment_on(conv, owner)
    conv.delete()
    top.refresh_from_db()
    assert top.content_type_id is not None
    assert top.content_object is None

    resp = api_client.get(f"/api/comments/{top.uuid}/replies/")
    assert resp.status_code == 404, resp.content


# --------------------------------------------------------------------------
#  subscriber-only AI conversation thread (regression from /)
#
#  (Closes ) made `Conversation.is_subscriber_only` a real, enforced
# read tier for the conversation transcript, but the comment thread under it
# was still gated on `is_public` alone -- so a public-but-subscriber-only
# conversation's comments stayed world-readable/writable to non-subscribers.
# Every test below FAILS against `main` (3ac64f3a) and passes with the fix.
# --------------------------------------------------------------------------


def _subscribe(fan, star, *, days=30):
    return Subscription.objects.create(
        star=star, fan=fan, expires=timezone.now() + timedelta(days=days)
    )


@pytest.mark.django_db
def test_subscriber_only_conversation_thread_hidden_from_anonymous(
    api_client, owner, ai_model
):
    """: anonymous must not read the thread on a subscriber-only conv."""
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    _comment_on(conv, owner)

    resp = api_client.get(_conv_list_url(conv))
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_subscriber_only_conversation_thread_hidden_from_nonsubscriber(
    api_client, owner, other, ai_model
):
    """: a logged-in non-subscriber must not read the thread."""
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get(_conv_list_url(conv))
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_subscriber_only_conversation_thread_hidden_from_expired_subscriber(
    api_client, owner, other, ai_model
):
    """: an expired/cancelled subscription does not grant access."""
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    _comment_on(conv, owner)
    _subscribe(other, owner, days=-1)  # expired yesterday

    api_client.force_authenticate(user=other)
    resp = api_client.get(_conv_list_url(conv))
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_subscriber_only_conversation_thread_visible_to_active_subscriber(
    api_client, owner, other, ai_model
):
    """: an active subscriber of the creator DOES see the thread."""
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    _comment_on(conv, owner)
    _subscribe(other, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get(_conv_list_url(conv))
    assert resp.status_code == 200, resp.content
    assert resp.data["count"] == 1


@pytest.mark.django_db
def test_owner_sees_own_subscriber_only_conversation_thread(
    api_client, owner, ai_model
):
    """The owner always sees (and can post to) their own thread."""
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    _comment_on(conv, owner)

    api_client.force_authenticate(user=owner)
    read = api_client.get(_conv_list_url(conv))
    assert read.status_code == 200, read.content

    post = api_client.post(
        _conv_list_url(conv),
        {"content": "mine", "tuzis": 1},
        format="json",
    )
    assert post.status_code == 201, post.content


@pytest.mark.django_db
def test_nonsubscriber_cannot_post_to_subscriber_only_conversation_thread(
    api_client, owner, other, ai_model
):
    """: a non-subscriber must not WRITE into the paywalled thread."""
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )

    api_client.force_authenticate(user=other)
    resp = api_client.post(
        _conv_list_url(conv),
        {"content": "sneaky", "tuzis": 1},
        format="json",
    )
    assert resp.status_code == 404, resp.content
    assert not Comment.objects.filter(author=other).exists()


@pytest.mark.django_db
def test_bulk_list_excludes_subscriber_only_conversation_for_nonsubscriber(
    api_client, owner, other, ai_model
):
    """GET /api/comments/ must not leak a subscriber-only conv's comment."""
    subonly = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    _comment_on(subonly, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get("/api/comments/")
    assert resp.status_code == 200, resp.content
    assert resp.data["count"] == 0


@pytest.mark.django_db
def test_bulk_list_includes_subscriber_only_conversation_for_subscriber(
    api_client, owner, other, ai_model
):
    subonly = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    c = _comment_on(subonly, owner)
    _subscribe(other, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get("/api/comments/")
    assert resp.status_code == 200, resp.content
    returned = {row["uuid"] for row in resp.data["results"]}
    assert str(c.uuid) in returned


@pytest.mark.django_db
def test_retrieve_comment_on_subscriber_only_conversation_404_for_nonsubscriber(
    api_client, owner, other, ai_model
):
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    c = _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get(f"/api/comments/{c.uuid}/")
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_replies_under_subscriber_only_conversation_hidden_from_nonsubscriber(
    api_client, owner, other, ai_model
):
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    top = _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.get(f"/api/comments/{top.uuid}/replies/")
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_reply_injection_into_subscriber_only_conversation_blocked(
    api_client, owner, other, ai_model
):
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    top = _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.post(
        f"/api/comments/{top.uuid}/replies/",
        {"content": "sneaky reply", "tuzis": 1},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert resp.status_code == 404, resp.content
    assert not Comment.objects.filter(author=other).exists()


@pytest.mark.django_db
def test_vote_on_comment_in_subscriber_only_conversation_blocked(
    api_client, owner, other, ai_model
):
    """: a 2Z vote must not reach a comment in a paywalled thread."""
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    c = _comment_on(conv, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.post(
        f"/api/comments/{c.uuid}/vote/", {"vote": "up"}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert resp.status_code == 404, resp.content


@pytest.mark.django_db
def test_vote_on_comment_in_subscriber_only_conversation_ok_for_subscriber(
    api_client, owner, other, ai_model
):
    conv = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    c = _comment_on(conv, owner)
    _subscribe(other, owner)

    api_client.force_authenticate(user=other)
    resp = api_client.post(
        f"/api/comments/{c.uuid}/vote/", {"vote": "up"}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert resp.status_code == 200, resp.content


@pytest.mark.django_db
def test_rss_feed_excludes_subscriber_only_conversation_comment(
    api_client, owner, ai_model
):
    """The anonymous RSS feed must not republish a paywalled thread's comment."""
    subonly = _make_conversation(
        owner, ai_model, is_public=True, subscriber_only=True
    )
    hidden = _comment_on(subonly, owner)

    resp = api_client.get("/feeds/converse/recent.xml")
    assert resp.status_code == 200, resp.content
    assert hidden.content.encode() not in resp.content


@pytest.mark.django_db
def test_tagging_autocomplete_hides_private_only_tags(
    api_client, owner, other, ai_model
):
    """Public tag autocomplete must not surface tags used only on hidden parents."""
    private_conv = _make_conversation(owner, ai_model, is_public=False)
    public_page = _make_zpage(owner, published=True)

    hidden = _comment_on(private_conv, owner)
    hidden.tags.add("secrettag")
    shown = _comment_on(public_page, owner)
    shown.tags.add("publictag")

    resp = api_client.get("/api/tagging/autocomplete?type=comment")
    assert resp.status_code == 200, resp.content
    names = {t["name"] for t in resp.json()}
    assert "publictag" in names
    assert "secrettag" not in names
