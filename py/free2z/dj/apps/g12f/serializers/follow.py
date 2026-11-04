"""Serializers for the free creator-follow API.

Both of these are response-only. The follow relationship is fully identified by
(authenticated caller, creator in the path) and has no other mutable state, so
PUT and DELETE take **no request body at all** rather than accepting a
`following: true/false` field that could disagree with the method. That is also
why nothing here is writable: a URL (or a query parameter) never dictates what
goes in the database, and neither does a field the server would have to ignore.
"""

from rest_framework import serializers


class CreatorRelationshipStateSerializer(serializers.Serializer):
    username = serializers.CharField()
    active = serializers.BooleanField()

from dj.apps.g12f.models import CreatorBlock, CreatorFollow


class CreatorFollowStateSerializer(serializers.Serializer):
    """The answer to "am I following this creator, and how big is the graph".

    ``following`` is viewer-specific, which is exactly why this lives on its own
    authenticated route instead of being folded into the public creator
    serializer: that response is publicly cacheable and must not vary by
    authentication state.
    """

    username = serializers.CharField(
        read_only=True,
        help_text="The creator named in the path, in its canonical casing.",
    )
    following = serializers.BooleanField(
        read_only=True,
        help_text="True if the authenticated caller follows this creator.",
    )
    follower_count = serializers.IntegerField(
        read_only=True,
        help_text=(
            "How many active accounts follow this creator. This is the free "
            "follow graph and is unrelated to the paid subscriber count "
            "(`fans_count`)."
        ),
    )
    following_count = serializers.IntegerField(
        read_only=True,
        help_text="How many active creators this creator follows.",
    )


class CreatorFollowSerializer(serializers.ModelSerializer):
    """One row of "creators I follow"."""

    username = serializers.CharField(
        source='creator.username', read_only=True,
    )
    full_name = serializers.CharField(
        source='creator.full_name', read_only=True,
    )

    class Meta:
        model = CreatorFollow
        fields = ['username', 'full_name', 'created_at']
        read_only_fields = fields


class CreatorBlockSerializer(serializers.ModelSerializer):
    """One row of "accounts I blocked"."""

    username = serializers.CharField(
        source='blocked.username', read_only=True,
    )

    class Meta:
        model = CreatorBlock
        fields = ['username', 'created_at']
        read_only_fields = fields
