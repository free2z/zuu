"""The status contract of /api/stripe/create-checkout-session/.

On this endpoint a **503 means designed, and only designed**: ZUULI asked for
the native return and it is off or not ready (the app retries as ``web``), or
the operator switched card checkout off. Every genuine failure -- our
configuration, our infrastructure, or Stripe -- is a 500 or a 502.

Why it matters: the shipped ZUULI build retries a native checkout as ``web``
on exactly ``status === 503`` and on nothing else (zuu
``wallet/zuuli/src/features/wallet/funding/card-checkout.ts``,
``createNativeOrWebCheckout``), so the designed refusal cannot move off 503
without breaking installed apps. The write-failure alerts  therefore
exclude a 503 on this one path. Before this, a broken Stripe configuration
ALSO answered 503 here and was excluded with it: a real card-checkout outage
invisible to every count-based alert.
"""

import ast
import inspect
import json
import logging
from pathlib import Path
from unittest.mock import patch

import pytest
import stripe

from dj.apps.ztripe import views
from dj.apps.ztripe.models import CheckoutIntent
from dj.apps.ztripe.native_return import NativeReturnUnavailable
from dj.apps.ztripe.serializers import CHECKOUT_ERROR_CODES

URL = '/api/stripe/create-checkout-session/'
HEADER = 'X-Free2Z-Designed-Fallback'
ACCOUNT = 'acct_designedFallback01'
DESIGNED_503_CODES = {'native_checkout_unavailable', 'checkout_not_activated'}


@pytest.fixture(autouse=True)
def working_checkout(settings, db):
    """Card checkout that succeeds, so each test breaks exactly one thing."""
    settings.STRIPE_SECRET_KEY = 'sk_test_designedFallback'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = ACCOUNT
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_CHECKOUT_ENABLED = 'true'
    settings.ZUULI_NATIVE_CHECKOUT_ENABLED = False
    with patch('dj.apps.ztripe.views.webhook_is_ready', return_value=True):
        yield


@pytest.fixture
def buyer(api_client, creator_factory):
    api_client.force_authenticate(user=creator_factory())
    return api_client


@pytest.fixture
def session_create():
    with patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as create:
        create.return_value.id = 'cs_test_designed_fallback'
        create.return_value.url = (
            'https://checkout.stripe.com/c/pay/cs_test_designed_fallback'
        )
        create.return_value.mode = 'payment'
        create.return_value.livemode = False
        create.return_value.account = None
        yield create


def post(client, return_mode):
    return client.post(
        URL,
        {'quantity': 100, 'currentPath': '/wallet/fund',
         'returnMode': return_mode},
        format='json',
    )


def events(caplog):
    found = []
    for record in caplog.records:
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if isinstance(payload, dict) and 'event' in payload:
            found.append((record.levelno, payload))
    return found


def shipped_zuuli_buy(client):
    """The shipped ZUULI app's ``createNativeOrWebCheckout``, transcribed.

    ``zuuli_mobile`` first; on ``status === 503`` exactly, once more as
    ``web``; anything else is final. Kept literal on purpose: this is the
    contract installed apps hold us to, not the one we would design today.
    """
    first = post(client, 'zuuli_mobile')
    # status-negation-ok: this transcribes the shipped client's branch, not
    # an assertion; the callers assert the exact statuses.
    if first.status_code != 503:
        return [first]
    return [first, post(client, 'web')]


# --- the designed 503 ------------------------------------------------------


@pytest.mark.django_db
def test_native_checkout_gated_off_is_a_marked_503_the_shipped_app_retries(
    buyer, session_create, caplog,
):
    caplog.set_level(logging.INFO, logger='dj.apps.ztripe.views')

    first, second = shipped_zuuli_buy(buyer)

    assert first.status_code == 503
    assert first[HEADER] == 'native-checkout'
    assert first.json()['code'] == 'native_checkout_unavailable'
    # The installed app's retry reaches a real, payable web Session.
    assert second.status_code == 200, second.content
    assert HEADER not in second
    session_create.assert_called_once()
    assert CheckoutIntent.objects.count() == 1
    assert (logging.INFO, {
        'event': 'stripe_checkout_native_fallback', 'reason': 'disabled',
    }) in events(caplog)


@pytest.mark.django_db
def test_native_checkout_enabled_but_not_ready_is_the_same_marked_503(
    buyer, session_create, settings, caplog,
):
    settings.ZUULI_NATIVE_CHECKOUT_ENABLED = True
    caplog.set_level(logging.INFO, logger='dj.apps.ztripe.views')
    with patch(
        'dj.apps.ztripe.views.validated_native_return_origin',
        return_value=('https://pay.example', None),
    ), patch(
        'dj.apps.ztripe.views.ensure_native_return_endpoint_ready',
        side_effect=NativeReturnUnavailable('callback host not ready'),
    ):
        first, second = shipped_zuuli_buy(buyer)

    assert first.status_code == 503
    assert first[HEADER] == 'native-checkout'
    assert first.json()['code'] == 'native_checkout_unavailable'
    assert second.status_code == 200, second.content
    # Louder than the gated-off case: an enabled path that is not ready is
    # worth a look, even though the buyer is fine.
    assert (logging.WARNING, {
        'event': 'stripe_checkout_native_fallback', 'reason': 'not_ready',
    }) in events(caplog)


@pytest.mark.django_db
def test_staged_off_checkout_is_a_designed_503_without_the_native_marker(
    buyer, session_create, settings,
):
    settings.STRIPE_CHECKOUT_ENABLED = 'false'

    response = post(buyer, 'web')

    assert response.status_code == 503
    assert response.json()['code'] == 'checkout_not_activated'
    assert HEADER not in response
    session_create.assert_not_called()


# --- genuine failures: never 503, never marked ------------------------------


