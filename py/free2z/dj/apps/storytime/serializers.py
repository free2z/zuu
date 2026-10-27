from rest_framework import serializers

from .models import Page, Story

from dj.apps.g12f.serializers.creator import CreatorListSerializer


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
