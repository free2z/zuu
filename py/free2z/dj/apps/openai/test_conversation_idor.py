"""Regression tests for  — cross-user access to private AI conversations.

Every test in this module FAILS against the code as it stood on `main`: the
`PromptResponseViewSet` queryset filtered only on the URL's `conversation_id`
(the ownership predicate was present but commented out) with no object-level
permission, and `ConversationViewSet.fork` resolved both ids straight out of the
request body without scoping either one.

Real Postgres — the DB is never mocked (project rule).
"""
import pytest

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
def victim(creator_factory):
    return creator_factory(username="victim")


@pytest.fixture
def attacker(creator_factory):
    return creator_factory(username="attacker")


def _conversation_with_messages(user, ai_model, n=2, is_public=False):
    conversation = Conversation.objects.create(
        ai_model=ai_model,
        user=user,
        display_name=f"{user.username}'s private chat",
        is_public=is_public,
    )
    for i in range(n):
        pr = PromptResponse.objects.create(
            ai_model=ai_model,
            user=user,
            user_input=f"my secret question {i}",
            response=f"the secret answer {i}",
        )
        conversation.prompt_response_set.add(pr)
    return conversation


@pytest.fixture
def victim_conversation(victim, ai_model):
    return _conversation_with_messages(victim, ai_model)


def _pr_url(conversation, pr=None):
    base = f"/api/ai/conversations/{conversation.id}/promptresponses/"
    return base if pr is None else f"{base}{pr.id}/"


# --------------------------------------------------------------------------
# PromptResponseViewSet — the critical IDOR
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_attacker_cannot_list_victim_prompt_responses(
    api_client, attacker, victim_conversation
):
    api_client.force_authenticate(user=attacker)
    resp = api_client.get(_pr_url(victim_conversation))

    assert resp.status_code in (403, 404), resp.status_code
    body = resp.content.decode()
    assert "secret question" not in body
    assert "secret answer" not in body


@pytest.mark.django_db
def test_attacker_cannot_retrieve_victim_prompt_response(
    api_client, attacker, victim_conversation
):
    pr = victim_conversation.prompt_response_set.first()
    api_client.force_authenticate(user=attacker)
    resp = api_client.get(_pr_url(victim_conversation, pr))

    assert resp.status_code in (403, 404), resp.status_code
    assert "secret answer" not in resp.content.decode()


@pytest.mark.django_db
def test_attacker_cannot_rewrite_victim_prompt_response(
    api_client, attacker, victim_conversation
):
    pr = victim_conversation.prompt_response_set.first()
    original = pr.user_input

    api_client.force_authenticate(user=attacker)
    resp = api_client.patch(
        _pr_url(victim_conversation, pr),
        {"user_input": "rewritten by the attacker"},
        format="json",
    )

    assert resp.status_code in (403, 404), resp.status_code
    pr.refresh_from_db()
    assert pr.user_input == original


@pytest.mark.django_db
def test_attacker_cannot_delete_victim_prompt_response(
    api_client, attacker, victim_conversation
):
    pr = victim_conversation.prompt_response_set.first()

    api_client.force_authenticate(user=attacker)
    resp = api_client.delete(_pr_url(victim_conversation, pr))

    assert resp.status_code in (403, 404), resp.status_code
    assert PromptResponse.objects.filter(id=pr.id).exists()


@pytest.mark.django_db
def test_anonymous_cannot_list_prompt_responses(api_client, victim_conversation):
    resp = api_client.get(_pr_url(victim_conversation))
    assert resp.status_code in (401, 403), resp.status_code
    assert "secret question" not in resp.content.decode()


@pytest.mark.django_db
def test_owner_can_still_list_and_retrieve_own_prompt_responses(
    api_client, victim, victim_conversation
):
    """The fix must not break the legitimate path."""
    pr = victim_conversation.prompt_response_set.first()
    api_client.force_authenticate(user=victim)

    listed = api_client.get(_pr_url(victim_conversation))
    assert listed.status_code == 200, listed.content
    assert "secret question 0" in listed.content.decode()

    got = api_client.get(_pr_url(victim_conversation, pr))
    assert got.status_code == 200, got.content
    assert got.json()["id"] == pr.id


@pytest.mark.django_db
def test_owner_can_delete_own_prompt_response(
    api_client, victim, victim_conversation
):
    pr = victim_conversation.prompt_response_set.first()
    api_client.force_authenticate(user=victim)

    resp = api_client.delete(_pr_url(victim_conversation, pr))
    assert resp.status_code == 204, resp.content
    assert not PromptResponse.objects.filter(id=pr.id).exists()


@pytest.mark.django_db
def test_malformed_conversation_id_is_not_a_500(api_client, attacker):
    """The router regex accepts non-UUID strings like 'aaa'."""
    api_client.force_authenticate(user=attacker)
    resp = api_client.get("/api/ai/conversations/aaa/promptresponses/")
    assert resp.status_code in (403, 404), resp.status_code


