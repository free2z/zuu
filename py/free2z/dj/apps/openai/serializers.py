from django.db.models import Q

from rest_framework import serializers
from rest_framework.exceptions import ValidationError

from dj.apps.g12f.serializers.creator import CreatorListSerializer
from .models import AIModel, Conversation, PromptResponse, Personality
from django.contrib.auth.models import User

class AIModelSerializer(serializers.ModelSerializer):
    class Meta:
        model = AIModel
        # The gateway catalogue columns  are for the signed catalogue
        # endpoint, not this one: excluded so `/api/ai/models/` and every
        # nested `ai_model` answer exactly what they did before they landed.
        exclude = [
            'provider_model_id',
            'api_style',
            'ttfb_timeout_ms',
            'idle_timeout_ms',
            'safety_factor_bps',
            'supports_tools',
            'supports_vision',
            'supports_reasoning',
            'supports_structured_output',
            'supports_strict_tools',
            'supports_reasoning_effort',
            'reasoning_effort_levels',
        ]


class AIPersonalitySerializer(serializers.ModelSerializer):
    creator = serializers.CharField(source='creator.username', read_only=True)

    class Meta:
        model = Personality
        fields = '__all__'


class PromptResponseSerializer(serializers.ModelSerializer):

    ai_model = AIModelSerializer(read_only=True)
    personality = AIPersonalitySerializer(read_only=True)
    user = CreatorListSerializer(read_only=True)

    class Meta:
        model = PromptResponse
        fields = '__all__'
        # Is everything read only?:thinking:
        read_only_fields = [
            'id', 'response', 'created_at', 'updated_at',
            'ai_model', 'personality', 'user',
        ]


class ConversationDetailSerializer(serializers.ModelSerializer):
    """A conversation with its transcript: the same fields as `Conversation`
    (list, create, update), plus `prompt_response_set`."""

    # (A comment, not docstring: drf-spectacular publishes the docstring.)
    # Every field ConversationSerializer answers is answered here with the
    # SAME shape. `user` used to fall through to the ModelSerializer
    # FK default and serialize as an integer id here while every other action
    # answered an object, so a client that stored a PATCH body over a GET body
    # (the classic app's AIEditConversation does) silently changed the field's
    # type. test_conversation_representation pins the two together.
    # personality = AIPersonalitySerializer()
    prompt_response_set = PromptResponseSerializer(many=True, read_only=True)
    tags = serializers.SerializerMethodField()
    user = CreatorListSerializer(read_only=True)
    model_name = serializers.CharField(
        source='ai_model.display_name', read_only=True
    )

    class Meta:
        model = Conversation
        fields = [
            'display_name', 'is_public', 'is_subscriber_only', 'ai_model',
            'personality',
            # read only fields
            'id', 'user',
            'created_at', 'updated_at',
            'model_name',
            'prompt_response_set',
            'tags',
        ]
        read_only_fields = [
            'id', 'user',
            'created_at', 'updated_at',
            'model_name',
            'prompt_response_set',
            'tags',
        ]

    def get_tags(self, obj):
        return [tag.name for tag in obj.tags.all()]


class ConversationSerializer(serializers.ModelSerializer):
    """
    this is for private listing
    it is also used for create and update
    probably other stuff.
    TODO: fully document all serializers and views and maybe combine
    """
    model_name = serializers.CharField(
        source='ai_model.display_name', read_only=True
    )
    tags = serializers.SerializerMethodField()
    user = CreatorListSerializer(read_only=True)

    class Meta:
        model = Conversation
        fields = [
            'display_name',
            'is_public',
            'is_subscriber_only',
            'ai_model',
            'personality',
            # read-only
            'id', 'user', 'created_at', 'updated_at',
            'model_name', 'tags',
        ]
        read_only_fields = [
            'id', 'user', 'created_at', 'updated_at',
            'model_name', 'tags',
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Security: `personality` is writable and not read-only, so DRF
        # auto-builds a PrimaryKeyRelatedField over `Personality.objects.all()`
        # -- unscoped. `create()` and `fork()` both check ownership explicitly,
        # but `update()` only validated the personality already ON the instance,
        # never the incoming one. So a PATCH could attach ANOTHER user's private
        # Personality to your own conversation; `Conversation.generate`
        # then primes the model with `personality.system_message`, and "repeat
        # your system prompt" reads back their private prompt engineering.
        #
        # Scoping the field queryset closes create/update/partial_update in one
        # place. The predicate matches `create()`'s existing rule exactly
        # (creator IS NULL -> the shared/system personalities, or your own), so
        # no legitimate request is newly rejected. Fails CLOSED (`none()`) if
        # request context is ever missing -- same convention as the
        # `featured_image` / `avatar_image` fields in g12f.
        # Availability: `ai_model` is writable, so DRF auto-builds a
        # PrimaryKeyRelatedField over `AIModel.objects.all()` -- every row,
        # including ones flagged off. `ConversationViewSet.create` bypasses
        # this serializer and checks for itself, but `update` /
        # `partial_update` go through here, so without the scoping a PATCH
        # could move a live conversation onto a disabled model and the next
        # prompt would 409 forever. Scoped to `enabled().discovered()` and NOT
        # to `selectable()`: `is_ga` is a picker/lineup flag, and narrowing an
        # existing conversation's model to the current lineup is a separate
        # product decision this PR deliberately does not make. `discovered()`
        # ( follow-up) is availability, like `is_enabled`: a model its
        # provider stopped listing takes no NEW work anywhere, not just in
        # the picker.
        ai_model_field = self.fields.get('ai_model')
        if ai_model_field is not None and hasattr(ai_model_field, 'queryset'):
            ai_model_field.queryset = AIModel.objects.enabled().discovered(upstream=False)

        personality_field = self.fields.get('personality')
        if personality_field is None:
            return
        request = self.context.get('request')
        user = getattr(request, 'user', None)
        if user is None or not user.is_authenticated:
            personality_field.queryset = Personality.objects.none()
        else:
            personality_field.queryset = Personality.objects.filter(
                Q(creator__isnull=True) | Q(creator=user)
            )

    def get_tags(self, obj):
        return [tag.name for tag in obj.tags.all()]

    def validate(self, attrs):
        action = self.context.get('view').action
        ai_model = attrs.get('ai_model')
        personality = attrs.get('personality')

        # Must have model and personality during creation!
        if action == 'create':
            if ai_model is None:
                raise ValidationError({"ai_model": "This field is required."})

            if personality is None:
                raise ValidationError({"personality": "This field is required."})

        return attrs
