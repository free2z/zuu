"""Outside prod, live-mode Stripe credentials never enable checkout.

Stage held prod's LIVE secret key, signing secret and webhook endpoint for
at least 30 days; only ``STRIPE_CHECKOUT_ENABLED=false`` stood
between that and a real charge whose fulfillment webhook would land in PROD
carrying stage (DBCOPY) row ids. These tests pin the guard that makes the
switch alone insufficient:

* ``stripe_checkout_enabled()`` answers False outside prod whenever live
  material is configured, whatever the switch says, and logs one structured
  ERROR naming the settings -- never their values;
* the create-checkout-session view therefore answers its designed
  ``checkout_not_activated`` 503 and never reaches Stripe;
* ``ZtripeConfig.ready()`` reports it at boot, and does NOT raise (see its
  docstring for why failing boot would take stage down with it);
* prod, and non-prod TEST-mode credentials, are unaffected.

Negative control: each ``refused`` assertion below fails if the guard in
``stripe_checkout_enabled`` is removed (the switch alone then decides).
"""

import json
import logging
from unittest.mock import patch

import pytest

from dj.apps.ztripe import stripe_identity
from dj.apps.ztripe.apps import ZtripeConfig
from dj.apps.ztripe.stripe_identity import (
    LIVE_STRIPE_OUTSIDE_PROD_EVENT,
    live_stripe_credentials_outside_prod,
    stripe_checkout_enabled,
)

URL = '/api/stripe/create-checkout-session/'
LIVE_SECRET = 'sk_live_guardSecretValue'
SIGNING = 'whsec_guardSigningValue'


@pytest.fixture
def live_on(settings):
    """A namespace carrying prod's shape of live credentials, switch ON."""
    settings.STRIPE_SECRET_KEY = LIVE_SECRET
    settings.STRIPE_PUBLISHABLE_KEY = 'pk_live_guardPublishable'
    settings.STRIPE_SIGNING_SECRET = SIGNING
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = 'we_guardEndpoint'
    settings.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_guardAccount01'
    settings.STRIPE_EXPECTED_LIVEMODE = 'true'
    settings.STRIPE_CHECKOUT_ENABLED = 'true'
    return settings


def _guard_events(caplog):
    found = []
    for record in caplog.records:
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if (
            isinstance(payload, dict)
            and payload.get('event') == LIVE_STRIPE_OUTSIDE_PROD_EVENT
        ):
            found.append((record.levelno, payload))
    return found


@pytest.mark.parametrize('namespace', ['stage', 'test', 'new-ui', ''])
def test_live_credentials_outside_prod_refuse_checkout(
    live_on, caplog, namespace,
):
    live_on.NAMESPACE = namespace
    caplog.set_level(logging.ERROR, logger=stripe_identity.__name__)

    assert stripe_checkout_enabled() is False

    [(level, payload)] = _guard_events(caplog)
    assert level == logging.ERROR
    assert payload['checkout'] == 'refused'
    assert payload['settings'] == [
        'STRIPE_EXPECTED_LIVEMODE',
        'STRIPE_PUBLISHABLE_KEY',
        'STRIPE_SECRET_KEY',
        'STRIPE_SIGNING_SECRET',
        'STRIPE_WEBHOOK_ENDPOINT_ID',
    ]
    # Names only: no credential value may reach a log line.
    assert LIVE_SECRET not in caplog.text
    assert SIGNING not in caplog.text
    assert 'pk_live_' not in caplog.text


def test_prod_keeps_its_live_credentials_and_its_switch(live_on, caplog):
    live_on.NAMESPACE = 'prod'
    caplog.set_level(logging.ERROR, logger=stripe_identity.__name__)

    assert live_stripe_credentials_outside_prod() == ()
    assert stripe_checkout_enabled() is True
    assert _guard_events(caplog) == []


def test_non_prod_test_mode_credentials_are_allowed(settings, caplog):
    """The owner's optional follow-up: stage on its OWN test-mode account."""
    settings.NAMESPACE = 'stage'
    settings.STRIPE_SECRET_KEY = 'sk_test_stageOwn'
    settings.STRIPE_PUBLISHABLE_KEY = 'pk_test_stageOwn'
    settings.STRIPE_SIGNING_SECRET = 'whsec_stageOwn'
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = 'we_stageOwn'
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_CHECKOUT_ENABLED = 'true'

    assert live_stripe_credentials_outside_prod() == ()
    assert stripe_checkout_enabled() is True


