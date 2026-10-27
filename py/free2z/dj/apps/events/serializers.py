from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers
from django.utils import timezone

from dj.apps.g12f.serializers.zpage import SimpleCreatorSerializer
from dj.apps.g12f.zpage_paths import negotiated_content_url
from .models import Event


class MentionPreferenceSerializer(serializers.Serializer):
    enabled = serializers.BooleanField()

# Replaces a notification message whose template interpolated a deactivated
# counterparty's username (e.g. DONATION_RECEIVED's "...from {username}") —
# nulling the structured `contributor`/`payee` fields alone would still leak
# the name here.
REDACTED_EVENT_MESSAGE = "This activity is no longer available."
PAGE_CONTENT_EVENT_TYPES = frozenset({"PAGE_UPDATE", "PAGE_VOTE", "PAGE_MENTION"})


def _content_object_is_active(content_object):
    """Return whether an event's creator-owned object may still be named.

    Events use a GenericForeignKey, so the list queryset cannot join every
    possible content model. Keep the boundary at serialization time and cover
    the owner shapes used by zPages, conversations, stories, comments, and
    Creator objects. Objects without one of those ownership fields are not
    creator content and retain their existing event behavior.
    """
    if content_object is None:
        return True

    if hasattr(content_object, "is_active"):
        return bool(
            content_object.is_active
            and not getattr(content_object, "is_banned", False)
        )

    for owner_field in ("creator", "user", "author"):
        if not hasattr(content_object, f"{owner_field}_id"):
            continue
        owner = getattr(content_object, owner_field, None)
        return bool(
            owner is not None
            and owner.is_active
            and not getattr(owner, "is_banned", False)
        )

    return True


def _page_is_visible_to_request(page, request=None, recipient=None):
    """Do not expose a restricted page through a mention notification."""
    if page is None or not page.creator.is_active:
        return False
    user = getattr(request, 'user', None) if request is not None else recipient
    # The page's own creator may always see it named, draft or not: their
    # own PAGE_VOTE notifications ("X voted on <your page>") must not turn
    # into "no longer available" just because they unpublished it. Nothing
    # leaks -- the reader already owns the draft.
    if getattr(user, 'is_authenticated', False) and user.pk == page.creator_id:
        return True
    if not page.is_published:
        return False
    if not page.is_subscriber_only:
        return True
    if not getattr(user, 'is_authenticated', False):
        return False
    from dj.apps.g12f.models import Subscription
    return Subscription.objects.filter(
        star_id=page.creator_id,
        fan_id=user.pk,
        expires__gte=timezone.now(),
    ).exists()


def _is_zpage(content_object):
    if content_object is None:
        return False
    from dj.apps.g12f.models import zPage
    return isinstance(content_object, zPage)


class PaymentEventReferenceSerializer(serializers.Serializer):
    intent_id = serializers.UUIDField(required=False)
    payment_id = serializers.UUIDField(required=False)
    status = serializers.CharField()


