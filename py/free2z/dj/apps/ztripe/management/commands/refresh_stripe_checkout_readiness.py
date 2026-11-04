"""Keep the Stripe checkout readiness proof fresh without waiting for a sale.

``webhook_is_ready`` requires an account-bound provider delivery newer than
``READINESS_MAX_AGE`` (24h). Every proven ``checkout.session.completed``
refreshes it, so at healthy sales volume the proof renews itself. At low volume
it does not, and the result is a self-disabling loop:

    no sales for 24h -> the proof expires -> ``create_checkout_session``
    returns 500 -> checkout is unavailable -> no sales

This command breaks that loop on a schedule by firing the *documented*
nonfinancial canary: it creates one disposable Stripe ``Customer`` in the same
declared live/test mode, which makes Stripe deliver a real
``customer.created`` event to the configured webhook endpoint. The webhook view
verifies that signed delivery against the checkout secret key and records
readiness (``verify_and_record_readiness_canary``).

**Why a Customer is safe.** A bare ``Customer`` has no payment method, no
subscription, no invoice and no PaymentIntent. Stripe bills on processed
payments, not on stored objects, so creating and deleting one is free and can
never move money or credit 2Z. It is exactly the object the manual activation
runbook already tells an operator to create by hand
(``docs/tuzis/README.md``); this command only puts it on a schedule. The
Customer is deleted again in the same run so the live dashboard does not
accumulate junk.

**Credential permission.** ``STRIPE_SECRET_KEY`` may be a restricted ``rk_*``
key, and permission to create a Checkout Session does not imply permission to
write Customers. Nothing in CI can prove a live key's scopes, so run this
command once as a Job during activation — *before* flipping
``STRIPE_CHECKOUT_ENABLED`` — and treat a nonzero exit as a blocker. A 403 at
this call is unrecoverable by retry, so it emits the page phrase immediately
instead of letting the absence policy discover it eight hours later.

**Idempotency, and why the key is unique per invocation.** Every run sends a
fresh idempotency key. That is deliberate and it is the *safe* direction: the
whole point of a run is to make Stripe emit a NEW ``customer.created`` event,
and Stripe answers a reused key by replaying the original saved response
without emitting anything. A key shared across invocations — an hour bucket,
say — therefore turns the most important run there is, an operator's manual
recovery immediately after fixing a broken endpoint, into a silent no-op that
prints the success line and exits 0 while readiness keeps counting down.

The thing a shared key would have bought is small by comparison: if a Pod dies
in the window between ``Customer.create`` returning and the delete call, the
Job's ``backoffLimit`` retry creates a second Customer and the first one is
left behind. Both are bare, free and tagged with ``free2z_readiness_canary``,
so the cost of that rare case is a tagged object to sweep, versus an outage.
``max_network_retries=0`` means the SDK never re-sends a request on its own, so
the key is only ever protecting against a duplicate the caller asked for.

**No database writes.** Management commands run outside ``AtomicMiddleware``
(autocommit), so anything written here would need an explicit
``transaction.atomic``. This command deliberately only *reads*
``StripeWebhookReadiness``; the proof row is written by the webhook view,
inside a request, when the delivery actually arrives. Keep it that way — a
command that could write its own readiness proof would be able to declare the
provider healthy without the provider ever calling back, which defeats the
entire point of the proof.
"""

from __future__ import annotations

import uuid

import stripe
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from stripe._http_client import RequestsClient

from dj.apps.ztripe.stripe_identity import (
    PROD_NAMESPACE,
    StripeIdentityConfigurationError,
    configured_stripe_identity,
    live_stripe_credentials_outside_prod,
    log_live_credentials_outside_prod,
    stripe_checkout_enabled,
)
from dj.apps.ztripe.webhook_readiness import (
    READINESS_MAX_AGE,
    StripeWebhookEndpointMismatch,
    StripeWebhookReadinessError,
    current_readiness_proof,
    prove_webhook_endpoint,
)


