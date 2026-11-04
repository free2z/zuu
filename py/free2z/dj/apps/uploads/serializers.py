
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .models import GenericFile, ImageVariant


class ImageVariantSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()

    class Meta:
        model = ImageVariant
        fields = ['width', 'url']

    def get_url(self, obj: ImageVariant) -> str:
        return obj.get_url()


class ImageVariantsMixin(serializers.Serializer):
    """
    The image size ladder. `thumb`/`card`/`banner` are
    purpose-named conveniences into the same ladder `variants` exposes
    in full (for srcset). All are None until the worker has processed
    the upload, and None for non-image files; they never point at the
    original.
    """
    thumb = serializers.SerializerMethodField()
    card = serializers.SerializerMethodField()
    banner = serializers.SerializerMethodField()
    variants = serializers.SerializerMethodField()
    poster = serializers.SerializerMethodField()

    def get_poster(self, obj: GenericFile) -> str | None:
        """Extracted still for a VIDEO upload; None for everything else.

        Served under the video's own access prefix -- never copied to a
        second, more public location. None means no poster
        exists: render a blank player, and do NOT declare a `thumbnailUrl`
        for it.
        """
        return obj.get_poster()

    def get_thumb(self, obj: GenericFile) -> str | None:
        return obj.variant_url(128)

    def get_card(self, obj: GenericFile) -> str | None:
        return obj.variant_url(400)

    def get_banner(self, obj: GenericFile) -> str | None:
        return obj.variant_url(1600)

    @extend_schema_field(ImageVariantSerializer(many=True))
    def get_variants(self, obj: GenericFile):
        return ImageVariantSerializer(obj._variant_ladder(), many=True).data


class GenericFileSerializer(ImageVariantsMixin, serializers.ModelSerializer):

    url = serializers.SerializerMethodField('get_url')
    name = serializers.SerializerMethodField('get_name')
    thumbnail = serializers.SerializerMethodField('get_thumbnail')

    class Meta:
        model = GenericFile
        fields = [
            'id', 'created_at', "updated_at", "title",
            'description', "url", 'access', 'mime_type',
            'name', 'thumbnail',
            'thumb', 'card', 'banner', 'variants', 'poster',
        ]
        read_only_fields = ["id", "created_at", "updated_at", "mime_type"]

    def get_url(self, obj: GenericFile):
        # return f"https://test.free2give.xyz/uploadz/{obj.file.name}"
        return obj.get_url()

    def get_name(self, obj):
        return obj.file.name

    def get_thumbnail(self, obj):
        return obj.get_thumbnail()


class FeaturedImageSerializer(ImageVariantsMixin, serializers.ModelSerializer):
    url = serializers.SerializerMethodField()
    name = serializers.SerializerMethodField()
    thumbnail = serializers.SerializerMethodField()

    class Meta:
        model = GenericFile
        fields = (
            'id', 'url', 'name',
            'thumbnail',
            'thumb', 'card', 'banner', 'variants', 'poster',
            'created_at', "updated_at",
            "title", 'description', 'access', 'mime_type',
        )
        # Same set as `GenericFileSerializer`, and for the same reason.
        # `mime_type` is the type the server SNIFFED from the file's bytes
        #  never anything a client sent. Both upload views overwrite
        # it in `validated_data` after validation, so nothing writes it
        # through a serializer field; leaving it writable only let
        # `PATCH /api/myuploads/<id>/` overwrite the sniffed value with an
        # arbitrary string. `id`/`created_at`/`updated_at` are already
        # read-only by construction (pk, `auto_now_add`, `auto_now`); they are
        # named here so the contract is stated rather than inferred.
        #
        # `title`, `description` and `access` stay writable — they are what
        # this endpoint exists to edit. `url`, `name`, `thumbnail`, `thumb`,
        # `card`, `banner` and `variants` are `SerializerMethodField`s and so
        # already read-only; declaring them here would be an error, not a
        # belt-and-braces.
        read_only_fields = ["id", "created_at", "updated_at", "mime_type"]

    def get_url(self, obj):
        return obj.get_url()

    def get_name(self, obj):
        return obj.file.name

    def get_thumbnail(self, obj):
        return obj.get_thumbnail()
