"""The tagging provider must see the same parent redactions as the thread."""
import json
from unittest.mock import Mock

import pytest
from django.utils import timezone

from dj.apps.comments.management.commands import tag_comments
from dj.apps.comments.models import Comment
from dj.apps.comments.visibility import author_redacted
from dj.apps.g12f.models import Creator


@pytest.fixture
def thread(creator_factory):
    ancestor = Comment.objects.create(
        author=creator_factory(), headline="Visible ancestor title",
        content="Visible ancestor context")
    parent_author = creator_factory()
    parent = Comment.objects.create(
        author=parent_author, parent=ancestor,
        headline="Private parent title", content="Private parent context")
    reply = Comment.objects.create(
        author=creator_factory(), parent=parent, headline="Visible reply title",
        content="Visible reply context")
    return parent_author, parent, reply


def _redact(author, state):
    now = timezone.now()
    Creator.objects.filter(pk=author.pk).update(
        is_active=False,
        deletion_requested_at=now,
        deleted_at=now if state == "deleted" else None,
    )


def _deliver(reply, mocker):
    tagger = mocker.patch.object(tag_comments, "tag_content", return_value=["context"])
    message = Mock(data=json.dumps({"uuid": str(reply.uuid)}).encode())
    tag_comments.callback(message)
    tagger.assert_called_once()
    message.ack.assert_called_once()
    message.nack.assert_not_called()
    reply.refresh_from_db()
    assert set(reply.tags.names()) == {"context"}
    return tagger.call_args.args[0]


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("state", ["pending", "deleted"])
def test_tagging_excludes_redacted_parent_but_keeps_visible_ancestor(thread, mocker, state):
    author, parent, reply = thread
    _redact(author, state)
    assert author_redacted(Comment.objects.get(pk=parent.pk))

    context = _deliver(reply, mocker)

    assert "Private parent title" not in context
    assert "Private parent context" not in context
    for visible in ["Visible ancestor title", "Visible ancestor context",
                    "Visible reply title", "Visible reply context"]:
        assert visible in context


@pytest.mark.django_db(transaction=True)
def test_tagging_keeps_nonredacted_parent_context(thread, mocker):
    _, parent, reply = thread
    assert not author_redacted(parent)

    context = _deliver(reply, mocker)

    assert "Private parent title" in context
    assert "Private parent context" in context
    assert "Visible ancestor context" in context
    assert "Visible reply context" in context


@pytest.mark.django_db(transaction=True)
def test_tagging_redaction_negative_control_reproduces_provider_disclosure(thread, mocker):
    author, _, reply = thread
    _redact(author, "pending")
    mocker.patch("dj.apps.comments.visibility.author_redacted", return_value=False)

    context = _deliver(reply, mocker)

    # Disable only the predicate: the real traversal, consumer claim, and
    # provider boundary then expose both fields that the positive test forbids.
    assert "Private parent title" in context
    assert "Private parent context" in context


def _attached_reply(content_object, author):
    """The reply API copies its parent's generic attachment onto the reply."""
    from django.contrib.contenttypes.models import ContentType

    parent = Comment.objects.create(
        author=author, content_type=ContentType.objects.get_for_model(content_object),
        object_id=str(content_object.pk), content="Active attached parent")
    return Comment.objects.create(
        author=author, parent=parent, content_type=parent.content_type,
        object_id=parent.object_id, content="Active attached reply")


def _page_thread(creator_factory, **page_fields):
    import uuid
    from dj.apps.g12f.models import zPage

    owner = creator_factory(tuzis=0)
    page = zPage.objects.create(
        creator=owner, title="Synthetic retained page title",
        content="Synthetic retained page body", free2zaddr=str(uuid.uuid4()),
        **page_fields,
    )
    return owner, page, _attached_reply(page, creator_factory(tuzis=0))


