from urllib.parse import urlsplit
from importlib import import_module
from importlib.util import find_spec

from django.conf import settings
from rest_framework import serializers
from dj.apps.economy.serializers import ActorIDField

from .models import StripeTransaction


def validate_stripe_checkout_url(value, allowed_hosts=None):
    """Accept only an explicitly configured HTTPS Checkout origin and path.

    Stripe's hosted Checkout URL is an external redirect target that we hand
    to a privileged client (the browser session that is already signed in, and
    native ZUULI, which calls ``window.location.assign``/an in-app browser on
    it). Anything that is not exactly one of the configured origins must fail
    closed rather than be forwarded.

    The host set is configurable (``STRIPE_CHECKOUT_ALLOWED_HOSTS``) because a
    Stripe account can opt into a Custom Checkout Domain, which changes the
    hostname Stripe returns with no code change on our side. It is an *exact*
    DNS-name set, never a suffix match: ``endswith('.stripe.com')`` would
    accept ``checkout.stripe.com.evil.example``. An empty set rejects
    everything -- that is the intended fail-closed state, and
    ``create_checkout_session`` refuses before touching Stripe when it is
    empty, so a misconfiguration is a 500 rather than a charged card with no
    usable redirect.

    ``parsed.hostname`` (not ``netloc``) is deliberate in both directions: it
    lowercases, so a case variant of a trusted host is still trusted, and it
    strips userinfo, so the userinfo/port checks below are what keep
    ``https://checkout.stripe.com@evil.example/`` and
    ``https://checkout.stripe.com:443@evil.example/`` out.

    A port -- including an explicit ``:443`` -- is rejected. Stripe has never
    emitted one, and this matches the check that shipped in; on a money
    path the origin-equivalent-but-unexpected form is not worth accepting.
    """
    if allowed_hosts is None:
        allowed_hosts = settings.STRIPE_CHECKOUT_ALLOWED_HOSTS
    try:
        parsed = urlsplit(value)
        has_port = parsed.port is not None
    except (AttributeError, TypeError, ValueError) as exc:
        raise serializers.ValidationError(
            'Stripe checkout URL is malformed.'
        ) from exc

    if not (
        parsed.scheme == 'https'
        and parsed.hostname in allowed_hosts
        and parsed.username is None
        and parsed.password is None
        and not has_port
        # A bare origin is not a Checkout Session; a real hosted URL always
        # carries the session path (``/c/pay/cs_...``).
        and parsed.path
        and parsed.path != '/'
    ):
        raise serializers.ValidationError(
            'Stripe checkout URL has an unexpected origin.'
        )
    return value


class CheckoutSessionRequestSerializer(serializers.Serializer):
    expected_actor_id = ActorIDField(required=False, help_text='Required by the policy-1 checkout actor fence. Assert the actor who reviewed the order; it is not authorization.')
    quantity = serializers.IntegerField(
        required=False,
        default=1,
        min_value=1,
        max_value=1_000_000,
    )
    currentPath = serializers.CharField(required=False, default='/')
    # Declared so the mode a caller must send to get a native return is part
    # of the canonical contract and therefore of the generated client. The
    # authoritative gate is still the explicit check at the top of
    # ``create_checkout_session``, which runs before any native-return
    # readiness probe so an unknown mode is a 400 rather than a 503. This
    # field can never disagree with it: both read the same raw value against
    # the same two choices.
    returnMode = serializers.ChoiceField(
        choices=['web', 'zuuli_mobile'],
        required=False,
        default='web',
    )


class CheckoutQuoteSerializer(serializers.Serializer):
    checkout_intent_id = serializers.UUIDField()
    tuzis = serializers.IntegerField(min_value=1)
    amount_cents = serializers.IntegerField(min_value=1)
    currency = serializers.CharField()
    pricing_version = serializers.CharField()


class CheckoutSessionResponseSerializer(serializers.Serializer):
    id = serializers.RegexField(
        r'^cs_[A-Za-z0-9_]{3,252}$',
        max_length=255,
        allow_blank=False,
    )
    url = serializers.URLField(max_length=2048, trim_whitespace=False)
    quote = CheckoutQuoteSerializer()

    def validate_url(self, value):
        # ``allowed_hosts`` in the context is an explicit override used by the
        # preflight command; unset means "the deployed policy".
        return validate_stripe_checkout_url(
            value,
            self.context.get('allowed_hosts'),
        )