@pytest.mark.parametrize('name,value,expected', [
    ('STRIPE_SECRET_KEY', 'rk_live_restricted', 'STRIPE_SECRET_KEY'),
    ('STRIPE_SECRET_KEY', 'sk_live_full', 'STRIPE_SECRET_KEY'),
    ('STRIPE_PUBLISHABLE_KEY', 'pk_live_pub', 'STRIPE_PUBLISHABLE_KEY'),
    ('STRIPE_EXPECTED_LIVEMODE', 'true', 'STRIPE_EXPECTED_LIVEMODE'),
])
def test_each_live_signal_alone_is_enough(settings, name, value, expected):
    settings.NAMESPACE = 'stage'
    settings.STRIPE_SECRET_KEY = 'sk_test_x'
    settings.STRIPE_PUBLISHABLE_KEY = ''
    settings.STRIPE_SIGNING_SECRET = ''
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = ''
    settings.STRIPE_EXPECTED_LIVEMODE = 'false'
    settings.STRIPE_CHECKOUT_ENABLED = 'true'
    setattr(settings, name, value)

    assert expected in live_stripe_credentials_outside_prod()
    assert stripe_checkout_enabled() is False


def test_switch_off_stays_off_without_a_guard_log(live_on, caplog):
    """Off is off; the guard only speaks when it overrides an ON switch."""
    live_on.NAMESPACE = 'stage'
    live_on.STRIPE_CHECKOUT_ENABLED = 'false'
    caplog.set_level(logging.ERROR, logger=stripe_identity.__name__)

    assert stripe_checkout_enabled() is False
    assert _guard_events(caplog) == []


def test_malformed_switch_still_raises_outside_prod(live_on):
    live_on.NAMESPACE = 'stage'
    live_on.STRIPE_CHECKOUT_ENABLED = 'TRUE'
    with pytest.raises(stripe_identity.StripeIdentityConfigurationError):
        stripe_checkout_enabled()


@pytest.mark.django_db
def test_stage_view_answers_the_designed_refusal_and_never_calls_stripe(
    live_on, api_client, creator_factory, caplog,
):
    live_on.NAMESPACE = 'stage'
    live_on.ZUULI_NATIVE_CHECKOUT_ENABLED = False
    api_client.force_authenticate(user=creator_factory())
    caplog.set_level(logging.INFO)

    with patch('dj.apps.ztripe.views.webhook_is_ready', return_value=True), \
            patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as create:
        response = api_client.post(
            URL,
            {'quantity': 100, 'currentPath': '/wallet/fund',
             'returnMode': 'web'},
            format='json',
        )

    assert response.status_code == 503
    assert response.json()['code'] == 'checkout_not_activated'
    assert create.call_count == 0
    assert _guard_events(caplog)
    assert LIVE_SECRET not in caplog.text


@pytest.mark.django_db
def test_prod_view_still_reaches_stripe_with_live_credentials(
    live_on, api_client, creator_factory,
):
    """Positive control for the view test above: same settings, prod."""
    live_on.NAMESPACE = 'prod'
    live_on.ZUULI_NATIVE_CHECKOUT_ENABLED = False
    api_client.force_authenticate(user=creator_factory())

    with patch('dj.apps.ztripe.views.webhook_is_ready', return_value=True), \
            patch('dj.apps.ztripe.views.stripe.checkout.Session.create') as create:
        create.return_value.id = 'cs_live_guardPositiveControl'
        create.return_value.url = (
            'https://checkout.stripe.com/c/pay/cs_live_guardPositiveControl'
        )
        create.return_value.mode = 'payment'
        create.return_value.livemode = True
        create.return_value.account = None
        response = api_client.post(
            URL,
            {'quantity': 100, 'currentPath': '/wallet/fund',
             'returnMode': 'web'},
            format='json',
        )

    assert create.call_count == 1
    assert response.status_code == 200, response.content


def test_startup_reports_live_credentials_outside_prod_without_raising(
    live_on, caplog,
):
    live_on.NAMESPACE = 'stage'
    live_on.STRIPE_CHECKOUT_ENABLED = 'false'
    caplog.set_level(logging.ERROR, logger=stripe_identity.__name__)

    ZtripeConfig._report_live_credentials_outside_prod()

    [(level, payload)] = _guard_events(caplog)
    assert level == logging.ERROR
    assert payload['where'] == 'startup'
    assert payload['namespace'] == 'stage'
    assert LIVE_SECRET not in caplog.text


def test_startup_is_silent_in_prod_and_on_a_clean_stage(settings, caplog):
    caplog.set_level(logging.ERROR, logger=stripe_identity.__name__)
    settings.NAMESPACE = 'prod'
    settings.STRIPE_SECRET_KEY = LIVE_SECRET
    ZtripeConfig._report_live_credentials_outside_prod()

    settings.NAMESPACE = 'stage'
    settings.STRIPE_SECRET_KEY = ''
    settings.STRIPE_PUBLISHABLE_KEY = ''
    settings.STRIPE_EXPECTED_LIVEMODE = ''
    ZtripeConfig._report_live_credentials_outside_prod()

    assert _guard_events(caplog) == []
