import re
import uuid
from urllib.parse import urlsplit

import stripe
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from rest_framework import serializers as drf_serializers

from dj.apps.ztripe.serializers import validate_stripe_checkout_url
# Imported for its module-level transport setup as much as for the constant:
# dj.apps.ztripe.views pins stripe.api_version, installs the bounded
# RequestsClient(timeout=(3.05, 5)) and sets max_network_retries = 0. Buyer
# traffic gets that configuration because the URLconf imports views; a
# management command does NOT necessarily (``--skip-checks`` alone removes the
# import). A preflight that talks to Stripe on a different API version, with
# an unbounded socket, during a cutover window is not a preflight -- so make
# the dependency explicit instead of incidental.
from dj.apps.ztripe.views import STRIPE_API_VERSION
from dj.free2z.settings import _parse_stripe_checkout_allowed_hosts


_SESSION_ID = re.compile(r"^cs_[A-Za-z0-9_]{3,252}$")
_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9_.:-]{8,255}$")
_PREFLIGHT_PURPOSE = "stripe_checkout_host_preflight"


class Command(BaseCommand):
    help = (
        "Create and immediately expire a Stripe Checkout Session, then verify "
        "that its live hosted URL matches the configured exact-host policy."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--expected-host",
            help=(
                "Verify a single candidate exact hostname instead of the active "
                "setting. Use this while checkout traffic is disabled, before "
                "deploying a Stripe Custom Domain allowlist change."
            ),
        )
        parser.add_argument(
            "--idempotency-key",
            help=(
                "Reuse a previous run's idempotency key. If a run died with an "
                "ambiguous network result, rerunning with the key it printed "
                "returns the SAME Session instead of creating a second live "
                "one. Defaults to a fresh random key."
            ),
        )

    def handle(self, *args, **options):
        if not settings.STRIPE_SECRET_KEY:
            raise CommandError("STRIPE_SECRET_KEY is not configured.")

        allowed_hosts = settings.STRIPE_CHECKOUT_ALLOWED_HOSTS
        expected_host = options.get("expected_host")
        if expected_host is not None:
            allowed_hosts = _parse_stripe_checkout_allowed_hosts(expected_host)
            if allowed_hosts != frozenset({expected_host.strip().lower()}):
                raise CommandError("--expected-host must be one exact DNS hostname.")
        if not allowed_hosts:
            raise CommandError("Stripe Checkout host policy is unavailable.")

        idempotency_key = options.get("idempotency_key")
        if idempotency_key is None:
            idempotency_key = f"free2z-checkout-host-preflight-{uuid.uuid4()}"
        elif not _IDEMPOTENCY_KEY.fullmatch(idempotency_key):
            raise CommandError(
                "--idempotency-key must be 8-255 characters of "
                "[A-Za-z0-9_.:-]."
            )

        return_url = f"{settings.CANONICAL_ORIGIN.rstrip('/')}/"
        try:
            session = stripe.checkout.Session.create(
                payment_method_types=["card"],
                line_items=[{
                    "price_data": {
                        "currency": "usd",
                        "product_data": {
                            "name": "Checkout host verification — do not purchase",
                        },
                        "unit_amount": 100,
                    },
                    "quantity": 1,
                }],
                mode="payment",
                success_url=return_url,
                cancel_url=return_url,
                metadata={"purpose": _PREFLIGHT_PURPOSE},
                # Explicit, not inherited: same key, same pinned wire contract
                # and same no-retry boundary as buyer traffic.
                idempotency_key=idempotency_key,
                api_key=settings.STRIPE_SECRET_KEY,
                stripe_version=STRIPE_API_VERSION,
                max_network_retries=0,
            )
        except Exception as exc:
            # A failed CALL is not proof that no Session exists: the request
            # can reach Stripe and the response be lost. Say so, and hand back
            # the key that makes a retry return the same Session instead of
            # creating a second live one.
            raise CommandError(
                "Stripe Checkout preflight Session creation failed. A Session "
                "MAY have been created -- retry with "
                f"--idempotency-key {idempotency_key} to get that same Session "
                "back (and expire it), or find and expire any Session with "
                f"metadata purpose={_PREFLIGHT_PURPOSE} in the Stripe Dashboard."
            ) from exc

        session_id = getattr(session, "id", None)
        session_url = getattr(session, "url", None)
        # Validate ONLY the hosted-URL policy here, with the exact same
        # function create_checkout_session enforces. The full response
        # contract (session id shape, the server-owned quote from ) is
        # deliberately not re-checked: this command creates a throwaway
        # Session with no CheckoutIntent behind it, so a quote is absent by
        # construction and asserting on it would fail every run.
        try:
            validate_stripe_checkout_url(session_url, allowed_hosts)
        except drf_serializers.ValidationError:
            valid = False
        else:
            valid = True

        # A Session was created, so SOMETHING is live on the Stripe side. If
        # the response did not carry a usable id we cannot expire it and we
        # cannot name it -- that is a cleanup task for a human, not a success.
        # Never fall through to the success line here: the whole point of this
        # command is that it leaves nothing behind.
        if not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
            raise CommandError(
                "Stripe created a Checkout Session but returned no usable id, "
                "so it could not be expired. Find and expire the most recent "
                f"Session with metadata purpose={_PREFLIGHT_PURPOSE} in the "
                "Stripe Dashboard."
            )

        try:
            stripe.checkout.Session.expire(
                session_id,
                api_key=settings.STRIPE_SECRET_KEY,
                stripe_version=STRIPE_API_VERSION,
                max_network_retries=0,
            )
        except Exception as exc:
            raise CommandError(
                "Stripe Checkout preflight Session could not be expired; "
                f"expire {session_id} in the Stripe Dashboard."
            ) from exc

        if not valid:
            raise CommandError(
                "Stripe returned a Checkout hostname outside the expected policy."
            )

        self.stdout.write(self.style.SUCCESS(
            "Verified live Stripe Checkout host: "
            f"{urlsplit(session_url).hostname}"
        ))