#Paged when the recorded proof is at least this old: a third of
#``READINESS_MAX_AGE``, i.e. 8h against the 24h window.
#
#The threshold is only half the story, because it is sampled on the CronJob's
#schedule. A run that sees 7h59m says nothing and the next look is a whole
#period later, so the WORST-CASE first page is at ``warn + period``, not at
#``warn``. At 8h + 4h that is 12h, leaving 12h of human response time before
#`create_checkout_session` starts returning 500 — the number this used to
#claim while actually delivering 8h from a 12h threshold. Reaching 8h still
#requires two consecutive lost refreshes, since a healthy proof is never
#older than one period plus delivery latency.
#
#Derived from ``READINESS_MAX_AGE`` rather than hard-coded so shortening the
#window cannot silently leave the alert threshold above the expiry it warns
#about; `test_warn_age_leaves_half_the_window_after_one_more_tick` pins the
#relationship to the deployed schedule.
READINESS_WARN_AGE = READINESS_MAX_AGE / 3

#Page phrase. First token on the line so a GKE log-agent split cannot bury
#it behind other output (the lesson from the Dyte spool signals).
STRIPE_READINESS_EXPIRING_SIGNAL = 'STRIPE CHECKOUT READINESS EXPIRING'

#Counted by the `stripe_checkout_readiness_canary` log-based metric, whose
#absence in prod is itself an alert. Keep this line, the regex in
#`monitoring/log-metrics/stripe-readiness-canary.json`, and
#`test_readiness_canary_command.py` in step; the test reads the regex out of
#the JSON and runs it against this command's real stdout so a rename breaks
#the test instead of silently killing the metric.
_CANARY_FIRED_PREFIX = 'stripe checkout readiness canary fired'

#Marks the disposable object so a leaked one is identifiable in the
#Stripe dashboard without guessing.
_CANARY_METADATA_KEY = 'free2z_readiness_canary'

#Bounded like every other server-side Stripe call here: connect 3.05s,
#read 5s, zero retries. Three calls per run at most.
_HTTP_TIMEOUT = (3.05, 5)

#Prefix for the per-invocation idempotency key; the rest is a UUID4. See
#"Idempotency" above for why this must NOT be bucketed by time.
_IDEMPOTENCY_PREFIX = 'f2z-readiness-canary'


