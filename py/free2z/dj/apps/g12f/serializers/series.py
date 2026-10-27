from django.db import transaction
from rest_framework import serializers
from rest_framework.exceptions import APIException
from dj.apps.g12f.blocks import exclude_blocked
from dj.apps.g12f.models import Series, PageOrder, zPage
from dj.apps.g12f.localization import (
    feed_variant_prefetch,
    localized_list_translation_prefetch,
    viewer_id_from_request,
)
from dj.apps.g12f.serializers.zpage import zPageListSerializer

# PageOrder.order is a PositiveIntegerField; on Postgres that is a 32-bit
# integer. Bound the input here, otherwise an in-range-for-Python but
# out-of-range-for-the-column value passes validation and blows up as a 500
# at INSERT time.
POSTGRES_MAX_POSITIVE_INT = 2147483647


class zPageSerializer(serializers.ModelSerializer):
    class Meta:
        model = zPage
        fields = ['free2zaddr', 'title']


class PageOrderSerializer(serializers.ModelSerializer):
    page = zPageSerializer()

    class Meta:
        model = PageOrder
        fields = ['page', 'order']

    def to_internal_value(self, data):
        # Convert the incoming JSON (which references a zPage by its public
        # ``free2zaddr``) into the internal Python types (a zPage instance).
        #
        # SECURITY: ``free2zaddr`` is public, and both ``create`` and
        # ``update`` mutate ``page.pageorder_set``. The lookup MUST therefore
        # be scoped to the requesting user's own pages, otherwise anyone can
        # name a victim's page and have that victim's PageOrder rows deleted.
        if not isinstance(data, dict):
            raise serializers.ValidationError(
                "Each pageorder entry must be an object.")

        page_data = data.get('page')
        if not isinstance(page_data, dict):
            raise serializers.ValidationError(
                {'page': 'An object with a "free2zaddr" is required.'})

        free2zaddr = page_data.get('free2zaddr')
        if not free2zaddr or not isinstance(free2zaddr, str):
            raise serializers.ValidationError(
                {'page': 'A "free2zaddr" string is required.'})

        request = self.context.get('request')
        user = getattr(request, 'user', None)
        if user is None or not user.is_authenticated:
            raise serializers.ValidationError(
                {'page': 'Authentication is required to reference a page.'})

        # Deliberately the same error for "does not exist" and "not yours", so
        # the endpoint is not an oracle for which free2zaddrs exist. A missing
        # page previously raised an uncaught DoesNotExist → 500.
        try:
            page = zPage.objects.get(free2zaddr=free2zaddr, creator=user)
        except zPage.DoesNotExist:
            raise serializers.ValidationError(
                {'page': f'No page "{free2zaddr}" belonging to you.'})

        # ``order`` lands in a PositiveIntegerField; validate type AND
        # magnitude here instead of letting junk reach the database as a 500.
        order = serializers.IntegerField(
            min_value=0, max_value=POSTGRES_MAX_POSITIVE_INT,
        ).run_validation(data.get('order'))

        return {'page': page, 'order': order}


class SeriesPagesSerializer(serializers.ModelSerializer):
    page = zPageListSerializer()

    class Meta:
        model = PageOrder
        fields = ['page', 'order']


class SeriesSerializer(serializers.ModelSerializer):
    """
    For displaying the list of pages in a series
    """
    # pageorder_set = SeriesPagesSerializer(many=True)
    pageorder_set = serializers.SerializerMethodField()

    class Meta:
        model = Series
        fields = [
            'id', 'name', 'pageorder_set', 'creator',
            'created_at', 'updated_at',
        ]

    def get_pageorder_set(self, obj):
        # `page__creator__is_active` as well as `page__is_published`.
        # The view gates which SERIES resolves for a requested identifier;
        # this gates which MEMBERS of it get rendered, and they are two
        # different questions. `PageOrder.page` has no owner constraint, so a
        # series can hold pages from more than one creator -- rows written
        # before  scoped the write, at minimum -- and each member is
        # rendered by `zPageListSerializer`: title, description, excerpt,
        # featured image, canonical URL. Without this, reaching a mixed series
        # through a still-active sibling served a deactivated creator's page
        # in full. Found independently by the codex adversarial review and the
        # read-path audit; the one-page-series test could not see it, so
        # `test_series_strip_hides_a_banned_members_page` was added.
        request = self.context.get("request")
        page_orders = exclude_blocked(
            obj.pageorder_set.filter(
                page__is_published=True,
                page__creator__is_active=True,
            ),
            # A mixed series must not carry a blocked creator's page to the
            # reader who blocked them, same as every other list.
            getattr(request, "user", None),
            "page__creator",
        ).select_related(
            "page__creator", "page__featured_image"
        ).prefetch_related(
            localized_list_translation_prefetch(
                "page__",
                viewer_id=viewer_id_from_request(
                    self.context.get("request")
                ),
            ),
            # No `source_length`: this endpoint does not truncate the zPage's
            # own body in SQL, so the source variant must carry the full body
            # here too or the series feed would start rendering a shorter
            # excerpt the day the flag flips.
            *feed_variant_prefetch(
                "page__",
                viewer_id=viewer_id_from_request(
                    self.context.get("request")
                ),
            ),
            "page__tags",
            "page__featured_image__webp", "page__featured_image__variants",
            "page__creator__avatar_image__webp",
            "page__creator__avatar_image__variants",
        )
        return SeriesPagesSerializer(
            page_orders, many=True, context=self.context
        ).data