def _host_policy_empty(settings):
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset()


def _account_unconfigured(settings):
    settings.STRIPE_EXPECTED_ACCOUNT_ID = ''


def _switch_malformed(settings):
    settings.STRIPE_CHECKOUT_ENABLED = 'yes'


GENUINE_CONFIG_FAILURES = [
    pytest.param(
        _host_policy_empty, 'checkout_host_policy_unavailable',
        'stripe_checkout_host_policy_unavailable', id='empty-host-policy',
    ),
    pytest.param(
        _account_unconfigured, 'checkout_not_configured',
        'stripe_checkout_identity_not_configured', id='identity-unconfigured',
    ),
    pytest.param(
        _switch_malformed, 'checkout_not_configured',
        'stripe_checkout_identity_not_configured', id='malformed-switch',
    ),
]


@pytest.mark.django_db
@pytest.mark.parametrize('return_mode', ['web', 'zuuli_mobile'])
@pytest.mark.parametrize(('breakage', 'code', 'event'), GENUINE_CONFIG_FAILURES)
def test_our_configuration_failing_is_a_500_the_alerts_count(
    buyer, session_create, settings, caplog, return_mode, breakage, code,
    event,
):
    # Native enabled and ready, so a zuuli_mobile request is not answered by
    # the designed fallback first and really reaches the broken check.
    settings.ZUULI_NATIVE_CHECKOUT_ENABLED = True
    breakage(settings)
    caplog.set_level(logging.INFO, logger='dj.apps.ztripe.views')
    with patch(
        'dj.apps.ztripe.views.validated_native_return_origin',
        return_value=('https://pay.example', None),
    ), patch(
        'dj.apps.ztripe.views.ensure_native_return_endpoint_ready',
    ), patch(
        'dj.apps.ztripe.views.ensure_native_return_admission_ready',
    ):
        responses = shipped_zuuli_buy(buyer) if return_mode == 'zuuli_mobile' \
            else [post(buyer, 'web')]

    # The shipped app does not retry a 500 -- right, since web would fail the
    # same way -- so the buyer sees exactly one failure, and it is counted.
    assert len(responses) == 1
    (response,) = responses
    assert response.status_code == 500, response.content
    assert response.json()['code'] == code
    assert HEADER not in response
    session_create.assert_not_called()
    assert (logging.ERROR, {'event': event}) in events(caplog)


@pytest.mark.django_db
def test_stale_webhook_readiness_is_a_500(buyer, session_create, caplog):
    caplog.set_level(logging.INFO, logger='dj.apps.ztripe.views')
    with patch('dj.apps.ztripe.views.webhook_is_ready', return_value=False):
        response = post(buyer, 'web')

    assert response.status_code == 500
    assert response.json()['code'] == 'checkout_not_configured'
    assert HEADER not in response
    assert (logging.ERROR, {'event': 'stripe_checkout_webhook_not_ready'}) \
        in events(caplog)


@pytest.mark.django_db
def test_stripe_rejecting_session_create_is_a_logged_502(
    buyer, session_create, caplog,
):
    session_create.side_effect = stripe.error.AuthenticationError(
        'Invalid API Key provided: sk_live_************leak',
    )
    caplog.set_level(logging.INFO, logger='dj.apps.ztripe.views')

    response = post(buyer, 'web')

    assert response.status_code == 502
    assert response.json()['code'] == 'stripe_unavailable'
    assert HEADER not in response
    assert (logging.ERROR, {
        'event': 'stripe_checkout_session_create_failed',
        'error_type': 'AuthenticationError',
    }) in events(caplog)
    # The class name, never the provider's message.
    assert 'sk_live' not in caplog.text
    intent = CheckoutIntent.objects.get()
    assert intent.state == CheckoutIntent.State.PROVIDER_FAILED


@pytest.mark.django_db
def test_admission_store_outage_is_a_500(buyer, session_create, caplog):
    from unittest.mock import Mock

    import redis

    from dj.free2z.throttling import StripeCheckoutUserRateThrottle

    unavailable = Mock()
    unavailable.get.side_effect = redis.exceptions.ConnectionError('down')
    caplog.set_level(logging.INFO, logger='dj.free2z.throttling')
    with patch.object(StripeCheckoutUserRateThrottle, 'cache', unavailable):
        response = post(buyer, 'zuuli_mobile')

    assert response.status_code == 500
    assert HEADER not in response
    session_create.assert_not_called()
    assert (logging.ERROR, {
        'event': 'stripe_checkout_admission_unavailable',
        'error_type': 'ConnectionError',
    }) in events(caplog)


# --- the contract, statically ----------------------------------------------


def _checkout_error_calls():
    """Every ``(status, code)`` the view module can answer with."""
    tree = ast.parse(inspect.getsource(views))
    calls = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == '_checkout_error'
            and len(node.args) >= 2
            and all(isinstance(a, ast.Constant) for a in node.args[:2])
        ):
            calls.append((node.args[0].value, node.args[1].value))
    return calls


def test_every_503_the_view_can_answer_is_a_designed_one():
    calls = _checkout_error_calls()
    # Guard the guard: the scan must actually see the view's answers.
    assert (503, 'native_checkout_unavailable') in calls
    assert (500, 'checkout_host_policy_unavailable') in calls
    assert {code for status, code in calls if status == 503} \
        == DESIGNED_503_CODES
    assert {code for _status, code in calls} <= set(CHECKOUT_ERROR_CODES)


def test_the_view_answers_no_bare_503():
    """A new ``JsonResponse(..., status=503)`` would bypass the contract."""
    source = Path(inspect.getsourcefile(views)).read_text()
    start = source.index('def create_checkout_session(')
    end = source.index('\ndef ', start + 1)
    assert 'status=503' not in source[start:end]