@pytest.mark.django_db
def test_forker_cannot_mutate_the_original_authors_shared_rows(
    api_client, attacker, victim, ai_model
):
    """A fork SHARES PromptResponse rows with the original conversation.

    Owning the fork must not confer the right to rewrite or delete the original
    author's messages — that would destroy the victim's transcript through a
    conversation the attacker legitimately owns.
    """
    public_convo = _conversation_with_messages(victim, ai_model, is_public=True)
    pr = public_convo.prompt_response_set.first()

    fork = Conversation.objects.create(
        ai_model=ai_model, user=attacker, display_name="(Forked)"
    )
    fork.prompt_response_set.add(*public_convo.prompt_response_set.all())

    api_client.force_authenticate(user=attacker)

    patched = api_client.patch(
        _pr_url(fork, pr), {"user_input": "tampered"}, format="json"
    )
    assert patched.status_code == 403, patched.content

    deleted = api_client.delete(_pr_url(fork, pr))
    assert deleted.status_code == 403, deleted.content

    pr.refresh_from_db()
    assert pr.user_input == "my secret question 0"
    assert public_convo.prompt_response_set.count() == 2


# --------------------------------------------------------------------------
# ConversationViewSet — listing / retrieval / mutation
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_attacker_cannot_retrieve_victim_conversation(
    api_client, attacker, victim_conversation
):
    api_client.force_authenticate(user=attacker)
    resp = api_client.get(f"/api/ai/conversations/{victim_conversation.id}/")
    assert resp.status_code == 404, resp.status_code
    assert "secret answer" not in resp.content.decode()


@pytest.mark.django_db
def test_attacker_cannot_delete_victim_conversation(
    api_client, attacker, victim_conversation
):
    api_client.force_authenticate(user=attacker)
    resp = api_client.delete(f"/api/ai/conversations/{victim_conversation.id}/")
    assert resp.status_code == 404, resp.status_code
    assert Conversation.objects.filter(id=victim_conversation.id).exists()


# --------------------------------------------------------------------------
# fork — the exfiltration primitive
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_attacker_cannot_fork_private_conversation(
    api_client, attacker, victim_conversation
):
    pr = victim_conversation.prompt_response_set.first()
    api_client.force_authenticate(user=attacker)

    resp = api_client.post(
        "/api/ai/conversations/fork/",
        {"conversation": str(victim_conversation.id), "prompt_response": pr.id},
        format="json",
    )

    assert resp.status_code == 404, resp.content
    assert not Conversation.objects.filter(user=attacker).exists()


@pytest.mark.django_db
def test_fork_rejects_a_prompt_response_from_another_conversation(
    api_client, attacker, victim, ai_model
):
    """Cross-conversation fork point: previously the break never fired and the
    whole conversation was copied instead of the requested prefix."""
    public_convo = _conversation_with_messages(victim, ai_model, is_public=True)
    other_private = _conversation_with_messages(victim, ai_model)
    foreign_pr = other_private.prompt_response_set.first()

    api_client.force_authenticate(user=attacker)
    resp = api_client.post(
        "/api/ai/conversations/fork/",
        {"conversation": str(public_convo.id), "prompt_response": foreign_pr.id},
        format="json",
    )

    assert resp.status_code == 404, resp.content
    assert not Conversation.objects.filter(user=attacker).exists()


@pytest.mark.django_db
def test_forking_a_public_conversation_still_works(
    api_client, attacker, victim, ai_model
):
    """The product feature (fork someone else's PUBLIC conversation) survives."""
    public_convo = _conversation_with_messages(victim, ai_model, is_public=True)
    first_pr = public_convo.prompt_response_set.first()

    api_client.force_authenticate(user=attacker)
    resp = api_client.post(
        "/api/ai/conversations/fork/",
        {"conversation": str(public_convo.id), "prompt_response": first_pr.id},
        format="json",
    )

    assert resp.status_code == 201, resp.content
    fork = Conversation.objects.get(id=resp.json()["id"])
    assert fork.user == attacker
    # Only the prefix up to (and including) the fork point.
    assert list(fork.prompt_response_set.all()) == [first_pr]


@pytest.mark.django_db
def test_fork_with_garbage_ids_is_a_4xx_not_a_500(api_client, attacker):
    api_client.force_authenticate(user=attacker)

    for payload in (
        {},
        {"conversation": "not-a-uuid", "prompt_response": 1},
        {"conversation": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
         "prompt_response": "nope"},
    ):
        resp = api_client.post(
            "/api/ai/conversations/fork/", payload, format="json"
        )
        assert 400 <= resp.status_code < 500, (payload, resp.status_code)


# --------------------------------------------------------------------------
# public prompt responses — must stay scoped to the conversation in the URL
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_public_promptresponses_do_not_leak_other_conversations(
    api_client, victim, ai_model
):
    public_a = _conversation_with_messages(victim, ai_model, is_public=True)
    private_b = _conversation_with_messages(victim, ai_model)

    resp = api_client.get(
        f"/api/ai/public-conversations/{public_a.id}/promptresponses/"
    )
    assert resp.status_code == 200, resp.content

    returned = {row["id"] for row in resp.json()["results"]}
    assert returned == {pr.id for pr in public_a.prompt_response_set.all()}
    assert returned.isdisjoint({pr.id for pr in private_b.prompt_response_set.all()})