class EventSerializer(serializers.ModelSerializer):
    receiving_user = SimpleCreatorSerializer(read_only=True)
    # These MUST be declared as method fields on this branch: with only
    # `get_*` methods defined and the names left to Meta.fields,
    # ModelSerializer falls back to building them from the model --
    # contributor/payee become PrimaryKeyRelatedFields and none of the
    # redaction below ever runs.
    contributor = serializers.SerializerMethodField()
    payee = serializers.SerializerMethodField()
    message = serializers.SerializerMethodField()
    content_url = serializers.SerializerMethodField()
    content_title = serializers.SerializerMethodField()
    content_available = serializers.SerializerMethodField()
    payment_reference = serializers.SerializerMethodField()
    # DRF's default ISO 8601 rendering, which carries the offset ("...Z").
    # This used to be `format="%Y-%m-%d %H:%M:%S"`: a UTC wall-clock value
    # with NO offset, which every browser parses as *local* time -- a
    # just-charged platform fee read "in 4 hours" to a viewer in EDT.
    # `test_api_datetime_offsets.py` fails if any serializer does this again.
    created_at = serializers.DateTimeField(read_only=True)
    read = serializers.BooleanField(read_only=True)
    # The column is a Decimal so the audit row is exact, but on the
    # wire `amount` stays a JSON *number* rather than DRF's default decimal
    # string: the notifications page renders it only inside
    # `typeof event.amount === "number"`, and the post_save signal hands
    # `to_dict()` to `PubSubClient.publish`, which is a bare `json.dumps` --
    # a Decimal there raises inside on_commit and the notification silently
    # never publishes. Three decimal places survive a double for display;
    # anyone reconciling money reads the decimal-string balance endpoints or
    # the column itself, never this field.
    amount = serializers.FloatField(allow_null=True, required=False)

    class Meta:
        model = Event
        fields = [
            'id', 'type', 'amount',
            'receiving_user',
            'contributor',
            'payee',
            'message', 'content_url', 'content_title',
            'content_available', 'payment_reference',
            'created_at', 'read'
        ]

    @extend_schema_field(PaymentEventReferenceSerializer(allow_null=True))
    def get_payment_reference(self, obj):
        """Only the event recipient sees an opaque server identity and fresh state."""
        from django.contrib.contenttypes.models import ContentType
        from dj.apps.purchases.models import PurchaseIntent
        if obj.type not in {'ZEC_PENDING', 'BOUGHT_TUZI'}:
            return None
        request = self.context.get('request')
        recipient = request.user if request else self.context.get('recipient', obj.receiving_user)
        if recipient.pk != obj.receiving_user_id:
            return None
        from dj.apps.economy.models import CapturedZecNote, ZecNoteDisposition
        from dj.apps.tuzis.models import ZecPendingNotice
        if obj.content_type_id == ContentType.objects.get_for_model(CapturedZecNote).pk:
            note = CapturedZecNote.objects.filter(pk=obj.object_id).first()
            if note is None:
                return None
            issued = ZecNoteDisposition.objects.filter(note=note, kind='issued',
                actor_id=obj.receiving_user_id, receipt__creator_id=obj.receiving_user_id,
                receipt__tuzis_credited__gt=0).exists()
            owned_notice = ZecPendingNotice.objects.filter(txid=note.txid, pool=note.pool,
                output_index=note.output_index, creator_id=obj.receiving_user_id).exists()
            if not issued and not owned_notice:
                return None
            return {'payment_id': str(note.pk), 'status': 'credited' if issued else 'pending'}
        if obj.content_type_id != ContentType.objects.get_for_model(PurchaseIntent).pk:
            return None
        # Do not use a cached GenericFK object: settlement updates the intent
        # in SQL, and recovery must report the current committed state.
        intent = PurchaseIntent.objects.filter(pk=obj.object_id,
            creator_id=obj.receiving_user_id).values('id', 'status').first()
        return {'intent_id': str(intent['id']), 'status': intent['status']} if intent else None

    def _counterparty(self, user):
        """Serialized ``SimpleCreatorSerializer`` payload, or ``None``.

        Counterparties are other people: a deactivated one must not keep
        exposing username, full_name, p2paddr or member_price through old
        events. The receiving_user is exempt by construction — it is
        the caller themself, and deactivating them also closes this API — so
        the receiving side keeps its own event history intact.
        """
        if user is None or not user.is_active:
            return None
        return SimpleCreatorSerializer(user).data

    def _page_is_visible(self, obj):
        """Evaluate PAGE_MENTION access once per serialized event."""
        cache = getattr(self, '_mention_page_visibility_cache', None)
        if cache is None:
            cache = self._mention_page_visibility_cache = {}
        cache_key = obj.pk if obj.pk is not None else id(obj)
        if cache_key not in cache:
            cache[cache_key] = _page_is_visible_to_request(
                obj.content_object,
                self.context.get('request'),
                self.context.get('recipient', obj.receiving_user),
            )
        return cache[cache_key]

    def _content_object_is_visible(self, obj):
        content_object = obj.content_object
        # These event types always refer to a zPage. GenericForeignKey returns
        # None when that page has been deleted, but None is also legitimate for
        # unrelated events such as donations and purchases. Treat a missing
        # page as unavailable without changing those objectless event flows.
        if content_object is None and obj.type in PAGE_CONTENT_EVENT_TYPES:
            return False
        if _is_zpage(content_object):
            return self._page_is_visible(obj)
        return _content_object_is_active(content_object)

    @extend_schema_field(SimpleCreatorSerializer(allow_null=True))
    def get_contributor(self, obj):
        """
        The user who paid or originated the event, or ``None``.

        ``None`` covers both "no contributor at all" (donations from
        Anonymous, purchases, fees) and "the contributor has since been
        deactivated", which must read exactly like absence rather than serve
        a stale identity payload.
        """
        return self._counterparty(obj.contributor)

    @extend_schema_field(SimpleCreatorSerializer(allow_null=True))
    def get_payee(self, obj):
        """
        The user who was paid, or ``None`` — same rule as ``contributor``.
        """
        return self._counterparty(obj.payee)

    @extend_schema_field(serializers.CharField())
    def get_message(self, obj):
        """
        Pre-rendered English notification copy.

        The client builds localized copy from structured fields rather than
        rendering `message`, but `message` still ships in the payload and the
        EVENT_TEMPLATES interpolate `contributor.username` / `payee.username`
        into it — so an inactive counterparty is scrubbed here too, or the
        nulled nested object above would be undone by one string field.
        """
        inactive_counterparty = (
            (obj.contributor_id is not None and not obj.contributor.is_active)
            or (obj.payee_id is not None and not obj.payee.is_active)
        )
        if inactive_counterparty:
            return REDACTED_EVENT_MESSAGE
        # PAGE_UPDATE and PAGE_VOTE interpolate content_object.title in the
        # model template. Do not let an inactive creator's old page title leak
        # through the private event list; the URL/title fields are blanked by
        # the same ownership check above.
        if obj.type in PAGE_CONTENT_EVENT_TYPES and not self._content_object_is_visible(obj):
            return "This content is no longer available."
        return obj.message()

    # Nullable for real: most event types (donations, purchases, fees) have no
    # content object at all. Without this the generated schema -- and every
    # client generated from it -- declares a non-null string.
    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_content_title(self, obj):
        """
        Title of the object the event is about.

        The client builds localized notification copy from structured fields
        rather than rendering `message`, which is pre-rendered English. Two
        event types (PAGE_UPDATE, VOTE_COMMENT_SENT) name the page/comment in
        their copy, and `content_url` alone is not enough to recover it, so
        expose the title explicitly. zPage calls it `title`, Comment calls it
        `headline`.
        """
        content_object = obj.content_object
        if not self._content_object_is_visible(obj):
            return None
        for attribute in ('title', 'headline'):
            value = getattr(content_object, attribute, None)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_content_url(self, obj):
        content_object = obj.content_object
        if not content_object or not self._content_object_is_visible(obj):
            return None
        return negotiated_content_url(
            content_object,
            self.context.get('request'),
        )

    @extend_schema_field(serializers.BooleanField())
    def get_content_available(self, obj):
        content_object = obj.content_object
        if obj.type in PAGE_CONTENT_EVENT_TYPES:
            return self._content_object_is_visible(obj)
        if content_object is None:
            # Donations, purchases, and fees legitimately have no linked
            # object; false is reserved for content that existed but is now
            # redacted or inaccessible.
            return True
        return self._content_object_is_visible(obj)