class SeriesChanged(APIException):
    status_code = 409
    default_detail = "This series changed in another session. Reload it before saving."
    default_code = "series_changed"


class SeriesEditSerializer(serializers.ModelSerializer):
    """
    For editing the order of zPages in a Series and the name of the Series.
    """
    pageorder_set = PageOrderSerializer(many=True)
    expected_pageorder_set = PageOrderSerializer(many=True, required=False, write_only=True)
    expected_name = serializers.CharField(required=False, write_only=True, trim_whitespace=False)

    class Meta:
        model = Series
        fields = [
            'id', 'name', 'pageorder_set', 'creator',
            'created_at', 'updated_at', 'expected_pageorder_set', 'expected_name',
        ]
        read_only_fields = [
            'id', 'creator', 'created_at', 'updated_at',
        ]

    def save(self, **kwargs):
        # Capture the incoming request object. The viewset already puts the
        # request into the serializer context (GenericAPIView.get_serializer_
        # context) — which is what PageOrderSerializer's ownership check relies
        # on at validation time — so never clobber it with None here.
        request = kwargs.pop('request', None)
        if request is not None:
            self.context['request'] = request
        return super().save(**kwargs)

    def validate_pageorder_set(self, value):
        """Reject a payload that lists the same zPage more than once.

        `PageOrder` now carries `UniqueConstraint(series, page)`, so
        two entries naming the same page would reach the database as an
        IntegrityError -> 500. Issue  called this out explicitly: adding
        the constraint without this check trades one crash for another. A
        malformed list is the client's mistake, so it is a 400.

        Deliberately NOT silently de-duplicated: two entries for one page
        carry two different `order` values and there is no defensible way to
        pick one, so the caller is told rather than guessed at.
        """
        seen = set()
        duplicates = set()
        for entry in value:
            page = entry.get('page')
            pk = getattr(page, 'pk', None)
            if pk in seen:
                duplicates.add(getattr(page, 'free2zaddr', str(pk)))
            seen.add(pk)
        if duplicates:
            raise serializers.ValidationError(
                'A zPage may appear only once in a series. Duplicated: '
                + ', '.join(sorted(duplicates))
            )
        return value

    @staticmethod
    def _set_pages(series, pages_data, replace=False, expected_pages=None, expected_name=None):
        """Put `pages_data` into `series` (`replace=True`: as its exact,
        complete contents -- anything already in it is removed first).

        Every page named is left in this series and in **no other series
        owned by `series.creator`** -- the "one series per creator per page"
        invariant. That one cannot be a DB constraint: it spans the
        `series -> creator` join, so `UniqueConstraint` cannot express it.
        Both write paths therefore funnel through here, which is the whole of
         item 3 -- `create` used to insert blindly while `update`
        detached, so creating a series was the public API's way of putting a
        zPage into two series at once.

        SECURITY (the ownership rule): the detach is scoped to
        `series__creator`. Owning the page does NOT imply owning every
        PageOrder row that points at it -- nothing ties `Series.creator` to
        `zPage.creator`, so a legacy cross-owner row can exist, and **a
        creator may never modify another creator's series**. An unscoped
        `page.pageorder_set.all().delete()` would let anyone silently delete
        an entry out of someone else's curated series merely by adding their
        own page to their own series.

        The detach is a single statement over every page in the payload
        rather than one per page: interleaving N delete statements across two
        concurrent requests that name the same pages in different orders is
        the classic way to deadlock, and one `IN (...)` delete takes its row
        locks in a single plan-determined order instead.

        LOCKING. Callers must already be inside `transaction.atomic()` (both
        are). Every lock this takes is acquired up front and in one fixed
        order -- the target Series row, then the zPages by ascending pk --
        *before* any PageOrder row is touched. Both halves matter:

        * Without the zPage locks the invariant is not concurrency-safe at
          READ COMMITTED. Two simultaneous POSTs putting the same page into
          two different new series both run their DELETE before either
          INSERT, both delete nothing, and both then insert a DIFFERENT
          `(series, page)` pair -- which `unique(series, page)` happily
          accepts. The page is in two series again and no constraint noticed.
        * Without acquiring them *first* they deadlock. `update` used to wipe
          the series before calling in here, so it held PageOrder row locks
          while waiting for a zPage lock that another request already held
          while waiting for those PageOrder rows. Postgres breaks that tie by
          aborting one of them -- an uncaught 500 on a normal reorder.

        `no_key=True` (FOR NO KEY UPDATE) throughout: it serializes competing
        series writers against each other but does NOT conflict with the FOR
        KEY SHARE that a PageOrder INSERT/DELETE takes on its parent rows, so
        one request's lock on a Series row cannot block another's write to a
        *different* series that happens to share a page.
        """
        # The target series, so two concurrent writes to the SAME series
        # serialize instead of leaving the union of both payloads behind.
        list(
            Series.objects.select_for_update(no_key=True)
            .filter(pk=series.pk).values_list('pk', flat=True)
        )
        # Every zPage whose membership rows are about to move: the incoming
        # ones, plus -- when replacing -- the ones already in this series,
        # which the wipe below removes. Ascending pk is the global order that
        # makes the acquisition deadlock-free.
        page_ids = {entry['page'].pk for entry in pages_data}
        if replace:
            page_ids.update(series.pageorder_set.values_list(
                'page_id', flat=True))
        if page_ids:
            list(
                zPage.objects
                .select_for_update(no_key=True)
                .filter(pk__in=page_ids)
                .order_by('pk')
                .values_list('pk', flat=True)
            )
        # Compare after the series and page locks: another target writer or
        # a move/clear of an existing page must finish before this snapshot is
        # checked. Legacy clients omit the precondition and retain PUT semantics.
        if expected_pages is not None:
            expected = sorted((entry['page'].pk, entry['order']) for entry in expected_pages)
            actual = sorted(series.pageorder_set.values_list('page_id', 'order'))
            if actual != expected:
                raise SeriesChanged()
        if expected_name is not None:
            if Series.objects.values_list('name', flat=True).get(pk=series.pk) != expected_name:
                raise SeriesChanged()
        if replace:
            series.pageorder_set.all().delete()
        if pages_data:
            PageOrder.objects.filter(
                page_id__in=[entry['page'].pk for entry in pages_data],
                series__creator=series.creator,
            ).delete()
        for entry in pages_data:
            PageOrder.objects.create(
                series=series, page=entry['page'], order=entry['order'])

    @transaction.atomic
    def create(self, validated_data):
        pages_data = validated_data.pop('pageorder_set')
        validated_data.pop('expected_pageorder_set', None)
        validated_data.pop('expected_name', None)
        series = Series.objects.create(
            creator=self.context['request'].user,
            **validated_data,
        )
        self._set_pages(series, pages_data)
        return series

    @transaction.atomic
    def update(self, instance, validated_data):
        # Atomic: this is a delete-then-reinsert. Without a transaction a
        # failure part-way through (e.g. a DB-level constraint) leaves the
        # caller's series wiped. ATOMIC_REQUESTS is not enabled globally.
        # The wipe lives inside `_set_pages` (as `replace=True`) so it happens
        # AFTER the locks, not before them -- see the LOCKING note there.
        pages_data = validated_data.pop('pageorder_set')
        expected_pages = validated_data.pop('expected_pageorder_set', None)
        expected_name = validated_data.pop('expected_name', None)
        self._set_pages(instance, pages_data, replace=True,
                        expected_pages=expected_pages, expected_name=expected_name)
        return super().update(instance, validated_data)