def _hide_page(owner, page, reply, state):
    from dj.apps.comments.models import ContentReport
    from dj.apps.g12f import account_deletion

    if state == "pending":
        account_deletion.schedule_deletion(
            owner, confirm_username=owner.username, auth_epoch=owner.kt_account_epoch)
    elif state == "deleted":
        ContentReport.objects.create(
            reporter=reply.author, target_kind="zpage", target_id=page.free2zaddr,
            reason=ContentReport.Reason.SPAM)
        account_deletion.delete_account(
            owner, confirm_username=owner.username, auth_epoch=owner.kt_account_epoch)
    else:
        Creator.objects.filter(pk=owner.pk).update(is_active=False)
    owner.refresh_from_db()
    page.refresh_from_db()
    assert not owner.is_active
    assert (owner.deleted_at is not None) == (state == "deleted")


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("state", ["pending", "deleted", "inactive"])
def test_tagging_excludes_hidden_attached_page_owner(creator_factory, mocker, state):
    from dj.apps.comments.visibility import zpage_visible

    owner, page, reply = _page_thread(creator_factory, is_published=True)
    _hide_page(owner, page, reply, state)
    # The real purge keeps a reported page. Generic resolution still sees it,
    # even though its public thread cannot. Delayed delivery must not send it.
    assert not zpage_visible(page, reply.author)
    assert Comment.objects.get(pk=reply.pk).content_object.pk == page.pk

    context = _deliver(reply, mocker)

    assert "Synthetic retained page title" not in context
    assert "Synthetic retained page body" not in context
    assert "Active attached parent" in context
    assert "Active attached reply" in context


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("published,members", [(True, False), (False, False), (True, True)])
def test_tagging_preserves_active_page_owner_context(
    creator_factory, mocker, published, members,
):
    _, _, reply = _page_thread(
        creator_factory, is_published=published, is_subscriber_only=members)

    context = _deliver(reply, mocker)

    # This change is an account-state boundary, not a new editorial or
    # subscription policy for active owners' pre-existing tagging behavior.
    assert "Synthetic retained page title" in context
    assert "Synthetic retained page body" in context
    assert "Active attached reply" in context


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("state", ["pending", "deleted"])
def test_tagging_attached_page_negative_control(creator_factory, mocker, state):
    owner, page, reply = _page_thread(creator_factory, is_published=True)
    _hide_page(owner, page, reply, state)
    mocker.patch("dj.apps.comments.visibility.tagging_content_owner_active", return_value=True)

    context = _deliver(reply, mocker)

    # Bypass only the owner predicate: real generic resolution, recursion,
    # consumer claim, and provider boundary reproduce the disclosure.
    assert "Synthetic retained page title" in context
    assert "Synthetic retained page body" in context


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("pending,bypass", [(False, False), (True, False), (True, True)])
def test_tagging_checks_conversation_owner_not_only_turn_authors(
    creator_factory, mocker, pending, bypass,
):
    from dj.apps.g12f import account_deletion
    from dj.apps.openai.models import AIModel, Conversation, PromptResponse

    owner = creator_factory(tuzis=0)
    contributor = creator_factory(tuzis=0)
    model = AIModel.objects.create(model="tagging-privacy-test", max_tokens=100)
    conversation = Conversation.objects.create(ai_model=model, user=owner, is_public=True)
    turn = PromptResponse.objects.create(
        ai_model=model, user=contributor,
        user_input="Synthetic other author's turn", response="Synthetic response")
    conversation.prompt_response_set.add(turn)
    reply = _attached_reply(conversation, contributor)
    if pending:
        account_deletion.schedule_deletion(
            owner, confirm_username=owner.username, auth_epoch=owner.kt_account_epoch)
    if bypass:
        mocker.patch("dj.apps.comments.visibility.tagging_content_owner_active", return_value=True)
    # The turn manager filters the turn author's deletion, not the owner of
    # the conversation. A shared active author's turn survives that filter.
    assert conversation.prompt_response_set.filter(pk=turn.pk).exists()

    context = _deliver(reply, mocker)

    assert ("Synthetic other author's turn" in context) == (not pending or bypass)
    assert "Active attached reply" in context
