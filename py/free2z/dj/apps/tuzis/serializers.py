# serializers.py
from rest_framework import serializers
from drf_spectacular.utils import extend_schema_serializer
from dj.apps.g12f.models import Subscription
from dj.apps.g12f.serializers import SimpleCreatorSerializer
from dj.apps.uploads.serializers import FeaturedImageSerializer


# The reasoning below is a COMMENT, not a docstring: drf-spectacular publishes
# a serializer's docstring as the schema component description, and it reaches
# every generated client. Internal issue numbers do not belong there.
#
# Deactivating a creator is the moderation lever, and
# `SimpleCreatorSerializer` publishes `p2paddr`, `member_price` and
# `full_name` -- so a taken-down account kept handing out its Zcash address and
# real name through the other party's dashboard long after its profile and
# every zPage started 404-ing .
#
# REDACTED, NOT REMOVED, and that distinction is a money contract rather than a
# preference. `test_deactivated_creator_subscription_remains_cancellable`
# requires the row to stay listed: `/api/tuzis/my-subscriptions` carries the
# only ordinary unsubscribe control, and a fan whose row vanished would be told
# they have no subscription while a live recurring authorization sat behind it
# -- so reactivating the creator before expiry would charge them. Dropping the
# row was the first version of this fix, and the codex adversarial review
# caught it.
#
# `username` therefore survives: it is the path segment
# `DELETE /api/tuzis/subscribe/{username}` needs, the fan already knows it
# (they subscribed), and it is not what  names. Everything that is an
# identity or a live purchase signal goes. The blanked values are all values
# the field could already hold -- `''` for two `blank=True` CharFields, `null`
# for a `null=True` price and a nullable avatar -- so no client sees a type it
# was not already told about.
class SubscriptionCounterpartySerializer(SimpleCreatorSerializer):
    """The other party on a subscription.

    `is_active` is false once the account has been deactivated, and every
    other field except `username` is then blank: the row stays visible so the
    subscription can still be cancelled, but the account's details do not.
    """

    #`SimpleCreatorSerializer` declares this non-nullable, which was already
    #untrue -- a creator with no avatar serializes `null` today. A NEW schema
    #component must not inherit that lie, and redaction sets it to `null` on
    #purpose, so declare it honestly here.
    avatar_image = FeaturedImageSerializer(allow_null=True)

    #New field, so a client can tell "no longer available" from "has no
    #display name" -- blank strings alone are indistinguishable from an
    #account that simply filled nothing in.
    #
    #Publishing it does not by itself change what anyone SEES: neither
    #dashboard consumes it yet, so a redacted row still renders as an
    #ordinary creator card whose username links to a 404 and whose Update
    #form PATCHes an endpoint that requires `is_active=True` (codex review).
    #The leak is closed either way -- no address, no real name -- and
    #unsubscribe still works, which is the part that had to keep working.
    #The dashboard states are a follow-up, and the field is the prerequisite
    #for them.
    is_active = serializers.BooleanField(read_only=True)

    class Meta(SimpleCreatorSerializer.Meta):
        fields = list(SimpleCreatorSerializer.Meta.fields) + ['is_active']
        # NOT NULL in the column since; REDACTED below nulls it.
        extra_kwargs = {'member_price': {'allow_null': True}}

    #Everything except ``username`` and ``is_active``, with the value each
    #field is blanked to.
    REDACTED = {
        'avatar_image': None,
        'p2paddr': '',
        'member_price': None,
        'full_name': '',
    }

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if instance is not None and not instance.is_active:
            data.update(self.REDACTED)
        return data


class SubscriptionSerializer(serializers.ModelSerializer):
    fan = SubscriptionCounterpartySerializer()
    star = SubscriptionCounterpartySerializer()

    class Meta:
        model = Subscription
        fields = ('fan', 'star', 'expires', 'max_price')


class SubscriptionMaxPriceSerializer(serializers.Serializer):
    """Validated PATCH contract for changing a recurring-spend ceiling."""

    max_price = serializers.DecimalField(
        max_digits=7,
        decimal_places=0,
        min_value=1,
        max_value=1_000_000,
        help_text="Maximum 2Z the authenticated fan permits per renewal.",
    )


