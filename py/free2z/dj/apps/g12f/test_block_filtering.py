"""A block stops the blocked account's content reaching the blocker.

Every surface here is driven through the real API with a block created the
way the client creates it (PUT /api/creator/{username}/block/), and each one
is checked from three seats: the blocker (filtered), the blocked account
(unchanged -- it is told nothing), and a bystander (unchanged).
"""
import uuid
from decimal import Decimal

import pytest
from django.contrib.contenttypes.models import ContentType
from rest_framework.test import APIClient

from dj.apps.comments.models import Comment
from dj.apps.e2ee.models import ChatRequest
from dj.apps.events.models import Event
from dj.apps.g12f.blocks import event_hidden_by_block
from dj.apps.g12f.models import Creator, CreatorBlock, zPage

pytestmark = pytest.mark.django_db


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    return client


def page_for(creator, vanity):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=vanity,
        title=f"Title {vanity}",
        content="Some content.",
        is_published=True,
    )


def comment_on(page, author, content, parent=None):
    return Comment.objects.create(
        author=author,
        content=content,
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=str(page.pk),
        parent=parent,
    )


def contents(response):
    assert response.status_code == 200, response.content
    return sorted(row["content"] for row in response.json()["results"])


@pytest.fixture
def trio(creator_factory):
    blocker = creator_factory(username="blocker_b", tuzis=Decimal("10"))
    blocked = creator_factory(username="blocked_x", tuzis=Decimal("10"))
    bystander = creator_factory(username="bystander_y", tuzis=Decimal("10"))
    response = client_for(blocker).put(f"/api/creator/{blocked.username}/block/")
    assert response.status_code == 200, response.content
    assert response.json() == {"username": blocked.username, "active": True}
    return blocker, blocked, bystander


def test_comment_thread_hides_the_blocked_author_from_the_blocker_only(trio):
    blocker, blocked, bystander = trio
    page = page_for(bystander, "thread")
    comment_on(page, blocked, "from blocked")
    comment_on(page, bystander, "from bystander")
    url = f"/api/comments/zpage/{page.free2zaddr}/"

    assert contents(client_for(blocker).get(url)) == ["from bystander"]
    both = ["from blocked", "from bystander"]
    assert contents(client_for(blocked).get(url)) == both
    assert contents(client_for(bystander).get(url)) == both
    assert contents(APIClient().get(url)) == both


def test_reply_list_and_bulk_list_hide_the_blocked_author(trio):
    blocker, blocked, bystander = trio
    page = page_for(bystander, "replies")
    parent = comment_on(page, bystander, "parent")
    comment_on(page, blocked, "blocked reply", parent=parent)
    comment_on(page, bystander, "bystander reply", parent=parent)

    replies = f"/api/comments/{parent.uuid}/replies/"
    assert contents(client_for(blocker).get(replies)) == ["bystander reply"]
    assert contents(client_for(bystander).get(replies)) == [
        "blocked reply", "bystander reply"]

    bulk = client_for(blocker).get("/api/comments/")
    assert "blocked reply" not in contents(bulk)
    assert "blocked reply" in contents(client_for(bystander).get("/api/comments/"))


def test_a_comment_opened_by_link_still_resolves_for_the_blocker(trio):
    blocker, blocked, bystander = trio
    page = page_for(bystander, "direct")
    comment = comment_on(page, blocked, "linked")
    response = client_for(blocker).get(f"/api/comments/{comment.uuid}/")
    assert response.status_code == 200
    assert response.json()["content"] == "linked"


def test_zpage_lists_hide_the_blocked_creator_from_the_blocker(trio):
    blocker, blocked, bystander = trio
    page_for(blocked, "blocked-page")
    page_for(bystander, "bystander-page")

    def vanities(client, query=""):
        response = client.get(f"/api/zpage/{query}")
        assert response.status_code == 200, response.content
        return sorted(row["vanity"] for row in response.json()["results"])

    assert vanities(client_for(blocker)) == ["bystander-page"]
    assert vanities(client_for(blocker), f"?username={blocked.username}") == []
    assert vanities(client_for(bystander)) == ["blocked-page", "bystander-page"]
    assert vanities(APIClient()) == ["blocked-page", "bystander-page"]
    # The blocked account's own dashboard is untouched by anyone's block.
    assert vanities(client_for(blocked), "?mine=true") == ["blocked-page"]


