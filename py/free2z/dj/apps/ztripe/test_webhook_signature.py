"""The Stripe webhook's signature check, exercised for real.

``STRIPE_SIGNING_SECRET`` is the *only* thing standing between a JSON POST and
free 2Z, and until this file every test that reached the webhook replaced
``stripe.Webhook.construct_event`` with a lambda. Those are good tests -- they
are about our atomicity and quantity logic, and stubbing a crypto boundary is
the right call for what they assert -- but it meant a green ``gate`` said
nothing at all about whether verification still worked.

Both directions of that are bad, and neither announces itself:

* fail **closed** and every genuine delivery is rejected. Stripe retries, we
  keep answering 400, customers' cards are charged and no 2Z ever arrive. The
  only symptom is a quiet revenue stop.
* fail **open** -- or someone "fixes" a mysterious 400 by skipping the check --
  and anyone who can reach the URL mints 2Z by POSTing JSON.

So this file drives the real view over the real HMAC, with a real
``stripe.Event`` coming out the other side. It became possible with
stripe-python 15.5.0, which added
``WebhookSignature.generate_signature_header``; 8.10.0 had no way to produce a
valid signature offline, which is almost certainly why the older tests mock.

What is deliberately asserted, beyond "a good signature works":

* a **forged** or malformed header credits nothing -- the balance is checked
  after every rejection, not just the status code;
* a payload **tampered with after signing** is rejected, which is the property
  the HMAC actually provides;
* a **stale timestamp** is rejected, which is the replay defence and the one
  thing a naive "does the HMAC match" check would let through;
* ``construct_event`` returns a ``stripe.Event``, **not a dict**. In v15
  ``StripeObject`` stopped inheriting from ``dict``: ``dict(event)`` raises and
  ``.get()`` / ``.items()`` are gone. The view uses only ``[...]`` subscripts,
  which still work -- but the dict-shaped fixtures elsewhere would let someone
  add ``session.get(...)`` tomorrow, pass CI, and 500 in production.
"""
import json
import time
from decimal import Decimal
from unittest.mock import patch

import pytest
import stripe
from django.urls import reverse

from dj.apps.ztripe.models import StripeCheckoutRollout

from dj.apps.g12f.models import Creator
from dj.apps.ztripe.models import StripeTransaction

#Not the production secret and not a real one; the HMAC does not care.
SIGNING_SECRET = "whsec_test_1148_signature_round_trip"
TEST_STRIPE_ACCOUNT_ID = "acct_testWebhookSignature"


def sign(payload, secret=SIGNING_SECRET, timestamp=None):
    """A genuine ``Stripe-Signature`` header for ``payload``.

    Exported for the atomicity tests in ``dj.apps.tuzis`` so they can post
    honestly signed deliveries instead of stubbing the SDK.
    """
    return stripe.WebhookSignature.generate_signature_header(
        payload, secret, timestamp=timestamp,
    )


def checkout_completed(user, payment_intent, amount_total=500):
    """The JSON *string* Stripe would POST, ready to sign.

    A string, not a dict, on purpose: the signature covers the exact bytes on
    the wire, so anything that re-serialises between signing and sending would
    invalidate it.
    """
    return json.dumps({
        "id": "evt_test_1148",
        "object": "event",
        "type": "checkout.session.completed",
        "livemode": False,
        "data": {"object": {
            "id": "cs_test_1148",
            "object": "checkout.session",
            "created": 1700000000,
            "client_reference_id": str(user.pk),
            "payment_status": "paid",
            "mode": "payment",
            "livemode": False,
            "amount_total": amount_total,
            "currency": "usd",
            "payment_intent": payment_intent,
            "metadata": {},
        }},
    })


def balance(creator):
    return Creator.objects.values_list("tuzis", flat=True).get(pk=creator.pk)


def post(client, payload, signature):
    kwargs = {}
    if signature is not None:
        kwargs["HTTP_STRIPE_SIGNATURE"] = signature
    return client.post(
        reverse("stripe-webhook"), data=payload,
        content_type="application/json", **kwargs,
    )


pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _signing_secret(settings):
    """The view reads the secret per request, so a settings override is enough.

    Deployed configuration leaves ``STRIPE_SIGNING_SECRET`` as ``""`` when the
    env var is missing, and an empty HMAC key still produces valid-looking
    signatures -- so tests must set a real one rather than inherit the default,
    or "verification works" would be asserted against a secret an attacker also
    knows.
    """
    settings.STRIPE_SIGNING_SECRET = SIGNING_SECRET
    settings.STRIPE_SECRET_KEY = "sk_test_webhook_signature"
    settings.STRIPE_EXPECTED_ACCOUNT_ID = TEST_STRIPE_ACCOUNT_ID
    settings.STRIPE_EXPECTED_LIVEMODE = "false"
    settings.STRIPE_CHECKOUT_ENABLED = "true"
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = "we_testWebhookSignature"
    StripeCheckoutRollout.objects.get_or_create(
        singleton=1,
        defaults={
            "legacy_session_created_at_or_before_epoch": 1_735_689_600,
        },
    )
    with patch('dj.apps.ztripe.views.verify_and_record_checkout_event'):
        yield


def test_a_genuinely_signed_event_is_accepted_and_credits(
        client, creator_factory):
    user = creator_factory(tuzis=Decimal("0"))
    payload = checkout_completed(user, "pi_1148_good")

    response = post(client, payload, sign(payload))

    assert response.status_code == 200, response.content
    assert balance(user) > Decimal("0"), "a verified purchase credited nothing"
    assert StripeTransaction.objects.filter(
        stripe_charge_id="pi_1148_good").exists()