class IdempotentDonationRequestSerializer(serializers.Serializer):
    intent = serializers.ChoiceField(
        choices=("donation", "ppv"),
        required=False,
        default="donation",
        help_text=(
            "The paid intent. `donation` and `ppv` are separate replay "
            "identities even when recipient and amount match. `ppv` is "
            "retired: it is accepted only so a receipt recorded "
            "before the retirement replays; a new `ppv` request is refused "
            "with 400 `ppv_unlock_retired` and moves no 2Z."
        ),
    )
    amount = serializers.DecimalField(
        # Whole 2Z only. Event.amount has carried the ledger's full Decimal
        # precision since, so this is no longer about the audit column;
        # it is parity with, which ceils the amount at the call site so
        # the number the user was shown is the number posted, consistent with
        # the server's own ceil for PPV billing.  says the constraint
        # stays. The max_value is the historical int32 ceiling of the old
        # column, kept as the public contract.
        max_digits=10,
        decimal_places=0,
        min_value=1,
        max_value=2_147_483_647,
        help_text="Whole 2Z amount to transfer (maximum 2147483647).",
    )
    anon = serializers.BooleanField(required=False, default=False)


class IdempotentDonationResultSerializer(serializers.Serializer):
    balance = serializers.DecimalField(max_digits=17, decimal_places=3)
    charged = serializers.DecimalField(max_digits=17, decimal_places=3)
    replayed = serializers.BooleanField()


class ConfirmedSubscriptionRequestSerializer(serializers.Serializer):
    creator_id = serializers.IntegerField(
        required=False,
        min_value=1,
        help_text=(
            "Immutable creator id captured when the purchase dialog opened. "
            "When supplied, it must still identify the creator in the URL."
        ),
    )
    expected_price = serializers.DecimalField(
        max_digits=7,
        decimal_places=0,
        # 0 is a free membership: confirmed, it extends the
        # membership and moves no 2Z.
        min_value=0,
        # Creator.member_price has max_digits=6, so 999999 is the largest
        # current price that can ever satisfy this exact-price confirmation.
        max_value=999_999,
        help_text=(
            "Exact 2Z amount approved for this immediate purchase. A new "
            "subscription uses it as the renewal ceiling; an existing "
            "subscription retains its current ceiling, including zero."
        ),
    )


class ConfirmedSubscriptionResultSerializer(serializers.Serializer):
    balance = serializers.DecimalField(
        max_digits=17,
        decimal_places=3,
        help_text=(
            "The fan's 2Z balance as of THIS reply, on a replay as well as "
            "on a new purchase. It is deliberately not the balance frozen in "
            "a replayed receipt: one of the replay paths (a receipt carried "
            "over from the legacy subscribe route) has no recorded balance "
            "to return, so live is the only meaning all of them can share, "
            "and a frozen number can be several charges out of date. "
            "`charged` and `expires` do describe the original request."
        ),
    )
    charged = serializers.BooleanField()
    replayed = serializers.BooleanField()
    expires = serializers.DateTimeField()
    subscription = SubscriptionSerializer()


class SubscriptionIntentRecoveryRequestSerializer(serializers.Serializer):
    """The browser's durable handle for one subscription attempt."""

    key = serializers.CharField(
        min_length=1,
        max_length=200,
        help_text=(
            "The exact retry key held by the authenticated payer. This may "
            "be a legacy key that is no longer accepted for charging."
        ),
    )
    expected_price = serializers.DecimalField(
        max_digits=7,
        decimal_places=0,
        min_value=0,
        max_value=999_999,
        required=False,
        help_text=(
            "Optional price captured by an older confirmed client, used "
            "only to identify an otherwise unlabelled historical receipt."
        ),
    )
    username = serializers.CharField(
        max_length=150,
        required=False,
        help_text="The creator locator captured with an older confirmed receipt.",
    )


class SubscriptionIntentRecoveryResultSerializer(serializers.Serializer):
    status = serializers.ChoiceField(
        choices=("abandoned", "resolved", "unchanged"),
    )


class SubscriptionStatusSerializer(serializers.Serializer):
    username = serializers.CharField()
    active = serializers.BooleanField()
    expires = serializers.DateTimeField(allow_null=True)
    max_price = serializers.DecimalField(
        max_digits=7,
        decimal_places=0,
        allow_null=True,
    )
    current_price = serializers.DecimalField(
        max_digits=7,
        decimal_places=0,
        allow_null=True,
    )


