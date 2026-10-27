"""Regression tests for  — `Conversation.is_subscriber_only` was enforced
nowhere, so a conversation flagged `is_public=True, is_subscriber_only=True` was
served in full (transcript included) to everyone, including anonymous users.

Every access-denial test here FAILS against the code as it stood on `main`:
`PublicConversationViewSet`, `PublicPromptResponseViewSet`,
`ConversationViewSet.public`/`fork` and the RSS feeds all filtered on
`is_public=True` alone.

Subscriber status is the SAME notion used everywhere else in the app
(`Creator.has_fan` / the zPage retrieve gate): an unexpired `Subscription` row
with `fan=viewer, star=creator`. Real Postgres — the DB is never mocked.
"""
from datetime import timedelta

import pytest
from django.utils import timezone

from dj.apps.g12f.models.creator import Subscription
from dj.apps.openai.models import AIModel, Conversation, PromptResponse


@pytest.fixture
def ai_model(db):
    return AIModel.objects.create(
        model="gpt-test",
        display_name="Test Model",
        system_message="be helpful",
        max_tokens=4096,
        is_ga=True,
    )


@pytest.fixture
def creator(creator_factory):
    """The author of the subscriber-only conversation."""
    return creator_factory(username="creator")


@pytest.fixture
def subscriber(creator_factory):
    return creator_factory(username="subscriber")


@pytest.fixture
def outsider(creator_factory):
    """Authenticated, but not a subscriber and not the owner."""
    return creator_factory(username="outsider")


def _subscribe(fan, star, *, expires_in=timedelta(days=30)):
    return Subscription.objects.create(
        fan=fan, star=star, expires=timezone.now() + expires_in,
    )


def _subonly_conversation(owner, ai_model, n=2):
    conversation = Conversation.objects.create(
        ai_model=ai_model,
        user=owner,
        display_name="paywalled chat",
        is_public=True,
        is_subscriber_only=True,
    )
    for i in range(n):
        pr = PromptResponse.objects.create(
            ai_model=ai_model,
            user=owner,
            user_input=f"members-only question {i}",
            response=f"members-only answer {i}",
        )
        conversation.prompt_response_set.add(pr)
    return conversation


@pytest.fixture
def subonly_convo(creator, ai_model):
    return _subonly_conversation(creator, ai_model)


def _detail_url(convo):
    return f"/api/ai/public-conversations/{convo.id}/"


def _list_url():
    return "/api/ai/public-conversations/"


def _pr_url(convo):
    return f"/api/ai/public-conversations/{convo.id}/promptresponses/"


def _leaks(resp):
    body = resp.content.decode()
    return "members-only question" in body or "members-only answer" in body


# ---------------------------------------------------------------------------
# retrieve (detail) — the full transcript endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_can_retrieve_subscriber_only_conversation(
    api_client, creator, subonly_convo
):
    api_client.force_authenticate(user=creator)
    resp = api_client.get(_detail_url(subonly_convo))
    assert resp.status_code == 200, resp.content
    assert _leaks(resp)


@pytest.mark.django_db
def test_active_subscriber_can_retrieve_subscriber_only_conversation(
    api_client, creator, subscriber, subonly_convo
):
    _subscribe(subscriber, creator)
    api_client.force_authenticate(user=subscriber)
    resp = api_client.get(_detail_url(subonly_convo))
    assert resp.status_code == 200, resp.content
    assert _leaks(resp)


@pytest.mark.django_db
def test_non_subscriber_cannot_retrieve_subscriber_only_conversation(
    api_client, outsider, subonly_convo
):
    api_client.force_authenticate(user=outsider)
    resp = api_client.get(_detail_url(subonly_convo))
    assert resp.status_code == 404, resp.status_code
    assert not _leaks(resp)


@pytest.mark.django_db
def test_anonymous_cannot_retrieve_subscriber_only_conversation(
    api_client, subonly_convo
):
    resp = api_client.get(_detail_url(subonly_convo))
    assert resp.status_code == 404, resp.status_code
    assert not _leaks(resp)


@pytest.mark.django_db
def test_expired_subscriber_cannot_retrieve_subscriber_only_conversation(
    api_client, creator, subscriber, subonly_convo
):
    # Subscription exists but lapsed yesterday.
    _subscribe(subscriber, creator, expires_in=timedelta(days=-1))
    api_client.force_authenticate(user=subscriber)
    resp = api_client.get(_detail_url(subonly_convo))
    assert resp.status_code == 404, resp.status_code
    assert not _leaks(resp)