class Command(BaseCommand):
    help = (
        'Fire the nonfinancial same-mode customer.created readiness canary so '
        'the Stripe checkout delivery proof cannot expire on a quiet day.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help=(
                'Report the current proof age and emit the expiry signal, but '
                'never contact Stripe and never create a Customer.'
            ),
        )
        parser.add_argument(
            '--while-disabled',
            action='store_true',
            help=(
                'Outside prod, fire the canary even though checkout is '
                'switched off: the activation step of a namespace that holds '
                'its own TEST-mode credentials. Never overrides the '
                'live-credential refusal.'
            ),
        )

    def handle(self, *args, **options):
        if self._skip_outside_prod(options['while_disabled']):
            return
        try:
            identity = configured_stripe_identity()
        except StripeIdentityConfigurationError:
            # Two very different situations wear the same exception.
            #
            # Checkout staged OFF: a namespace that was never provisioned for
            # card checkout. Nothing is broken, nobody is being turned away,
            # and paging here would mean stage and test alert forever. Exit 0
            # quietly.
            #
            # Checkout staged ON: the settings that make buying possible have
            # gone missing under a live storefront. Page NOW and do not rely
            # on the absence policy to notice, because a metric-absence
            # condition does not arm until its series has produced a first
            # point — if this state is reached before the very first canary
            # ever succeeded, the absence policy is enabled, green, and
            # incapable of firing.
            if self._checkout_is_activated():
                self.stdout.write(
                    f'{STRIPE_READINESS_EXPIRING_SIGNAL} '
                    f'reason=identity_not_configured: checkout is enabled but '
                    f'the Stripe identity settings are incomplete'
                )
            self.stdout.write(
                'stripe checkout readiness canary skipped: '
                'identity is not configured'
            )
            return

        age_seconds = self._report_proof_age(identity)

        if options['dry_run']:
            self.stdout.write(
                'stripe checkout readiness canary dry run: no Stripe call made'
            )
            return

        stripe.max_network_retries = 0
        stripe.default_http_client = RequestsClient(timeout=_HTTP_TIMEOUT)

        # Fail closed *before* creating anything. If the endpoint is not
        # enabled, not in this mode, not on this account, not pointed at this
        # namespace's webhook URL, or not subscribed to customer.created, the
        # canary cannot possibly refresh readiness and the Customer would be
        # pure litter on a live account.
        #
        # The cause goes on stdout AND into the CommandError. Django prints a
        # CommandError's message without `--traceback`, so `raise... from
        # exc` alone threw the reason away: stage failed this way on every
        # tick for 30 days saying only "not safely configured".
        try:
            prove_webhook_endpoint(identity)
        except StripeWebhookEndpointMismatch as exc:
            # A mismatch is a configuration fact, not a blip: every tick will
            # find it again, and readiness then expires 24h after the last
            # proof. Page now with the cause -- same reasoning as
            # canary_permission_denied below. A *retrieval* failure (timeout,
            # Stripe 5xx) deliberately does not page here; the next tick may
            # succeed and the age-based signal covers a persistent one.
            self.stdout.write(
                f'{STRIPE_READINESS_EXPIRING_SIGNAL} '
                f'reason={exc.reason}: {exc}'
            )
            raise CommandError(
                f'Stripe webhook endpoint is not safely configured: {exc}'
            ) from exc
        except StripeWebhookReadinessError as exc:
            raise CommandError(
                f'Stripe webhook endpoint is not safely configured: {exc}'
            ) from exc

        customer_id = self._create_canary_customer(identity)
        # Emit the success line before the cleanup call: the metric counts
        # "a canary event was fired at Stripe", and that is already true here.
        # A delete that fails must not make a working canary look dead.
        self.stdout.write(
            f'{_CANARY_FIRED_PREFIX}: '
            f'livemode={str(identity.livemode).lower()}'
        )
        if age_seconds is not None:
            self.stdout.write(
                f'stripe checkout readiness proof age before canary: '
                f'{age_seconds}s'
            )
        self._delete_canary_customer(customer_id)

    def _skip_outside_prod(self, while_disabled: bool) -> bool:
        """Outside prod, a switched-off storefront is the EXPECTED state.

        /: stage ran this against prod's live account every tick
        for 30 days, failed every time (the endpoint belongs to prod's
        origin) and produced 180 failed Jobs that trained everyone to ignore
        the CronJob. Outside prod:

        * live-mode credentials are refused outright -- no Stripe call at
          all, not even the read-only endpoint proof; the structured
          ``stripe_live_credentials_outside_prod`` line names the settings;
        * checkout switched off is the designed state: say so and exit 0,
          without contacting Stripe and without the page phrase.

        Prod is untouched: it keeps every check below, including firing the
        canary while checkout is staged off (the activation runbook needs a
        fresh proof BEFORE the switch flips).
        """
        namespace = getattr(settings, 'NAMESPACE', None)
        if namespace == PROD_NAMESPACE:
            return False
        live = live_stripe_credentials_outside_prod()
        if live:
            log_live_credentials_outside_prod(live, where='readiness_canary')
            self.stdout.write(
                'stripe checkout readiness canary refused: live-mode Stripe '
                f'credentials outside prod (namespace={namespace}, '
                f'settings={",".join(live)}); no Stripe call made'
            )
            return True
        if not while_disabled and not self._checkout_is_activated():
            self.stdout.write(
                'stripe checkout readiness canary skipped: checkout is '
                f'disabled in namespace={namespace} (expected outside prod); '
                'no Stripe call made'
            )
            return True
        return False

    def _checkout_is_activated(self) -> bool:
        """Is a storefront actually taking card payments right now?

        A malformed STRIPE_CHECKOUT_ENABLED is itself a broken switch on a
        money path, so treat it as activated and let the page happen: the
        expensive mistake is staying silent about a checkout that is live.
        """
        try:
            return stripe_checkout_enabled()
        except StripeIdentityConfigurationError:
            return True

    def _report_proof_age(self, identity) -> int | None:
        """Emit the expiry page phrase when the recorded proof is stale."""
        proof = current_readiness_proof(identity)
        max_age = int(READINESS_MAX_AGE.total_seconds())
        warn_age = int(READINESS_WARN_AGE.total_seconds())
        if proof is None:
            self.stdout.write(
                f'{STRIPE_READINESS_EXPIRING_SIGNAL} '
                f'age_seconds=absent max_age_seconds={max_age} '
                f'warn_age_seconds={warn_age}'
            )
            return None
        age_seconds = int(
            (timezone.now() - proof.verified_at).total_seconds()
        )
        if age_seconds >= warn_age:
            self.stdout.write(
                f'{STRIPE_READINESS_EXPIRING_SIGNAL} '
                f'age_seconds={age_seconds} max_age_seconds={max_age} '
                f'warn_age_seconds={warn_age}'
            )
        return age_seconds

    def _idempotency_key(self, identity) -> str:
        return (
            f'{_IDEMPOTENCY_PREFIX}-{identity.account_id}-{uuid.uuid4().hex}'
        )

    def _create_canary_customer(self, identity) -> str:
        try:
            customer = stripe.Customer.create(
                api_key=settings.STRIPE_SECRET_KEY,
                max_network_retries=0,
                idempotency_key=self._idempotency_key(identity),
                description=(
                    'free2z webhook readiness canary - nonfinancial, '
                    'no payment method, safe to delete'
                ),
                metadata={_CANARY_METADATA_KEY: 'true'},
            )
        except (
            stripe.error.PermissionError,
            stripe.error.AuthenticationError,
        ) as exc:
            # A restricted key (`rk_*`) is an accepted checkout credential, and
            # permission to create a Checkout Session does NOT imply permission
            # to write Customers. That 403 is unrecoverable by retry: every
            # tick fails identically until someone edits the key, and readiness
            # then expires 24h after the last real sale. Page immediately with
            # the cause rather than waiting for the absence policy to notice
            # eight hours of silence.
            self.stdout.write(
                f'{STRIPE_READINESS_EXPIRING_SIGNAL} '
                f'reason=canary_permission_denied: the checkout credential '
                f'cannot write Customers (restricted keys need Customers: '
                f'write)'
            )
            raise CommandError(
                'Stripe readiness canary Customer was refused by the '
                'credential'
            ) from exc
        except stripe.error.StripeError as exc:
            raise CommandError(
                'Stripe readiness canary Customer could not be created'
            ) from exc
        livemode = getattr(customer, 'livemode', None)
        if livemode is not identity.livemode:
            # The credential answered in a different mode than the operator
            # declared. A canary delivered in the wrong mode can never satisfy
            # webhook_is_ready, and a live-mode surprise on a test deployment
            # is worth failing loudly over.
            raise CommandError(
                'Stripe readiness canary was created in an unexpected mode'
            )
        customer_id = getattr(customer, 'id', None)
        if not isinstance(customer_id, str) or not customer_id.startswith(
            'cus_'
        ):
            raise CommandError(
                'Stripe readiness canary returned a non-canonical Customer'
            )
        return customer_id

    def _delete_canary_customer(self, customer_id: str) -> None:
        """Best effort. The event is already queued; the object is inert."""
        try:
            stripe.Customer.delete(
                customer_id,
                api_key=settings.STRIPE_SECRET_KEY,
                max_network_retries=0,
            )
        except stripe.error.StripeError:
            self.stdout.write(
                'stripe checkout readiness canary cleanup failed: '
                f'delete {_CANARY_METADATA_KEY} Customer by hand'
            )
