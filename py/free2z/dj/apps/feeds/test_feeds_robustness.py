"""Regression tests for feed 500s on real-but-edge data.

* ``AIFeed.item_description`` dereferenced ``prompt_response_set.first()``,
  which is None for a public conversation with no prompt-responses yet ->
  AttributeError -> the entire feed 500s.
* The per-user feeds looked the user up with ``User.objects.get(username=...)``,
  so an unknown username in the URL raised DoesNotExist -> 500 instead of 404.
"""
import pytest

from dj.apps.openai.models import AIModel, Conversation


def _ai_model():
    return AIModel.objects.create(
        model="gpt-test",
        display_name="Test Model",
        system_message="sys",
        max_tokens=4096,
    )


@pytest.mark.django_db
def test_ai_feed_survives_conversation_with_no_prompts(api_client, creator_factory):
    user = creator_factory()
    Conversation.objects.create(
        ai_model=_ai_model(),
        user=user,
        display_name="Empty public convo",
        is_public=True,
    )

    response = api_client.get("/feeds/ai/recent.xml")

    assert response.status_code == 200, response.content
    assert b"Empty public convo" in response.content


@pytest.mark.django_db
def test_user_ai_feed_survives_conversation_with_no_prompts(api_client, creator_factory):
    user = creator_factory()
    Conversation.objects.create(
        ai_model=_ai_model(),
        user=user,
        display_name="Empty public convo",
        is_public=True,
    )

    response = api_client.get(f"/feeds/{user.username}/ai/recent.xml")

    assert response.status_code == 200, response.content


@pytest.mark.django_db
def test_unknown_username_ai_feed_is_404(api_client):
    response = api_client.get("/feeds/nosuchuser/ai/recent.xml")
    assert response.status_code == 404, response.content


@pytest.mark.django_db
def test_unknown_username_zpages_feed_is_404(api_client):
    response = api_client.get("/feeds/nosuchuser/zpages/recent.xml")
    assert response.status_code == 404, response.content


@pytest.mark.django_db
def test_unknown_username_converse_feed_is_404(api_client):
    response = api_client.get("/feeds/nosuchuser/converse/recent.xml")
    assert response.status_code == 404, response.content