def test_unblock_restores_every_list(trio):
    blocker, blocked, bystander = trio
    page = page_for(bystander, "restore")
    comment_on(page, blocked, "back again")
    client = client_for(blocker)
    assert contents(client.get(f"/api/comments/zpage/{page.free2zaddr}/")) == []

    response = client.delete(f"/api/creator/{blocked.username}/block/")
    assert response.json() == {"username": blocked.username, "active": False}
    assert contents(client.get(f"/api/comments/zpage/{page.free2zaddr}/")) == [
        "back again"]


def test_notifications_hide_contact_but_keep_money_receipts(trio):
    blocker, blocked, bystander = trio
    page = page_for(blocker, "notified")
    reply = Event.objects.create(
        type="NEW_REPLY", receiving_user=blocker, contributor=blocked,
        content_object=comment_on(page, blocked, "hi"),
    )
    mention = Event.objects.create(
        type="PAGE_MENTION", receiving_user=blocker, contributor=blocked,
        content_object=page,
    )
    donation = Event.objects.create(
        type="DONATION_RECEIVED", receiving_user=blocker, contributor=blocked,
        payee=blocker, amount=Decimal("1"),
    )
    page_vote = Event.objects.create(
        type="PAGE_VOTE", receiving_user=blocker, contributor=blocked,
        content_object=page, amount=Decimal("1"),
    )
    other = Event.objects.create(
        type="NEW_REPLY", receiving_user=blocker, contributor=bystander,
        content_object=comment_on(page, bystander, "hello"),
    )
    client = client_for(blocker)

    response = client.get("/api/events/")
    assert response.status_code == 200, response.content
    listed = {row["id"] for row in response.json()["results"]}
    # The comment signal adds its own NEW_REPLY rows for the two comments;
    # whatever it created, nothing from the blocked account may be listed
    # except the money receipt.
    visible_from_blocked = Event.objects.filter(
        receiving_user=blocker, contributor=blocked, id__in=listed,
    )
    assert list(visible_from_blocked.values_list("type", flat=True)) == [
        "DONATION_RECEIVED"]
    assert {str(donation.pk), str(other.pk)} <= listed
    assert str(reply.pk) not in listed and str(mention.pk) not in listed
    assert str(page_vote.pk) not in listed

    unread = Event.objects.filter(receiving_user=blocker, read=False)
    expected = unread.exclude(
        contributor=blocked, type__in=["NEW_REPLY", "PAGE_MENTION", "PAGE_VOTE"],
    ).count()
    assert client.get("/api/events/unread_count/").json() == expected
    assert client.get("/api/events/unread_count/?include_recipient=1").json() == {
        "unread_count": expected, "recipient_username": blocker.username,
    }

    # A paid chat request is the recipient's receipt for 2Z it was credited:
    # it stays listed even after the sender is blocked.
    chat = Event.objects.create(
        type="ENCRYPTED_CHAT_REQUEST", receiving_user=blocker,
        contributor=blocked, payee=blocker, amount=Decimal("1"),
    )
    relisted = {row["id"] for row in client.get("/api/events/").json()["results"]}
    assert str(chat.pk) in relisted
    assert event_hidden_by_block(chat) is False

    # The realtime push asks the same question of one row.
    assert event_hidden_by_block(reply) is True
    assert event_hidden_by_block(mention) is True
    assert event_hidden_by_block(donation) is False
    assert event_hidden_by_block(other) is False