class CreditErrorSerializer(serializers.Serializer):
    code = serializers.CharField()
    error = serializers.CharField()
    key_resolved = serializers.BooleanField(
        required=False,
        help_text=(
            "Only on `idempotency_mismatch`, and only when this endpoint can "
            "prove it: true means the request recorded under your "
            "Idempotency-Key has FINISHED and cannot be the one you are "
            "making now -- it is another recipient's, or it bought a "
            "membership that has since ended -- so retire that key and mint "
            "a new one. Note what it does not mean: 'a different request "
            "finished' is not enough on its own. A finished receipt for a "
            "membership you are STILL holding is your own purchase under a "
            "stale price, and is answered 200 `replayed` instead, never with "
            "this flag, because retiring the key there would buy a second "
            "month. False means the other request may still be committing -- "
            "reuse the SAME key. Absent means the endpoint could not tell (a "
            "receipt it cannot attribute), which is also a reason to reuse "
            "the same key. Without this a client that keeps one key per "
            "purchase intent can be answered 409 for the receipt's whole "
            "retention horizon with no way to recover."
        ),
    )
    balance = serializers.DecimalField(
        max_digits=17,
        decimal_places=3,
        allow_null=True,
        required=False,
    )
    current_price = serializers.DecimalField(
        max_digits=7,
        decimal_places=0,
        allow_null=True,
        required=False,
    )


class InsufficientFundsErrorSerializer(serializers.Serializer):
    """The common 402 contract for every user-facing 2Z debit.

    AI endpoints also identify a no-charge outcome explicitly so a browser can
    distinguish an application refusal from an untrusted transport error.
    """

    code = serializers.ChoiceField(choices=["insufficient_funds"])
    cost = serializers.DecimalField(max_digits=17, decimal_places=3)
    balance = serializers.DecimalField(max_digits=17, decimal_places=3)
    shortfall = serializers.DecimalField(max_digits=17, decimal_places=3)
    action = serializers.CharField(
        help_text="Stable identifier for the attempted paid action."
    )
    charge_status = serializers.ChoiceField(
        choices=["not_charged"], required=False,
    )
    tuzis_charged = serializers.IntegerField(min_value=0, required=False)


class StreamEntitlementErrorSerializer(serializers.Serializer):
    """A typed 402 for a stream that requires an entitlement, not money."""

    code = serializers.ChoiceField(choices=["subscription_required"])
    error = serializers.CharField()
    action = serializers.ChoiceField(choices=["stream_join"])


@extend_schema_serializer(component_name='SubscriptionRenewalSummary')
class SubscriptionRenewalSummarySerializer(serializers.Serializer):
    """Snapshot of the balance required for the fan's next renewals."""

    # This is the SECOND `status` ChoiceField in the schema, and by default
    # drf-spectacular reacts by namespacing BOTH — renaming the translation
    # job's long-published `StatusEnum` out from under every external client.
    # SPECTACULAR_SETTINGS['ENUM_NAME_OVERRIDES'] pins that existing name, so
    # only the new enum is namespaced (`SubscriptionRenewalSummaryStatusEnum`)
    # and the f2z.yaml diff is purely additive.
    status = serializers.ChoiceField(
        choices=('none', 'ok', 'shortfall', 'unknown'),
    )
    balance = serializers.DecimalField(
        max_digits=20, decimal_places=3, allow_null=True,
    )
    total_upcoming = serializers.DecimalField(
        max_digits=20, decimal_places=3, allow_null=True,
        help_text=(
            'Total 2Z of the renewal charges the worker will ATTEMPT within '
            '`horizon_days`, at current creator prices. A subscription is '
            'charged at most once in that window, so this is a count of real '
            'attempts rather than a projection of recurring cost — but an '
            'attempt is not a debit: when this exceeds the balance, later '
            'charges fail instead of drawing.'
        ),
    )
    shortfall = serializers.DecimalField(
        max_digits=20, decimal_places=3, allow_null=True,
        help_text='Amount by which `total_upcoming` exceeds the balance.',
    )
    next_renewal = serializers.DateTimeField(
        allow_null=True,
        help_text=(
            'Earliest subscription expiry inside the window. Informational: '
            'renewal attempts begin 24h before expiry and retry hourly, so '
            'this is NOT a top-up deadline.'
        ),
    )
    horizon_days = serializers.IntegerField(
        help_text=(
            'Length of the window the totals cover, in days. One billing '
            'cycle — the interval over which each subscription renews at '
            'most once.'
        ),
    )
