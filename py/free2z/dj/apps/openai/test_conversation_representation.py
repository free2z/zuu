"""One representation per conversation, whichever action answers it.

``/api/ai/conversations/`` answered ``user`` as an OBJECT on create, update,
partial_update and list, and as an integer id on retrieve, because
``ConversationDetailSerializer`` let the field fall through to the
ModelSerializer FK default. ``model_name`` was likewise missing from retrieve.
A client that stores a write body in place of a read body (the classic app's
AIEditConversation does exactly that) silently changed a field's type.

The contract pinned here: the retrieve body is the summary body plus
``prompt_response_set``, and every field they share is identical, for the
owner's endpoint and the public one. Real Postgres, real views.

A second split surfaced while pinning it: ``CreatorListSerializer.is_live``
was ``BooleanField(read_only=True, default=False)``, and DRF skips a field's
default whenever the root serializer is ``partial``, so the PATCH body's
``user`` lacked ``is_live`` while the GET's had it. ``AnnotationFlagField``
fixes that for every PATCH that nests a creator.

Negative controls (both run): delete ``user = CreatorListSerializer(...)``
from ``ConversationDetailSerializer`` and all three tests go red; put the
plain ``BooleanField`` back on ``is_live`` and the PATCH comparison goes red.
"""
import json

import pytest

from dj.apps.openai.models import AIModel, Conversation, PromptResponse

DETAIL_ONLY = {"prompt_response_set"}


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
    return creator_factory(username="convo-owner")


def _add_turn(conversation, user, ai_model):
    pr = PromptResponse.objects.create(
        ai_model=ai_model, user=user,
        user_input="question", response="answer",
    )
    conversation.prompt_response_set.add(pr)


def _assert_same_representation(summary, detail):
    """`detail` is `summary` plus the transcript, field for field."""
    assert set(detail) - set(summary) == DETAIL_ONLY, (
        sorted(set(detail) ^ set(summary)))
    assert set(summary) - set(detail) == set()
    differing = {
        k: (summary[k], detail[k]) for k in summary if summary[k] != detail[k]
    }
    assert differing == {}, json.dumps(differing, sort_keys=True, default=str)


@pytest.mark.django_db
def test_retrieve_matches_create_patch_and_list(api_client, owner, ai_model):
    api_client.force_authenticate(user=owner)

    created = api_client.post(
        "/api/ai/conversations/",
        {"display_name": "shape check", "ai_model": str(ai_model.id)},
        format="json",
    )
    assert created.status_code == 200, created.content
    cid = created.json()["id"]
    # `user` is the object everywhere, never a bare id.
    assert created.json()["user"]["username"] == owner.username

    detail = api_client.get(f"/api/ai/conversations/{cid}/")
    assert detail.status_code == 200, detail.content
    _assert_same_representation(created.json(), detail.json())

    patched = api_client.patch(
        f"/api/ai/conversations/{cid}/",
        {"display_name": "renamed"}, format="json",
    )
    assert patched.status_code == 200, patched.content
    detail = api_client.get(f"/api/ai/conversations/{cid}/")
    _assert_same_representation(patched.json(), detail.json())

    listed = api_client.get("/api/ai/conversations/")
    assert listed.status_code == 200, listed.content
    rows = listed.json()
    rows = rows["results"] if isinstance(rows, dict) else rows
    [row] = [r for r in rows if r["id"] == cid]
    _assert_same_representation(row, detail.json())
    assert detail.json()["model_name"] == "Test Model"


@pytest.mark.django_db
def test_public_retrieve_matches_public_list(api_client, owner, ai_model):
    conversation = Conversation.objects.create(
        ai_model=ai_model, user=owner, display_name="public one",
        is_public=True,
    )
    _add_turn(conversation, owner, ai_model)

    detail = api_client.get(f"/api/ai/public-conversations/{conversation.id}/")
    assert detail.status_code == 200, detail.content
    assert detail.json()["user"]["username"] == owner.username
    assert len(detail.json()["prompt_response_set"]) == 1

    listed = api_client.get("/api/ai/public-conversations/")
    assert listed.status_code == 200, listed.content
    rows = listed.json()
    rows = rows["results"] if isinstance(rows, dict) else rows
    [row] = [r for r in rows if r["id"] == str(conversation.id)]
    _assert_same_representation(row, detail.json())


def test_the_published_schemas_agree():
    """The generated clients read f2z.yaml, so the spec must say the same:
    every property of `Conversation` appears in `ConversationDetail` with the
    same schema, and the transcript is the only addition."""
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    components = schema["components"]["schemas"]
    summary = components["Conversation"]["properties"]
    detail = components["ConversationDetail"]["properties"]

    assert set(detail) - set(summary) == DETAIL_ONLY
    for name, prop in summary.items():
        assert detail[name] == prop, name
    assert set(components["ConversationDetail"]["required"]) == (
        set(components["Conversation"]["required"]) | DETAIL_ONLY
    )


def test_ai_request_error_documents_parser_rejections():
    """The union documents parser, idempotency, billing, and actor errors."""
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    components = schema["components"]["schemas"]
    variants = components["AIRequestError"]["anyOf"]

    assert {variant["$ref"] for variant in variants} == {
        "#/components/schemas/AINotChargedError",
        "#/components/schemas/AIIdempotencyError",
        "#/components/schemas/AIParserError",
        "#/components/schemas/ExpectedActorError",
    }
    assert components["AIParserError"]["properties"] == {
        "detail": {"type": "string"},
    }
    assert components["ExpectedActorError"]["properties"] == {
        "code": {"$ref": "#/components/schemas/ExpectedActorErrorCodeEnum"},
        "detail": {"type": "string"},
    }
    actor_code = components["ExpectedActorErrorCodeEnum"]
    assert actor_code["enum"] == ["account_changed"]
    assert actor_code["type"] == "string"
    assert set(components["ExpectedActorError"]["required"]) == {
        "code",
        "detail",
    }
    assert "oneOf" not in components["AIRequestError"]


def test_image_safety_refusal_documents_terminal_receipt_fields():
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    operation = schema["paths"]["/api/openai/image"]["post"]
    key_parameter = next(
        parameter for parameter in operation["parameters"]
        if parameter["in"] == "header" and parameter["name"] == "Idempotency-Key"
    )
    assert key_parameter.get("required", False) is False
    assert key_parameter["schema"]["format"] == "uuid"
    assert "required when hosted fal is selected" in key_parameter["description"]
    assert "idempotency_key_required before a receipt, charge, or provider call" in key_parameter["description"]
    assert "dispatch never started" in key_parameter["description"]
    assert "not automatically resubmitted" in key_parameter["description"]

    response = operation["responses"]["400"]
    assert response["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ImageRequestError",
    }
    assert "before receipt creation, charge, or provider dispatch" in response["description"]
    assert {variant["$ref"] for variant in schema["components"]["schemas"]["ImageRequestError"]["anyOf"]} == {
        "#/components/schemas/ImageSafetyRefusal", "#/components/schemas/AIParserError",
        "#/components/schemas/AIIdempotencyError", "#/components/schemas/ImageFieldValidationError",
    }
    refusal = schema["components"]["schemas"]["ImageSafetyRefusal"]
    assert set(refusal["required"]) == {"code", "detail", "key_resolved"}
    assert refusal["properties"]["key_resolved"]["type"] == "boolean"
