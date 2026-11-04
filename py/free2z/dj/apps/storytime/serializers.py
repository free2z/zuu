from rest_framework import serializers

from .models import Page, Story

from dj.apps.g12f.serializers.creator import CreatorListSerializer


#Image sizes the Storytime image call accepts. Anything else is refused before
#the provider is called; the default keeps the endpoint's historical size.
#The Storytime call names no ``model``, so these are the sizes of the API's
#default image model, not of ``settings.OPENAI_IMAGE_MODEL`` (which only the
#/api/openai image endpoint uses). Change both together or neither.
STORYTIME_IMAGE_SIZES = ("256x256", "512x512", "1024x1024")
STORYTIME_DEFAULT_IMAGE_SIZE = "512x512"


class _StringField(serializers.CharField):
    """A CharField that refuses non-string JSON values instead of coercing
    them (DRF's CharField turns ``123`` into ``"123"``)."""

    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


class StorytimePromptRequestSerializer(serializers.Serializer):
    """The body of a paid Storytime request, validated before anything is
    claimed, held or sent to a provider.

    The prompt bound is the ``Page.prompt`` column's own ``max_length``, so a
    prompt that is accepted here can always be stored once the provider has
    answered. CharField's built-in validators also refuse NUL and lone
    surrogate characters, which PostgreSQL cannot store either.
    """

    prompt = _StringField(
        max_length=Page._meta.get_field("prompt").max_length,
        allow_blank=False,
        trim_whitespace=False,
    )


class StorytimeImageRequestSerializer(StorytimePromptRequestSerializer):
    size = serializers.ChoiceField(
        choices=STORYTIME_IMAGE_SIZES,
        default=STORYTIME_DEFAULT_IMAGE_SIZE,
    )


class PageSerializer(serializers.ModelSerializer):
    image_url = serializers.SerializerMethodField()

    class Meta:
        model = Page
        fields = (
            'prompt', 'content',
            'image_url',
            'order', 'created_at', 'updated_at',
        )

    def get_image_url(self, obj):
        if obj.image:
            return obj.image.get_url()
        return None


class StoryFullSerializer(serializers.ModelSerializer):
    creator = CreatorListSerializer(read_only=True)
    pages = PageSerializer(many=True, read_only=True)

    class Meta:
        model = Story
        fields = ("creator", "title", "slug", "is_published",
                  "created_at", "updated_at", "pages")
        read_only_fields = ("creator", "slug", "created_at",
                            "updated_at", "pages")