#Every machine-readable ``code`` ``create_checkout_session`` answers with,
#by status. The status split is the contract:
#
#* **503 is designed, and only designed.** ``native_checkout_unavailable``
#(ZUULI asked for the native return and it is gated off or not ready: the
#shipped app retries exactly a 503 as ``web``) and ``checkout_not_activated``
#(the operator's ``STRIPE_CHECKOUT_ENABLED=false`` switch).
#* **500 is our configuration or infrastructure**, and **502 is Stripe**:
#a real checkout outage, which the write-failure alerts must count.
#
#``test_checkout_designed_fallback.py`` pins every branch to its status.
CHECKOUT_ERROR_CODES = (
    'checkout_original_instruction_unresolved', 'actor_changed',
    'actor_authentication_changed',
    'inactive_funding_actor',
    'usage_daily_funding_limit',
    'purchaser_daily_sales_limit',
    'economic_writers_fenced',
    'economic_policy_disabled',
    'invalid_request',
    'invalid_return_mode',
    'invalid_return_path',
    'native_checkout_unavailable',
    'checkout_not_activated',
    'checkout_host_policy_unavailable',
    'checkout_not_configured',
    'stripe_unavailable',
    'stripe_invalid_session',
    'checkout_state_conflict',
)


class CheckoutSessionErrorSerializer(serializers.Serializer):
    error = serializers.CharField()
    code = serializers.ChoiceField(
        choices=CHECKOUT_ERROR_CODES,
        required=False,
        help_text=(
            'Machine-readable reason. 503 carries only the designed '
            '`native_checkout_unavailable` and `checkout_not_activated`; a '
            'real outage is 500 or 502. A 500 from the admission store is '
            "DRF's `{\"detail\": ...}` shape without `code`."
        ),
    )


class TransactionSerializer(serializers.ModelSerializer):
    status = serializers.SerializerMethodField(help_text='Credited only where original actual issuance is proven; historical nominal amounts alone are unavailable.')
    credited = serializers.SerializerMethodField()
    credited_m2z = serializers.SerializerMethodField(help_text='Exact original issued m2Z as a digit string; null when original issuance is unproved.')
    usage_credited_m2z = serializers.SerializerMethodField(help_text='Exact original m2Z added to usage; null when unproved. The original total also includes purchase-origin debt repayment.')
    usage_debt_repaid_m2z = serializers.SerializerMethodField(help_text='Exact original purchase m2Z applied to prior usage debt; null when unproved. The two usage fields sum to credited_m2z.')

    def issuance(self, transaction):
        cache = getattr(self, '_issuance_cache', {})
        if transaction.pk not in cache:
            name = 'dj.apps.economy.funding'
            if find_spec(name) is not None:
                cache[transaction.pk] = import_module(name).transaction_issuance_status(transaction)
            else:
                # Current policy-0 fulfillment already records this cursor.
                # An absent future adapter must not hide existing delivery.
                from django.db.models import Q, Sum
                from dj.apps.ledger.models import Account, PurchaseRefund, Transfer
                cursor = PurchaseRefund.objects.filter(ref_kind='stripe_transaction', ref_id=str(transaction.pk),
                    rail='stripe', account__owner_id=transaction.user_id).first()
                issued = None
                if cursor is not None and cursor.credited_m2z == transaction.tuzis_credited * 1000:
                    issued = Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
                        debit_account_id__in=Account.objects.filter(key='sys:clearing_stripe').values('pk')).filter(
                            Q(credit_account_id=cursor.account_id, code='purchase') |
                            Q(credit_account_id__in=Account.objects.filter(owner_id=transaction.user_id, kind='user_debt').values('pk'), code='debt_repay', meta__origin='purchase')
                        ).aggregate(amount=Sum('amount'))['amount']
                # Historical backfill creates nominal cursors without issuance.
                # Both original credit and debt repayment must match the cursor.
                if issued is not None and issued == cursor.credited_m2z:
                    cache[transaction.pk] = {'status': 'credited', 'credited': True, 'credited_m2z': str(issued)}
                else:
                    cache[transaction.pk] = {'status': 'unavailable', 'credited': False, 'credited_m2z': None}
            self._issuance_cache = cache
        return cache[transaction.pk]

    def get_status(self, transaction) -> str:
        return self.issuance(transaction)['status']

    def get_credited(self, transaction) -> bool:
        return self.issuance(transaction)['credited']

    def get_credited_m2z(self, transaction) -> str | None:
        return self.issuance(transaction)['credited_m2z']

    def get_usage_credited_m2z(self, transaction) -> str | None:
        return self.issuance(transaction).get('usage_credited_m2z')

    def get_usage_debt_repaid_m2z(self, transaction) -> str | None:
        return self.issuance(transaction).get('usage_debt_repaid_m2z')

    class Meta:
        model = StripeTransaction
        fields = '__all__'