@pytest.mark.django_db
def test_subscription_to_a_different_creator_does_not_grant_access(
    api_client, creator_factory, subscriber, subonly_convo
):
    """Being a fan of SOME creator is not being a fan of THIS one."""
    other_star = creator_factory(username="other_star")
    _subscribe(subscriber, other_star)
    api_client.force_authenticate(user=subscriber)
    resp = api_client.get(_detail_url(subonly_convo))
    assert resp.status_code == 404, resp.status_code
    assert not _leaks(resp)


# ---------------------------------------------------------------------------
# list — must not enumerate the paywalled conversation either
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_anonymous_list_excludes_subscriber_only(api_client, subonly_convo):
    resp = api_client.get(_list_url())
    assert resp.status_code == 200, resp.content
    ids = {row["id"] for row in resp.json()["results"]}
    assert str(subonly_convo.id) not in ids and subonly_convo.id not in ids


@pytest.mark.django_db
def test_non_subscriber_list_excludes_subscriber_only(
    api_client, outsider, subonly_convo
):
    api_client.force_authenticate(user=outsider)
    resp = api_client.get(_list_url())
    assert resp.status_code == 200, resp.content
    ids = {str(row["id"]) for row in resp.json()["results"]}
    assert str(subonly_convo.id) not in ids


@pytest.mark.django_db
def test_active_subscriber_list_includes_subscriber_only(
    api_client, creator, subscriber, subonly_convo
):
    _subscribe(subscriber, creator)
    api_client.force_authenticate(user=subscriber)
    resp = api_client.get(_list_url())
    assert resp.status_code == 200, resp.content
    ids = {str(row["id"]) for row in resp.json()["results"]}
    assert str(subonly_convo.id) in ids


@pytest.mark.django_db
def test_ordinary_public_conversation_still_listed_for_everyone(
    api_client, creator, ai_model
):
    """The fix must not hide ordinary (non-subscriber-only) public convos."""
    public = Conversation.objects.create(
        ai_model=ai_model, user=creator, display_name="free chat",
        is_public=True, is_subscriber_only=False,
    )
    resp = api_client.get(_list_url())
    assert resp.status_code == 200, resp.content
    ids = {str(row["id"]) for row in resp.json()["results"]}
    assert str(public.id) in ids


@pytest.mark.django_db
def test_deactivated_creator_takes_public_conversation_surfaces_down(
    api_client, creator, ai_model,
):
    conversation = Conversation.objects.create(
        ai_model=ai_model,
        user=creator,
        display_name="taken down chat",
        is_public=True,
    )
    response = PromptResponse.objects.create(
        ai_model=ai_model,
        user=creator,
        user_input="private transcript marker",
        response="private response marker",
    )
    conversation.prompt_response_set.add(response)

    assert api_client.get(_detail_url(conversation)).status_code == 200
    assert api_client.get(_pr_url(conversation)).json()["results"]

    creator.is_active = False
    creator.save(update_fields=["is_active"])

    detail = api_client.get(_detail_url(conversation))
    prompt_responses = api_client.get(_pr_url(conversation))
    feed = api_client.get("/feeds/ai/recent.xml")
    social = api_client.get(f"/ai/conversation/{conversation.id}")

    assert detail.status_code == 404
    assert prompt_responses.status_code == 200
    assert prompt_responses.json()["results"] == []
    assert "taken down chat" not in feed.content.decode()
    assert social.status_code == 404


# ---------------------------------------------------------------------------
# prompt responses — the transcript rows one endpoint over
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_anonymous_cannot_read_subscriber_only_prompt_responses(
    api_client, subonly_convo
):
    resp = api_client.get(_pr_url(subonly_convo))
    assert resp.status_code == 200, resp.content
    assert resp.json()["results"] == []
    assert not _leaks(resp)


@pytest.mark.django_db
def test_non_subscriber_cannot_read_subscriber_only_prompt_responses(
    api_client, outsider, subonly_convo
):
    api_client.force_authenticate(user=outsider)
    resp = api_client.get(_pr_url(subonly_convo))
    assert resp.status_code == 200, resp.content
    assert resp.json()["results"] == []
    assert not _leaks(resp)


@pytest.mark.django_db
def test_active_subscriber_can_read_subscriber_only_prompt_responses(
    api_client, creator, subscriber, subonly_convo
):
    _subscribe(subscriber, creator)
    api_client.force_authenticate(user=subscriber)
    resp = api_client.get(_pr_url(subonly_convo))
    assert resp.status_code == 200, resp.content
    returned = {row["id"] for row in resp.json()["results"]}
    assert returned == {pr.id for pr in subonly_convo.prompt_response_set.all()}


