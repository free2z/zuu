"""The Stripe webhook only answers POST.

Signature verification is what makes this endpoint safe, and that is
unchanged: nothing here is a substitute for ``STRIPE_SIGNING_SECRET``. What
the method guard removes is the endpoint answering a bare ``GET`` at all.
Before, a GET fell through to ``stripe.Webhook.construct_event`` with an
empty body and no signature header, which returned ``400 {"detail": "Invalid
payload."}`` — a free confirmation to any crawler that a Stripe webhook lives
at this path, and a stream of exception-shaped 400s in the logs that are
indistinguishable from real failed deliveries.

The POST case is asserted too, so the guard can never be "passing" because
the route stopped working altogether.
"""
import pytest
from django.urls import reverse

# AtomicMiddleware opens transaction.atomic() on every POST/PUT/PATCH before
# the view runs, so even a request that never touches a model needs a real
# database connection.
pytestmark = pytest.mark.django_db


@pytest.mark.parametrize("method", ["get", "head", "put", "patch", "delete"])
def test_non_post_methods_are_refused(client, method):
    resp = getattr(client, method)(reverse("stripe-webhook"))

    assert resp.status_code == 405
    # Advertised as POST-only rather than just refused.
    assert "POST" in resp.headers.get("Allow", "")
    # No 400 "Invalid payload." oracle from the Stripe SDK.
    assert b"payload" not in resp.content.lower()


def test_post_still_reaches_signature_verification(client, settings):
    """POST is not blocked by the method guard; it is blocked by the signature.

    An unsigned POST must still be rejected — by ``construct_event``, with the
    400 that has always been the answer for an unverifiable delivery, not by
    the method decorator and not by CSRF (the view stays ``csrf_exempt``, so
    Stripe's cookie-less POST is never turned away with a 403).

    The signing secret has to be set for this to mean anything: an
    unconfigured secret short-circuits to 503 *before* verification, so
    without this line the test would pass while proving the opposite of what
    it says. See ``test_webhook_signature.py``.
    """
    settings.STRIPE_SIGNING_SECRET = "whsec_test_method_guard"
    resp = client.post(
        reverse("stripe-webhook"),
        data='{"type": "checkout.session.completed"}',
        content_type="application/json",
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] in ("Invalid payload.", "Invalid signature.")