def test_chat_request_to_a_blocker_is_refused_like_an_unknown_user(trio):
    blocker, blocked, bystander = trio
    client = client_for(blocked)
    response = client.post(
        f"/api/e2ee/chat-requests/{blocker.username}/", {}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 404, response.content
    assert response.json()["code"] == "recipient_not_found"
    assert not ChatRequest.objects.exists()
    assert Creator.objects.get(pk=blocked.pk).tuzis == Decimal("10")
    assert Creator.objects.get(pk=blocker.pk).tuzis == Decimal("10")

    # The block is one-directional: the blocker can still reach out.
    response = client_for(blocker).post(
        f"/api/e2ee/chat-requests/{blocked.username}/", {}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 200, response.content


def test_a_reader_with_no_blocks_gets_no_block_predicate(creator_factory):
    """The unchanged-query promise in g12f/blocks.py, made observable."""
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    reader = creator_factory()
    page_for(creator_factory(), "plain")
    with CaptureQueriesContext(connection) as queries:
        assert client_for(reader).get("/api/zpage/").status_code == 200
    page_queries = [q["sql"] for q in queries if '"g12f_zpage"' in q["sql"]]
    assert page_queries
    assert not any("g12f_creatorblock" in sql for sql in page_queries)
    assert CreatorBlock.objects.count() == 0


def test_my_block_list_is_private_and_omits_inactive_accounts(
    trio, creator_factory,
):
    blocker, blocked, bystander = trio
    gone = creator_factory(username="gone_z")
    client_for(blocker).put(f"/api/creator/{gone.username}/block/")
    Creator.objects.filter(pk=gone.pk).update(is_active=False)

    response = client_for(blocker).get("/api/g12f/blocks/mine/")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["count"] == 1
    assert [row["username"] for row in body["results"]] == [blocked.username]
    assert set(body["results"][0]) == {"username", "created_at"}

    # Nobody else's list, and no way to ask for someone else's.
    other = client_for(bystander).get(
        "/api/g12f/blocks/mine/", {"username": blocker.username})
    assert other.json()["count"] == 0
    assert APIClient().get("/api/g12f/blocks/mine/").status_code in (401, 403)


def test_related_pages_do_not_recommend_a_blocked_creator(trio):
    blocker, blocked, bystander = trio
    source = page_for(blocked, "source")
    page_for(blocked, "sibling")
    url = f"/api/zpage/{source.free2zaddr}/related/"

    # The fallback recommends the same creator's other pages.
    def related(client):
        response = client.get(url)
        assert response.status_code == 200, response.content
        return [row["vanity"] for row in response.json()]

    assert related(client_for(bystander)) == ["sibling"]
    assert related(client_for(blocker)) == []


def test_a_queued_chat_email_is_not_sent_after_the_recipient_blocks(
    creator_factory,
):
    from dj.apps.e2ee.tasks import _deliverable_address
    from dj.apps.emails.models import Email
    from django.utils import timezone

    sender = creator_factory(username="queued_sender")
    recipient = creator_factory(username="queued_recipient")
    Email.objects.create(
        user=recipient, email="r@example.com", token="t-queued",
        expires_at=timezone.now(), confirmed_at=timezone.now(),
        get_notifications=True,
    )
    chat = ChatRequest.objects.create(
        sender=sender, recipient=recipient, sender_handle="queued_sender",
        charged=Decimal("1"),
    )
    assert _deliverable_address(chat)[1] is None

    CreatorBlock.objects.create(blocker=recipient, blocked=sender)
    assert _deliverable_address(chat) == (None, "recipient_blocked_sender")


def test_a_mixed_series_omits_the_blocked_creators_page(trio):
    from dj.apps.g12f.models import PageOrder, Series

    blocker, blocked, bystander = trio
    mine = page_for(bystander, "series-own")
    theirs = page_for(blocked, "series-blocked")
    series = Series.objects.create(creator=bystander, name="Mixed")
    PageOrder.objects.create(series=series, page=mine, order=0)
    PageOrder.objects.create(series=series, page=theirs, order=1)
    url = f"/api/g12f/zpage/{mine.free2zaddr}/series/"

    def members(client):
        response = client.get(url)
        assert response.status_code == 200, response.content
        body = response.json()
        rows = body[0] if isinstance(body, list) else body
        return [row["page"]["vanity"] for row in rows["pageorder_set"]]

    assert members(client_for(bystander)) == ["series-own", "series-blocked"]
    assert members(client_for(blocker)) == ["series-own"]
