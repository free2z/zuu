from rest_framework import serializers


class SitemapCreatorSerializer(serializers.Serializer):
    username = serializers.CharField()


class SitemapZPageSerializer(serializers.Serializer):
    username = serializers.CharField()
    vanity = serializers.CharField()
    # Optional for rolling compatibility. New SvelteKit requests the field
    # with X-Free2Z-Sitemap-Canonical-Address: 1 so it can escape historic
    # route collisions through /article/<free2zaddr>. Old SvelteKit receives
    # the pre-existing exact shape until every replica has rolled.
    free2zaddr = serializers.CharField(required=False)
    updated_at = serializers.DateTimeField()
    # The article's PUBLISHED language variants, ordered exactly as
    # `available_languages` is on the zPage API, plus the source tag. Together
    # they are the input `ts/svelte/free2z/src/lib/zpage-language.js` needs to
    # derive this article's `rel=alternate hreflang` cluster -- the same
    # function, on the same input, that the article page derives its own
    # `rel=canonical` from, so a sitemap URL can never advertise a page that
    # canonicalizes somewhere else ( Part 8, reconciling ).
    #
    # `source_language` may be the legacy `und` sentinel; consumers must not
    # emit it as an hreflang.
    languages = serializers.ListField(child=serializers.CharField())
    # Nullable since: NULL is "detection has not run yet", the honest
    # replacement for the `und` sentinel. A consumer must treat it as "this
    # article names no language", never as a language.
    source_language = serializers.CharField(allow_blank=True, allow_null=True)


class SitemapTagSerializer(serializers.Serializer):
    # One `/tag/<slug>` hub. The slug is all a consumer needs: it IS
    # the URL, and `taggit.models.Tag` has no `updated_at`, so these entries
    # deliberately carry no `lastmod` rather than an invented one.
    slug = serializers.CharField()


class SitemapPageSerializer(serializers.Serializer):
    page = serializers.IntegerField(min_value=0)
    count = serializers.IntegerField(min_value=1)
    revision = serializers.CharField()


class SitemapIndexSerializer(serializers.Serializer):
    chunk_size = serializers.IntegerField(min_value=1)
    creators = SitemapPageSerializer(many=True)
    zpages = SitemapPageSerializer(many=True)
    tags = SitemapPageSerializer(many=True)


class SitemapChunkSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=("creators", "zpages", "tags"))
    page = serializers.IntegerField(min_value=0)
    creators = SitemapCreatorSerializer(many=True, required=False)
    zpages = SitemapZPageSerializer(many=True, required=False)
    tags = SitemapTagSerializer(many=True, required=False)
