"""``Comment.headline`` is optional end-to-end (issues, ).

Real Postgres, no mocks on the DB — see py/conftest.py.

Before this change ``headline`` was a required ``CharField``, which is why the
new UI hard-coded the sentinel ``"N/A"`` on every comment and reply: the POST
would otherwise 400. That sentinel then leaked into the classic React UI (which
renders ``comment.headline`` as the card title) and into the auto-tweet image
prompts. These tests pin the contract that made the sentinel unnecessary.
"""
import uuid

import pytest

from dj.apps.comments.models import Comment


# --------------------------------------------------------------------------
# API contract: a comment may be posted with no headline at all
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_comment_without_headline(api_client, creator_factory):
    """Omitting the field entirely must succeed and store an empty headline."""
    author = creator_factory()
    api_client.force_authenticate(user=author)

    response = api_client.post(
        "/api/comments/",
        {"content": "no headline needed", "tuzis": 1}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 201, response.content
    assert response.data["headline"] == ""
    assert Comment.objects.get(uuid=response.data["uuid"]).headline == ""


@pytest.mark.django_db
def test_create_comment_with_blank_headline(api_client, creator_factory):
    """An explicit empty string must be accepted (allow_blank), not 400."""
    author = creator_factory()
    api_client.force_authenticate(user=author)

    response = api_client.post(
        "/api/comments/",
        {"headline": "", "content": "blank headline", "tuzis": 1}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 201, response.content
    assert response.data["headline"] == ""


@pytest.mark.django_db
def test_create_reply_without_headline(api_client, creator_factory):
    """Replies go through a different view; they must be headline-free too."""
    author = creator_factory()
    api_client.force_authenticate(user=author)
    parent = Comment.objects.create(
        author=author, headline="", content="parent", tuzis=1
    )

    response = api_client.post(
        f"/api/comments/{parent.uuid}/replies/",
        {"content": "a reply", "tuzis": 1}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 201, response.content
    assert response.data["headline"] == ""


@pytest.mark.django_db
def test_headline_still_accepted_for_conversations(api_client, creator_factory):
    """Converse posts still carry a title — optional must not mean removed."""
    author = creator_factory()
    api_client.force_authenticate(user=author)

    response = api_client.post(
        "/api/comments/",
        {"headline": "A real title", "content": "body", "tuzis": 1}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 201, response.content
    assert response.data["headline"] == "A real title"


@pytest.mark.django_db
def test_headline_max_length_still_enforced(api_client, creator_factory):
    author = creator_factory()
    api_client.force_authenticate(user=author)

    response = api_client.post(
        "/api/comments/",
        {"headline": "x" * 101, "content": "body", "tuzis": 1}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_model_default_is_empty_string(creator_factory):
    """A Comment built without a headline must not end up with NULL/None."""
    comment = Comment.objects.create(
        author=creator_factory(), content="body", tuzis=1
    )
    comment.refresh_from_db()
    assert comment.headline == ""


# --------------------------------------------------------------------------
# The placeholder filter itself. `PLACEHOLDER_HEADLINES` exists only
# because the new UI hard-coded "N/A"; nothing else in py/ renders
# comments/social.html, so these four are the OG card's and the RSS feed's
# only net. One representative case per distinct consequence, not the full
# combination matrix.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_display_headline_is_empty_for_the_sentinel(creator_factory):
    """`<title>N/A</title>` and `og:title="N/A"` are what this prevents."""
    comment = Comment.objects.create(
        author=creator_factory(), headline="N/A", content="body", tuzis=1
    )
    assert comment.display_headline == ""


@pytest.mark.django_db
def test_social_description_truncates_long_content(creator_factory):
    """og:description is capped; an unbounded card body is a broken unfurl."""
    comment = Comment.objects.create(
        author=creator_factory(), headline="", content="w" * 500, tuzis=1
    )
    assert len(comment.social_description) <= 200
    assert comment.social_description.endswith("…")


def test_vote_event_message_names_no_headline():
    """"You voted on  with 5 tuzi" -- the blank was Comment.headline."""
    from dj.apps.events.models import EVENT_TEMPLATES

    message = EVENT_TEMPLATES["VOTE_COMMENT_SENT"]["get_message"](
        type("Ev", (), {"amount": 5})()
    )
    assert message == "You voted on a comment with 5 tuzi"


@pytest.mark.django_db
def test_converse_feed_items_have_a_title(client, creator_factory):
    """/feeds/converse/recent.xml used item.headline -> empty <title>."""
    Comment.objects.create(
        author=creator_factory(),
        headline="",
        content="a comment with no headline at all",
        tuzis=1,
    )

    response = client.get("/feeds/converse/recent.xml")

    assert response.status_code == 200, response.content
    body = response.content.decode()
    assert "<title>a comment with no headline at all</title>" in body
    assert "<title></title>" not in body


@pytest.mark.django_db
def test_user_converse_feed_items_have_a_title(client, creator_factory):
    """UserConverseFeed inherits item_title, so it inherited the bug too."""
    author = creator_factory()
    Comment.objects.create(
        author=author, headline="", content="per-user feed body", tuzis=1
    )

    response = client.get(f"/feeds/{author.username}/converse/recent.xml")

    assert response.status_code == 200, response.content
    body = response.content.decode()
    assert "<title>per-user feed body</title>" in body
    assert "<title></title>" not in body


@pytest.mark.django_db
def test_converse_feed_prefers_a_real_headline(creator_factory, client):
    Comment.objects.create(
        author=creator_factory(),
        headline="A titled conversation",
        content="body text",
        tuzis=1,
    )

    body = client.get("/feeds/converse/recent.xml").content.decode()
    assert "<title>A titled conversation</title>" in body
