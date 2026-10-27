from rest_framework import serializers
from drf_spectacular.utils import extend_schema_field

from taggit.serializers import TagListSerializerField

from dj.apps.g12f.models import Creator
from dj.apps.g12f.zpage_paths import negotiated_content_url
from dj.apps.uploads.serializers import FeaturedImageSerializer
from .models import Comment
from .visibility import (
    COMMENT_THREAD_ACCESS_CHOICES,
    author_redacted,
    comment_thread_access,
    comment_thread_access_owner_id,
)


#The author a placeholder comment is served with. Not a username anybody
#can hold -- brackets fail every account-creation path's username
#validation -- so its profile link (`/<username>`) can never be claimed,
#and it is the same for every deleted author, so it links none of them.
REDACTED_AUTHOR_NAME = "[deleted]"


class CommentAuthorSerializer(serializers.ModelSerializer):

    avatar_image = FeaturedImageSerializer()

    class Meta:
        model = Creator
        fields = ['username', 'avatar_image']


class CommentListSerializer(serializers.ModelSerializer):
    """
    The one we use for zPages and converse
    """
    author = CommentAuthorSerializer(read_only=True)
    tags = TagListSerializerField(read_only=True)
    num_children = serializers.SerializerMethodField()
    content_url = serializers.SerializerMethodField()
    thread_access = serializers.SerializerMethodField()
    thread_access_owner_id = serializers.SerializerMethodField()

    class Meta:
        model = Comment
        fields = [
            'uuid', 'author', 'parent', 'headline', 'content',
            'tuzis', 'created_at', 'updated_at', 'tags',
            'num_children', 'content_url', 'thread_access',
            'thread_access_owner_id',
        ]
        read_only_fields = [
            # only headline and content are editable
            'uuid',
            'author',
            'created_at',
            'updated_at',
            'content_url',
            'num_children',
            'tags',
            'thread_access',
            'thread_access_owner_id',
        ]
        extra_kwargs = {
            # ``Comment.tuzis`` has a model default, so DRF would infer
            # ``required=False``. But DRF never injects a model default into
            # ``validated_data``, and every create route prices the comment
            # from ``validated_data['tuzis']`` -- so an omitted amount was a
            # ``KeyError`` 500. The amount is the price the
            # caller agreed to pay; it is never defaulted server side. On
            # PUT/PATCH ``get_fields`` makes it read-only, so this only binds
            # on create.
            'tuzis': {'required': True},
        }

    def get_fields(self, *args, **kwargs):
        fields = super(CommentListSerializer, self).get_fields(*args, **kwargs)
        request = self.context.get('request', None)
        if request and getattr(request, 'method', None) in ['PUT', 'PATCH']:
            fields['tuzis'].read_only = True
            fields['parent'].read_only = True
        return fields

    def to_representation(self, instance):
        """Keep UUID primary keys JSON-safe in stored idempotency receipts."""
        data = super().to_representation(instance)
        for field in ("uuid", "parent"):
            value = data.get(field)
            if value is not None and not isinstance(value, str):
                data[field] = str(value)
        if author_redacted(instance):
            # A thread placeholder (visibility.DELETION_PENDING_AUTHOR), the
            # same before the purge and after it: no text, no tags, and an
            # author that is not the account.
            data.update(headline="", content="", tags=[], author={
                "username": REDACTED_AUTHOR_NAME,
                "avatar_image": None,
            })
        return data

    def get_num_children(self, obj):
        # Depending on your application's usage patterns,
        # counting replies with obj.replies.count() for every comment
        # during serialization can be expensive if you have
        # a large number of comments and replies.
        # In that case, you might want to use
        # database annotations or caching strategies.
        return obj.replies.count()

    def get_content_url(self, obj):
        """
        Retrieve the url of the content object
        """
        content_object = obj.content_object
        if not content_object:
            return None
        return negotiated_content_url(
            content_object,
            self.context.get('request'),
        )

    @extend_schema_field(
        serializers.ChoiceField(choices=COMMENT_THREAD_ACCESS_CHOICES)
    )
    def get_thread_access(self, obj):
        return comment_thread_access(obj)

    @extend_schema_field(serializers.IntegerField(allow_null=True))
    def get_thread_access_owner_id(self, obj):
        return comment_thread_access_owner_id(obj)

    def validate_tuzis(self, value):
        """
        Ensure tuzis is a positive integer.
        """
        if value < 1:
            raise serializers.ValidationError("Tuzis must be a positive integer.")
        return value


class CommentEditSerializer(CommentListSerializer):
    """Edit body for PUT/PATCH /api/comments/<uuid>/: amount and parent are fixed.

    Schema-only; at runtime the view keeps ``CommentListSerializer``, whose
    ``get_fields`` makes ``tuzis`` and ``parent`` read-only on PUT/PATCH. The
    PUT body used to share the ``CommentList`` component with the create body
    and the responses, so once create requires ``tuzis`` a generated client
    would demand an amount to fix a typo.
    """

    class Meta(CommentListSerializer.Meta):
        read_only_fields = CommentListSerializer.Meta.read_only_fields + [
            'tuzis',
            'parent',
        ]
        extra_kwargs = {}


class CommentCreateSerializer(serializers.ModelSerializer):
    author = serializers.CharField(source='author.username', read_only=True)
    tuzis = serializers.IntegerField(min_value=1, required=True)

    class Meta:
        model = Comment
        fields = [
            'uuid', 'author', 'parent', 'headline',
            'content', 'tuzis', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'uuid', 'author', 'created_at', 'updated_at',
        ]

    def create(self, validated_data):
        """Create a comment; chargeable views own the debit and 402 contract."""
        user = self.context['request'].user
        validated_data['author'] = user
        return super().create(validated_data)