@pytest.mark.django_db
def test_owner_can_read_subscriber_only_prompt_responses(
    api_client, creator, subonly_convo
):
    api_client.force_authenticate(user=creator)
    resp = api_client.get(_pr_url(subonly_convo))
    assert resp.status_code == 200, resp.content
    assert _leaks(resp)


# ---------------------------------------------------------------------------
# fork — must not become a bypass of the paywall
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_non_subscriber_cannot_fork_subscriber_only_conversation(
    api_client, outsider, subonly_convo
):
    pr = subonly_convo.prompt_response_set.first()
    api_client.force_authenticate(user=outsider)
    resp = api_client.post(
        "/api/ai/conversations/fork/",
        {"conversation": str(subonly_convo.id), "prompt_response": pr.id},
        format="json",
    )
    assert resp.status_code == 404, resp.content
    assert not Conversation.objects.filter(user=outsider).exists()


@pytest.mark.django_db
def test_anonymous_cannot_fork_subscriber_only_conversation(
    api_client, subonly_convo
):
    pr = subonly_convo.prompt_response_set.first()
    resp = api_client.post(
        "/api/ai/conversations/fork/",
        {"conversation": str(subonly_convo.id), "prompt_response": pr.id},
        format="json",
    )
    assert resp.status_code in (401, 403), resp.status_code


@pytest.mark.django_db
def test_active_subscriber_can_fork_subscriber_only_conversation(
    api_client, creator, subscriber, subonly_convo
):
    _subscribe(subscriber, creator)
    pr = subonly_convo.prompt_response_set.first()
    api_client.force_authenticate(user=subscriber)
    resp = api_client.post(
        "/api/ai/conversations/fork/",
        {"conversation": str(subonly_convo.id), "prompt_response": pr.id},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert Conversation.objects.filter(user=subscriber).exists()


@pytest.mark.django_db
def test_owner_can_fork_own_subscriber_only_conversation(
    api_client, creator, subonly_convo
):
    pr = subonly_convo.prompt_response_set.first()
    api_client.force_authenticate(user=creator)
    resp = api_client.post(
        "/api/ai/conversations/fork/",
        {"conversation": str(subonly_convo.id), "prompt_response": pr.id},
        format="json",
    )
    assert resp.status_code == 201, resp.content


# ---------------------------------------------------------------------------
# ConversationViewSet.public action — another listing path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_public_action_excludes_subscriber_only_for_non_subscriber(
    api_client, outsider, subonly_convo
):
    api_client.force_authenticate(user=outsider)
    resp = api_client.get("/api/ai/conversations/public/")
    assert resp.status_code == 200, resp.content
    ids = {str(row["id"]) for row in resp.json()}
    assert str(subonly_convo.id) not in ids


@pytest.mark.django_db
def test_public_action_includes_subscriber_only_for_subscriber(
    api_client, creator, subscriber, subonly_convo
):
    _subscribe(subscriber, creator)
    api_client.force_authenticate(user=subscriber)
    resp = api_client.get("/api/ai/conversations/public/")
    assert resp.status_code == 200, resp.content
    ids = {str(row["id"]) for row in resp.json()}
    assert str(subonly_convo.id) in ids


# ---------------------------------------------------------------------------
# RSS feeds — anonymous, public by nature; must never carry paywalled content
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_ai_feed_excludes_subscriber_only(api_client, subonly_convo):
    resp = api_client.get("/feeds/ai/recent.xml")
    assert resp.status_code == 200, resp.content
    assert not _leaks(resp)
    assert "paywalled chat" not in resp.content.decode()


@pytest.mark.django_db
def test_user_ai_feed_excludes_subscriber_only(
    api_client, creator, subonly_convo
):
    resp = api_client.get(f"/feeds/{creator.username}/ai/recent.xml")
    assert resp.status_code == 200, resp.content
    assert not _leaks(resp)
    assert "paywalled chat" not in resp.content.decode()


# ---------------------------------------------------------------------------
# OG / social share-card route — leaks title + creator, not the transcript.
# Flagged by the codex adversarial review of this PR.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_ai_social_card_404s_for_subscriber_only(api_client, subonly_convo):
    resp = api_client.get(f"/ai/conversation/{subonly_convo.id}")
    assert resp.status_code == 404, resp.status_code
    assert "paywalled chat" not in resp.content.decode()


@pytest.mark.django_db
def test_ai_social_card_still_renders_ordinary_public_conversation(
    api_client, creator, ai_model
):
    public = Conversation.objects.create(
        ai_model=ai_model, user=creator, display_name="free chat card",
        is_public=True, is_subscriber_only=False,
    )
    resp = api_client.get(f"/ai/conversation/{public.id}")
    assert resp.status_code == 200, resp.content
    assert "free chat card" in resp.content.decode()