# --------------------------------------------------------------------------
# Privilege escalation via the writable `personality` field
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_attacker_cannot_attach_victims_private_personality(
    api_client, attacker, victim, ai_model
):
    """`update` only validated the personality already ON the instance.

    Attaching the victim's Personality primes `Conversation.generate` with their
    private `system_message`, which the model will happily read back.
    """
    from dj.apps.openai.models import Personality

    secret = Personality.objects.create(
        creator=victim,
        display_name="victim's secret persona",
        system_message="my proprietary prompt engineering",
    )
    mine = Conversation.objects.create(
        ai_model=ai_model, user=attacker, display_name="mine"
    )

    api_client.force_authenticate(user=attacker)
    resp = api_client.patch(
        f"/api/ai/conversations/{mine.id}/",
        {"personality": str(secret.id)},
        format="json",
    )

    assert resp.status_code == 400, resp.content
    mine.refresh_from_db()
    assert mine.personality_id is None


@pytest.mark.django_db
def test_shared_and_own_personalities_still_attach(
    api_client, attacker, ai_model
):
    """The scoping must not break the legitimate path."""
    from dj.apps.openai.models import Personality

    shared = Personality.objects.create(
        creator=None, display_name="Default", system_message="be helpful",
        is_public=True,
    )
    mine_persona = Personality.objects.create(
        creator=attacker, display_name="Mine", system_message="be terse",
    )
    convo = Conversation.objects.create(
        ai_model=ai_model, user=attacker, display_name="mine"
    )
    api_client.force_authenticate(user=attacker)

    for persona in (shared, mine_persona):
        resp = api_client.patch(
            f"/api/ai/conversations/{convo.id}/",
            {"personality": str(persona.id)},
            format="json",
        )
        assert resp.status_code == 200, resp.content
        convo.refresh_from_db()
        assert convo.personality_id == persona.id


# --------------------------------------------------------------------------
# WebSocket — the same disclosure over a different transport
# --------------------------------------------------------------------------


async def _connect(conversation_id, user):
    from channels.testing import WebsocketCommunicator
    from dj.apps.openai.consumers import ConversationConsumer

    communicator = WebsocketCommunicator(
        ConversationConsumer.as_asgi(),
        f"/ws/conversations/{conversation_id}/",
    )
    communicator.scope["url_route"] = {
        "kwargs": {"conversation_id": str(conversation_id)}
    }
    communicator.scope["user"] = user
    connected, _ = await communicator.connect()
    await communicator.disconnect()
    return connected


@pytest.mark.django_db(transaction=True)
async def test_attacker_cannot_subscribe_to_victims_conversation_stream(
    attacker, victim, ai_model
):
    """`ConversationConsumer` used to accept() with no auth and no ownership
    check, streaming the victim's AI response token-by-token to anyone who
    knew the conversation UUID."""
    from django.contrib.auth.models import AnonymousUser
    from asgiref.sync import sync_to_async

    conversation = await sync_to_async(_conversation_with_messages)(
        victim, ai_model
    )

    assert await _connect(conversation.id, attacker) is False
    assert await _connect(conversation.id, AnonymousUser()) is False
    #... and the owner is still let in.
    assert await _connect(conversation.id, victim) is True


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("stream_id", [None, "generation-123"])
async def test_ws_group_name_is_the_canonical_lowercase_uuid(
        victim, ai_model, stream_id):
    """The route regex accepts UPPERCASE uuids, but `Conversation.generate` publishes to
    `f'conversation_{self.id}'` (always lowercase). Joining the raw URL string
    would authenticate fine and then silently stream nothing."""
    from channels.testing import WebsocketCommunicator
    from asgiref.sync import sync_to_async
    from dj.apps.openai.consumers import ConversationConsumer

    conversation = await sync_to_async(_conversation_with_messages)(
        victim, ai_model
    )
    upper = str(conversation.id).upper()

    communicator = WebsocketCommunicator(
        ConversationConsumer.as_asgi(), f"/ws/conversations/{upper}/"
    )
    communicator.scope["url_route"] = {"kwargs": {"conversation_id": upper}}
    communicator.scope["user"] = victim
    connected, _ = await communicator.connect()
    assert connected is True

    # Publish exactly the way Conversation.generate does -- to the
    # lowercase canonical id -- and require the uppercase-connected owner to
    # actually receive it.
    from channels.layers import get_channel_layer

    channel_layer = get_channel_layer()
    event = {"type": "send_word", "message": "hello"}
    if stream_id is not None:
        event["stream_id"] = stream_id
    await channel_layer.group_send(
        f"conversation_{conversation.id}",
        event,
    )

    received = await communicator.receive_json_from(timeout=5)
    expected = {"message": "hello"}
    if stream_id is not None:
        expected["stream_id"] = stream_id
    assert received == expected
    await communicator.disconnect()
