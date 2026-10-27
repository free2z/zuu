"""Regression tests for  — a deactivated creator's identity fields were
served anonymously through public (and forked) AI conversations.

``PromptResponseSerializer`` nests ``user = CreatorListSerializer``, exposing
``full_name``, ``p2paddr`` and ``member_price``. The public read paths gate only
on the conversation owner's activity, never on the response author's — and a
fork reuses the original response rows, so the identity travels into forks.

The transcript remains visible because its public owner governs row visibility;
the deactivated response author's private identity fields do not.
"""

import pytest

from dj.apps.openai.models import AIModel, Conversation, PromptResponse
from dj.apps.uploads.models import GenericFile


AUTHOR_NAME = "Author's Real Name"
AUTHOR_P2PADDR = (
    "zs12f4y80pjhy042rmxq339dr6885jqqvh9fc6j8pvxg3hyhc8hmsqurlkqtkzwp03quca2"
    "7pt0f7k"
)
FORK_URL = "/api/ai/conversations/fork/"


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
def owner(creator_factory):
    return creator_factory(username="convoowner")


@pytest.fixture
def author(creator_factory):
    creator = creator_factory(username="rowauthor")
    creator.full_name = AUTHOR_NAME
    creator.p2paddr = AUTHOR_P2PADDR
    creator.avatar_image = GenericFile.objects.create(
        owner=creator,
        file="avatars/author-identity.jpg",
        access="public",
        mime_type="image/jpeg",
        title=AUTHOR_NAME,
        description=AUTHOR_P2PADDR,
    )
    creator.banner_image = GenericFile.objects.create(
        owner=creator,
        file="banners/author-identity.jpg",
        access="public",
        mime_type="image/jpeg",
        title=AUTHOR_NAME,
        description=AUTHOR_P2PADDR,
    )
    # CreatorFactory defaults member_price to Decimal("10").
    creator.save(
        update_fields=[
            "full_name", "p2paddr", "avatar_image", "banner_image",
        ]
    )
    return creator


@pytest.fixture
def forker(creator_factory):
    return creator_factory(username="forker")


def _public_convo_with_author_row(owner, author, ai_model):
    """Make a public conversation whose response author is not its owner."""
    conversation = Conversation.objects.create(
        ai_model=ai_model,
        user=owner,
        display_name="owner's public chat",
        is_public=True,
    )
    prompt_response = PromptResponse.objects.create(
        ai_model=ai_model,
        user=author,
        user_input="question from the author",
        response="answer visible in the public transcript",
    )
    conversation.prompt_response_set.add(prompt_response)
    return conversation, prompt_response


def _deactivate(creator):
    creator.is_active = False
    creator.save(update_fields=["is_active"])


@pytest.mark.django_db
def test_active_authors_identity_is_served_anonymously(
    api_client, owner, author, ai_model
):
    """The control: active response authors are not spuriously redacted."""
    conversation, _prompt_response = _public_convo_with_author_row(
        owner, author, ai_model
    )

    detail = api_client.get(
        f"/api/ai/public-conversations/{conversation.id}/"
    )
    assert detail.status_code == 200, detail.content
    nested = detail.json()["prompt_response_set"][0]["user"]
    assert nested["username"] == author.username
    assert nested["full_name"] == AUTHOR_NAME
    assert nested["p2paddr"] == AUTHOR_P2PADDR
    assert nested["member_price"] == "10"
    assert nested["avatar_image"]["title"] == AUTHOR_NAME
    assert nested["banner_image"]["description"] == AUTHOR_P2PADDR

    transcript = api_client.get(
        f"/api/ai/public-conversations/{conversation.id}/promptresponses/"
    )
    assert transcript.status_code == 200, transcript.content
    row_user = transcript.json()["results"][0]["user"]
    assert row_user["full_name"] == AUTHOR_NAME
    assert row_user["p2paddr"] == AUTHOR_P2PADDR
    assert row_user["member_price"] == "10"
    assert row_user["avatar_image"]["description"] == AUTHOR_P2PADDR
    assert row_user["banner_image"]["title"] == AUTHOR_NAME


@pytest.mark.django_db
def test_deactivating_the_author_redacts_both_public_endpoints(
    api_client, owner, author, ai_model
):
    """Rows stay visible (the transcript is intact); identity does not."""
    conversation, prompt_response = _public_convo_with_author_row(
        owner, author, ai_model
    )
    _deactivate(author)

    detail = api_client.get(
        f"/api/ai/public-conversations/{conversation.id}/"
    )
    assert detail.status_code == 200, detail.content
    payload = detail.json()
    assert [row["id"] for row in payload["prompt_response_set"]] == [
        prompt_response.id
    ]
    assert (
        payload["prompt_response_set"][0]["response"]
        == "answer visible in the public transcript"
    )
    nested = payload["prompt_response_set"][0]["user"]
    assert nested["username"] == author.username
    assert nested["full_name"] == ""
    assert nested["p2paddr"] == ""
    assert nested["member_price"] is None
    assert nested["avatar_image"] is None
    assert nested["banner_image"] is None

    transcript = api_client.get(
        f"/api/ai/public-conversations/{conversation.id}/promptresponses/"
    )
    assert transcript.status_code == 200, transcript.content
    results = transcript.json()["results"]
    assert [row["id"] for row in results] == [prompt_response.id]
    row_user = results[0]["user"]
    assert row_user["full_name"] == ""
    assert row_user["p2paddr"] == ""
    assert row_user["member_price"] is None
    assert row_user["avatar_image"] is None
    assert row_user["banner_image"] is None


@pytest.mark.django_db
def test_forked_conversation_serves_deactivated_author_redacted(
    api_client, owner, author, forker, ai_model
):
    """A fork retains the shared row, never the deactivated author's identity."""
    conversation, prompt_response = _public_convo_with_author_row(
        owner, author, ai_model
    )

    api_client.force_authenticate(user=forker)
    response = api_client.post(
        FORK_URL,
        {
            "conversation": str(conversation.id),
            "prompt_response": prompt_response.id,
        },
        format="json",
    )
    assert response.status_code == 201, response.content
    fork = Conversation.objects.get(id=response.json()["id"])
    assert list(fork.prompt_response_set.all()) == [prompt_response]

    fork.is_public = True
    fork.save(update_fields=["is_public"])
    _deactivate(author)

    api_client.force_authenticate(user=None)
    transcript = api_client.get(
        f"/api/ai/public-conversations/{fork.id}/promptresponses/"
    )
    assert transcript.status_code == 200, transcript.content
    results = transcript.json()["results"]
    assert [row["id"] for row in results] == [prompt_response.id]
    row_user = results[0]["user"]
    assert row_user["username"] == author.username
    assert row_user["full_name"] == ""
    assert row_user["p2paddr"] == ""
    assert row_user["member_price"] is None
    assert row_user["avatar_image"] is None
    assert row_user["banner_image"] is None
