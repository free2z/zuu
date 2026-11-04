"""The Stripe API version is a reviewed decision, not a Dependabot side effect.

``stripe.api_version`` was pinned nowhere before, so the ``Stripe-Version``
header on every outbound call was whatever version the installed SDK happened
to bundle.  (8.10.0 -> 15.5.0) therefore moved the wire contract from
``2023-10-16`` to ``2026-07-29.dahlia`` -- Acacia, Basil, Clover and Dahlia,
four breaking API releases -- inside a one-line requirements diff, with nothing
in CI able to notice. It happened to be safe: Dahlia (2026-03-25) removed the
``ui_mode`` values ``hosted`` / ``embedded`` / ``custom``, and
``create_checkout_session`` has simply never set ``ui_mode``.

Two things are asserted here, and they are different:

1. **The pin is on the wire.** Setting a module-level attribute is only useful
   if the SDK still reads it, so this drives a real ``checkout.Session.create``
   against a fake transport and reads the header the SDK would have sent.
2. **The SDK's own default has not moved.** This is the tripwire. When a bump
   changes what stripe-python would send by itself, this goes red -- not
   because the new version is wrong, but because choosing it is a decision that
   needs a changelog read. Moving ``STRIPE_API_VERSION`` and moving
   ``SDK_DEFAULT_API_VERSION_AT_PIN_TIME`` are then two deliberate lines in a
   PR that says why.

Note (2) does **not** require the pin to track the SDK. It is fine, and often
correct, for the two to differ for a while -- that is exactly what pinning is
for. What is not fine is for them to differ because nobody looked.
"""
import pytest
import stripe

from dj.apps.ztripe.views import STRIPE_API_VERSION

#What stripe-python would send on its own with the currently pinned
#requirement (16.0.0). Bump this in the same PR that reviews the changelog.
SDK_DEFAULT_API_VERSION_AT_PIN_TIME = "2026-09-30.endive"


class _RecordingHTTPClient:
    """Stands in for the network. Records headers, answers a canned session.

    The DB is real everywhere in this repo; Stripe's HTTPS endpoint is not
    something a test may reach, and this is the boundary -- not the logic.
    """

    name = "recording"

    def __init__(self):
        self.headers = None

    def request_with_retries(self, method, url, headers, post_data=None,
                             *args, **kwargs):
        self.headers = headers
        return (
            '{"id": "cs_test_pin", "object": "checkout.session",'
            ' "url": "https://checkout.stripe.com/pin"}',
            200,
            {},
        )

    def close(self):
        pass


@pytest.fixture
def recorded_headers(monkeypatch):
    client = _RecordingHTTPClient()
    monkeypatch.setattr(stripe, "default_http_client", client, raising=False)
    monkeypatch.setattr(stripe, "api_key", "sk_test_pin", raising=False)
    stripe.checkout.Session.create(
        mode="payment",
        line_items=[],
        success_url="https://example.test/ok",
        cancel_url="https://example.test/no",
    )
    return client.headers


def test_the_pin_is_what_goes_out_on_the_wire(recorded_headers):
    """A module attribute nobody reads would be a comment, not a pin."""
    assert recorded_headers["Stripe-Version"] == STRIPE_API_VERSION


def test_the_pin_is_an_explicit_dated_version():
    """Guards against ``None`` / ``""`` quietly restoring the SDK default."""
    assert isinstance(STRIPE_API_VERSION, str)
    assert STRIPE_API_VERSION[:4].isdigit(), STRIPE_API_VERSION
    assert stripe.api_version == STRIPE_API_VERSION


def test_the_sdk_default_has_not_moved_under_the_pin():
    """The tripwire. Red means an SDK bump changed the default API version.

    That is not a failure of this test and not necessarily a problem with the
    bump -- it is the review that  only got by luck. Read the API
    changelog between the two versions, decide whether to move
    ``STRIPE_API_VERSION``, and update the constant above either way.
    """
    # `stripe.api_version` is assigned by dj.apps.ztripe.views at import time,
    # so the SDK's untouched default has to be read from the module that
    # defines it rather than from the mutated global.
    assert _sdk_default() == SDK_DEFAULT_API_VERSION_AT_PIN_TIME, (
        f"stripe-python now defaults to {_sdk_default()!r}, not "
        f"{SDK_DEFAULT_API_VERSION_AT_PIN_TIME!r}. Review the Stripe API "
        "changelog for every release in between, then update "
        "SDK_DEFAULT_API_VERSION_AT_PIN_TIME -- and STRIPE_API_VERSION too if "
        "the new contract is the one we want."
    )


def _sdk_default():
    """stripe-python's bundled API version, independent of our assignment."""
    from stripe._api_version import _ApiVersion

    return _ApiVersion.CURRENT
