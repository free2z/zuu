import markdown2

from django.utils.html import strip_tags
from django.utils.text import slugify

from rest_framework import serializers
from taggit.serializers import (TagListSerializerField,
                                TaggitSerializer)

from dj.apps.g12f.models.comment import PageComment

from dj.apps.g12f.models import zPage, Creator
from dj.apps.uploads.serializers import (
    FeaturedImageSerializer
)
from dj.apps.uploads.models import GenericFile


class zPageDestroySerializer(serializers.ModelSerializer):
    class Meta:
        model = zPage
        fields = ['free2zaddr']
        read_only_fields = ['free2zaddr']


class zPageUpdateSerializer(TaggitSerializer, serializers.ModelSerializer):

    featured_image = serializers.PrimaryKeyRelatedField(
        queryset=GenericFile.objects.none(), required=False, allow_null=True
    )
    tags = TagListSerializerField()

    class Meta:
        model = zPage
        fields = (
            'free2zaddr',
            'vanity',
            'p2paddr',
            'title',
            'content',
            'is_published',
            'is_subscriber_only',
            'category',
            'f2z_score',
            'get_url',
            'featured_image',
            'tags',
            'publish_at',
            'description',
        )
        read_only_fields = ['free2zaddr', 'f2z_score', 'get_url']

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if hasattr(self, 'context') and 'request' in self.context:
            request = self.context['request']

            if request.user.is_anonymous:
                return
                # for some reason, this is called when listing
                # raise PermissionDenied(
                #     "Anonymous users cannot update this page.")

            self.fields['featured_image'].queryset = GenericFile.objects.filter(
                owner=request.user
            )

    def validate_featured_image(self, value):
        if value:
            if not value.mime_type.startswith('image/'):
                raise serializers.ValidationError(
                    "The featured image must have image mime_type")

            if value.access != "public":
                raise serializers.ValidationError(
                    "The featured image must have access set to 'public'")

        return value

    def validate_vanity(self, value):
        # empty is a choice
        if not value:
            return value

        if not self.instance:
            return value

        value = slugify(value)
        # unchanged
        if value == self.instance.vanity:
            return value

        # TODO: later when zPage is always under creator,
        # maybe vanity doesn't need to be unique? ;()

        # it has changed to somethinng that someone else owns
        if zPage.objects.filter(vanity=value).count():
            raise serializers.ValidationError("Vanity is not unique!")

        if Creator.objects.filter(username=value).count():
            raise serializers.ValidationError("Vanity can not be username")

        # TODO: general model validation?
        if len(value) > 128:
            raise serializers.ValidationError(
                "Vanity is too long! Less than 128 please"
            )

        return value


class SimpleCreatorSerializer(serializers.ModelSerializer):
    avatar_image = FeaturedImageSerializer()

    class Meta:
        model = Creator
        fields = [
            'username',
            'avatar_image',
            'p2paddr',
            'member_price',
            'full_name',
        ]


class zPageListSerializer(
    TaggitSerializer,
    serializers.ModelSerializer
):
    p2paddr = serializers.CharField(source='get_p2paddr')
    creator = SimpleCreatorSerializer()
    content = serializers.SerializerMethodField()
    tags = TagListSerializerField()
    featured_image = FeaturedImageSerializer()

    class Meta:
        model = zPage
        fields = (
            'free2zaddr',
            # User controlled #######
            'vanity',
            'p2paddr',
            'title',
            # 'content',
            'category',
            'is_published',
            'is_subscriber_only',
            'featured_image',
            'description',
            # #####################
            'is_verified',
            'total',
            'f2z_score',
            'created_at',
            'updated_at',
            'get_url',
            'creator',
            'content',
            'tags',
        )
        read_only_fields = [
            'free2zaddr',
            'is_verified',
            'total',
            'f2z_score',
            'updated_at',
            'created_at',
            'get_url',
            'creator',
            'featured_image',
        ]

    def get_content(self, instance: zPage):
        if instance.description:
            return instance.description

        if hasattr(instance, 'truncated_content'):
            truncated_content = instance.truncated_content
            html = markdown2.markdown(truncated_content)
            text = strip_tags(html)
            return f"{text[:365]}..."

        return instance.content


class PageCommentSerializer(serializers.ModelSerializer):
    class Meta:
        model = PageComment
        fields = ['created_at', 'comment']


class zPageDetailSerializer(
    TaggitSerializer,
    serializers.ModelSerializer
):
    """
    Only for retrieval
    """
    creator = SimpleCreatorSerializer()
    p2paddr = serializers.CharField(source='get_p2paddr')
    comments = PageCommentSerializer(many=True, read_only=True)
    tags = TagListSerializerField()
    featured_image = FeaturedImageSerializer()

    class Meta:
        model = zPage
        fields = (
            'free2zaddr',
            # User controlled #######
            'vanity',
            'p2paddr',
            'title',
            'content',
            'category',
            'is_published',
            'is_subscriber_only',
            'total_raised',
            'featured_image',
            'description',
            # #####################
            'is_verified',
            'total',
            'f2z_score',
            'comments',
            'creator',
            'created_at',
            'updated_at',
            'get_url',
            'tags',
            'publish_at',
        )
        read_only_fields = [
            'free2zaddr',
            'is_verified' 'total',
            'f2z_score',
            'comments',
            'created_at',
            'updated_at',
            'creator',
            'get_url',
            'featured_image',
        ]