@pytest.mark.parametrize("signature", [
    pytest.param(None, id="header-absent"),
    pytest.param("", id="header-empty"),
    pytest.param("garbage", id="header-unparseable"),
    pytest.param("t=1,v1=deadbeef", id="header-well-formed-wrong-digest"),
    pytest.param("t=1,v1=", id="header-empty-digest"),
])
def test_a_forged_signature_is_rejected_and_mints_nothing(
        client, creator_factory, signature):
    """400, and -- the part that matters -- no 2Z and no transaction row."""
    user = creator_factory(tuzis=Decimal("0"))
    payload = checkout_completed(user, "pi_1148_forged")

    response = post(client, payload, signature)

    assert response.status_code == 400, response.content
    assert balance(user) == Decimal("0"), "a forged event minted 2Z"
    assert not StripeTransaction.objects.filter(
        stripe_charge_id="pi_1148_forged").exists()


def test_a_signature_from_the_wrong_secret_is_rejected(
        client, creator_factory):
    """The check is against OUR secret, not merely "some valid HMAC"."""
    user = creator_factory(tuzis=Decimal("0"))
    payload = checkout_completed(user, "pi_1148_wrong_secret")

    response = post(client, payload, sign(payload, secret="whsec_not_ours"))

    assert response.status_code == 400, response.content
    assert balance(user) == Decimal("0")


def test_a_payload_tampered_with_after_signing_is_rejected(
        client, creator_factory):
    """The property the HMAC actually buys: the body cannot be edited.

    Signing a 500-cent purchase and delivering a 5,000,000-cent one is the
    attack integrity protection exists for.
    """
    user = creator_factory(tuzis=Decimal("0"))
    honest = checkout_completed(user, "pi_1148_tampered", amount_total=500)
    signature = sign(honest)
    tampered = honest.replace('"amount_total": 500',
                              '"amount_total": 5000000')
    assert tampered != honest, "the tamper did not change the payload"

    response = post(client, tampered, signature)

    assert response.status_code == 400, response.content
    assert balance(user) == Decimal("0"), "a tampered amount was credited"


def test_a_stale_timestamp_is_rejected(client, creator_factory):
    """The replay defence, which a bare "does the digest match" check misses.

    A captured delivery stays perfectly signed forever; only the timestamp
    inside the header, checked against ``DEFAULT_TOLERANCE`` (300s), stops it
    being replayed a year later.
    """
    user = creator_factory(tuzis=Decimal("0"))
    payload = checkout_completed(user, "pi_1148_stale")
    stale = sign(payload, timestamp=int(time.time()) - 3600)

    response = post(client, payload, stale)

    assert response.status_code == 400, response.content
    assert balance(user) == Decimal("0")


def test_a_signature_just_inside_the_tolerance_is_accepted(
        client, creator_factory):
    """Paired with the test above so "reject everything" cannot pass both.

    Also the reason the tolerance is not tightened casually: clock skew
    between Stripe and this cluster eats into the same 300s budget.
    """
    user = creator_factory(tuzis=Decimal("0"))
    payload = checkout_completed(user, "pi_1148_fresh_enough")
    recent = sign(payload, timestamp=int(time.time()) - 60)

    response = post(client, payload, recent)

    assert response.status_code == 200, response.content
    assert balance(user) > Decimal("0")


def test_a_correctly_signed_non_json_body_is_a_400_not_a_500(client):
    """The view's ``except ValueError`` branch, which nothing else reaches.

    Only a *validly signed* body gets past verification far enough for the
    JSON decode to be what fails, so this branch is unreachable without the
    real signing helper.
    """
    payload = "this is signed, and it is not JSON"

    response = post(client, payload, sign(payload))

    assert response.status_code == 400, response.content
    assert response.json()["detail"] == "Invalid payload."


def test_an_unconfigured_signing_secret_fails_closed(
        client, creator_factory, settings):
    """The fail-open case a test that always sets the secret would hide.

    ``STRIPE_SIGNING_SECRET`` is ``os.environ.get(..., "")``, and an empty HMAC
    key verifies signatures perfectly well -- ones anybody can compute. A
    namespace brought up without the Secret, or a rotation that lands the
    Deployment first, would therefore not fail visibly: it would turn this
    endpoint into "POST JSON, receive 2Z". Found by the codex review of.

    503 rather than 400 because the delivery is presumably genuine and the
    configuration is what is broken, so Stripe's retry should still credit the
    customer once the secret is in place.
    """
    settings.STRIPE_SIGNING_SECRET = ""
    user = creator_factory(tuzis=Decimal("0"))
    payload = checkout_completed(user, "pi_1148_no_secret")

    response = post(client, payload, sign(payload, secret=""))

    assert response.status_code == 503, response.content
    assert balance(user) == Decimal("0"), (
        "an empty signing secret let a self-signed event mint 2Z"
    )
    assert not StripeTransaction.objects.filter(
        stripe_charge_id="pi_1148_no_secret").exists()


def test_construct_event_returns_a_stripe_event_not_a_dict():
    """Guards the shape the view parses, not just the crypto.

    stripe-python 15 stopped making ``StripeObject`` a ``dict`` subclass. Every
    other test in the repo feeds the webhook handler a literal dict, so the
    handler could grow a ``.get()`` / ``**session`` / ``dict(event)`` and stay
    green while failing on every real delivery. If this assertion ever flips,
    the SDK changed its mind and the fixtures elsewhere are free to relax --
    until then they are lying, and this says so out loud.
    """
    payload = json.dumps({"type": "ping", "data": {"object": {"a": 1}}})
    event = stripe.Webhook.construct_event(
        payload, sign(payload), SIGNING_SECRET,
    )

    assert isinstance(event, stripe.Event)
    assert not isinstance(event, dict)
    assert not hasattr(event, "get")
    assert event["type"] == "ping"
    assert event["data"]["object"]["a"] == 1
