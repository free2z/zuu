"""Contract tests for the HTTPS-to-ZUULI Stripe return bridge."""

import os
import re
import secrets
import signal
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from unittest.mock import patch
from urllib.parse import unquote

import pytest
from django.core import signing
from django.core.cache import cache, caches
from django.test import override_settings
from rest_framework.throttling import SimpleRateThrottle

from dj.apps.ztripe.fulfillment import checkout_metadata
from dj.apps.ztripe.models import CheckoutIntent, StripeTransaction
from dj.apps.ztripe.native_return import (
    APP_RETURN_URI,
    APP_CLAIM_MAX_AGE_SECONDS,
    NATIVE_RETURN_REDIS_DEADLINE_SECONDS,
    NativeReturnRedisDeadlineExceeded,
    NativeReturnUnavailable,
    NativeReturnUserMismatch,
    NativeReturnStripeDeadlineExceeded,
    _admission_key,
    _provider_slots_key,
    admit_native_return,
    bridge_token_digest,
    ensure_native_return_admission_ready,
    ensure_native_return_endpoint_ready,
    make_app_claim_token,
    make_bridge_token,
    native_return_local_admission_slot,
    native_return_stripe_deadline,
    native_return_redis_deadline,
    read_app_claim,
    record_status_resolution,
    release_native_return_provider_slot,
)


@pytest.fixture(autouse=True)
def enable_native_return_and_clear_cache(settings):
    settings.ZUULI_NATIVE_CHECKOUT_ENABLED = True
    settings.CANONICAL_ORIGIN = "http://testserver"
    settings.ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = "http://testserver"
    cache.clear()
    yield
    cache.clear()


def _authenticate(api_client, creator_factory):
    user = creator_factory()
    api_client.force_authenticate(user=user)
    return user


@pytest.fixture
def activated_stripe_checkout(settings):
    """Satisfy 's exact-fulfillment activation gate.

    ``create_checkout_session`` proves a server-owned Stripe identity through
    ``_prove_checkout_identity`` immediately before it opens a
    ``CheckoutIntent``. That gate runs *after* every native-return gate, so the
    fail-closed tests in this module never reach it and deliberately do not use
    this fixture. Only a test that must get all the way to
    ``Session.create`` needs it.

    The real ``configured_stripe_identity`` still runs -- the settings below are
    a consistent test-mode identity, not a bypass. Only ``webhook_is_ready`` is
    patched, because it asserts a *recent account-bound provider delivery* that
    no unit test can produce.
    """
    settings.STRIPE_CHECKOUT_ENABLED = "true"
    settings.STRIPE_EXPECTED_ACCOUNT_ID = "acct_nativeReturn01"
    settings.STRIPE_EXPECTED_LIVEMODE = "false"
    settings.STRIPE_SECRET_KEY = "sk_test_nativeReturn"
    with patch("dj.apps.ztripe.views.webhook_is_ready", return_value=True):
        yield


@pytest.mark.django_db
def test_mobile_mode_uses_only_canonical_https_return_and_mobile_context(
    api_client, creator_factory, settings, mocker, activated_stripe_checkout
):
    user = _authenticate(api_client, creator_factory)
    mocker.patch("dj.apps.ztripe.views.time.time", return_value=2_000_000_000)
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash"
    settings.ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = (
        "https://checkout-return.stage.free2z.cash"
    )
    settings.CSRF_TRUSTED_ORIGINS = ["https://free2z.cash"]
    readiness = mocker.patch(
        "dj.apps.ztripe.views.ensure_native_return_endpoint_ready"
    )
    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        create.return_value.id = "cs_test_12345678"
        create.return_value.url = "https://checkout.stripe.com/c/pay/cs_test_12345678"
        #  re-checks the identity of the Session Stripe actually returned
        # before the intent is opened; a mock missing these is rejected as a
        # provider-identity mismatch (502), not accepted.
        create.return_value.mode = "payment"
        create.return_value.livemode = False
        create.return_value.account = None
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {
                "quantity": 100,
                "returnMode": "zuuli_mobile",
                # Native mode must ignore, not append or reinterpret, this field.
                "currentPath": "https://evil.example/#steal",
            },
            format="json",
            HTTP_ORIGIN="https://free2z.cash",
        )

    assert response.status_code == 200, response.content
    readiness.assert_called_once()
    args = create.call_args.kwargs
    assert args["origin_context"] == "mobile_app"
    assert args["expires_at"] == 2_000_000_000 + (23 * 60 * 60)
    assert args["client_reference_id"] == str(user.id)
    assert args["success_url"].startswith(
        "https://checkout-return.stage.free2z.cash/api/stripe/native-return/"
        "success/?state="
    )
    assert args["success_url"].endswith(
        "&session_id={CHECKOUT_SESSION_ID}"
    )
    assert args["cancel_url"].startswith(
        "https://checkout-return.stage.free2z.cash/api/stripe/native-return/"
        "cancel/?state="
    )
    assert "evil.example" not in args["success_url"] + args["cancel_url"]
    assert "cash.free2z.zuuli" not in args["success_url"] + args["cancel_url"]
    state = args["success_url"].split("state=", 1)[1].split("&", 1)[0]
    #  stamps the server-owned fulfillment contract (the CheckoutIntent
    # the webhook settles against) into this same metadata dict. Native mode
    # adds the Session<->return binding on top of it, it does not replace it.
    # Assert the exact union so neither contract can be silently dropped by a
    # future merge.
    intent = CheckoutIntent.objects.get(user=user)
    assert args["metadata"] == {
        **checkout_metadata(intent),
        "native_return_state_sha256": bridge_token_digest(unquote(state)),
    }
    assert args["metadata"]["checkout_intent_id"] == str(intent.public_id)
    assert args["metadata"]["user_id"] == str(user.id)
    # The binding must live only in metadata; it must never leak into a URL.
    assert bridge_token_digest(unquote(state)) not in (
        args["success_url"] + args["cancel_url"]
    )


@pytest.mark.django_db
@pytest.mark.parametrize("return_mode", ["native", "zuuli", "ZUULI_MOBILE", 1, None])
def test_checkout_rejects_unknown_return_mode_before_stripe(
    api_client, creator_factory, return_mode
):
    _authenticate(api_client, creator_factory)
    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "returnMode": return_mode},
            format="json",
        )
    assert response.status_code == 400
    create.assert_not_called()


@pytest.mark.django_db
def test_mobile_checkout_issuance_fails_closed_until_protected_ingress_is_enabled(
    api_client, creator_factory, settings
):
    _authenticate(api_client, creator_factory)
    settings.ZUULI_NATIVE_CHECKOUT_ENABLED = False
    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "returnMode": "zuuli_mobile"},
            format="json",
        )
    assert response.status_code == 503
    create.assert_not_called()


@pytest.mark.django_db
def test_mobile_checkout_does_not_charge_when_admission_store_is_unavailable(
    api_client, creator_factory
):
    _authenticate(api_client, creator_factory)
    with patch(
        "dj.apps.ztripe.views.ensure_native_return_admission_ready",
        side_effect=NativeReturnUnavailable("redis unavailable"),
    ) as readiness, patch(
        "dj.apps.ztripe.views.stripe.checkout.Session.create"
    ) as create:
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "returnMode": "zuuli_mobile"},
            format="json",
        )

    assert response.status_code == 503
    assert "temporarily unavailable" in response.json()["error"]
    readiness.assert_called_once_with()
    create.assert_not_called()


@pytest.mark.django_db
def test_mobile_checkout_does_not_charge_when_live_return_boundary_is_unready(
    api_client, creator_factory
):
    _authenticate(api_client, creator_factory)
    with patch(
        "dj.apps.ztripe.views.ensure_native_return_endpoint_ready",
        side_effect=NativeReturnUnavailable("TLS boundary unavailable"),
    ) as readiness, patch(
        "dj.apps.ztripe.views.ensure_native_return_admission_ready"
    ) as redis_readiness, patch(
        "dj.apps.ztripe.views.stripe.checkout.Session.create"
    ) as create:
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "returnMode": "zuuli_mobile"},
            format="json",
        )

    assert response.status_code == 503
    assert "temporarily unavailable" in response.json()["error"]
    readiness.assert_called_once()
    redis_readiness.assert_not_called()
    create.assert_not_called()


def test_live_return_boundary_probe_requires_tls_isolated_private_404(mocker):
    response = mocker.Mock(status=404)
    response.read.return_value = b"private"
    response.getheader.side_effect = lambda name: {
        "X-Free2Z-Callback-Backend": "isolated",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
    }.get(name)
    connection = mocker.Mock()
    connection.getresponse.return_value = response
    constructor = mocker.patch(
        "dj.apps.ztripe.native_return.http.client.HTTPSConnection",
        return_value=connection,
    )
    parts = type("Origin", (), {"hostname": "checkout-return.stage.free2z.cash"})()

    ensure_native_return_endpoint_ready(parts)

    constructor.assert_called_once()
    connection.request.assert_called_once_with(
        "GET",
        "/.well-known/free2z-native-return-readiness",
        headers={"Accept": "text/html"},
    )
    connection.close.assert_called_once()


@pytest.mark.parametrize(
    ("status", "isolated", "cache_control", "referrer"),
    [
        (200, "isolated", "no-store", "no-referrer"),
        (404, None, "no-store", "no-referrer"),
        (404, "isolated", "public", "no-referrer"),
        (404, "isolated", "no-store", "origin"),
    ],
)
def test_live_return_boundary_probe_fails_closed_on_wrong_edge_contract(
    mocker, status, isolated, cache_control, referrer
):
    response = mocker.Mock(status=status)
    response.read.return_value = b"private"
    response.getheader.side_effect = lambda name: {
        "X-Free2Z-Callback-Backend": isolated,
        "Cache-Control": cache_control,
        "Referrer-Policy": referrer,
    }.get(name)
    connection = mocker.Mock()
    connection.getresponse.return_value = response
    mocker.patch(
        "dj.apps.ztripe.native_return.http.client.HTTPSConnection",
        return_value=connection,
    )
    parts = type("Origin", (), {"hostname": "checkout-return.stage.free2z.cash"})()

    with pytest.raises(NativeReturnUnavailable):
        ensure_native_return_endpoint_ready(parts)


@pytest.mark.django_db
def test_mobile_checkout_does_not_charge_with_nonisolated_return_origin(
    api_client, creator_factory, settings
):
    _authenticate(api_client, creator_factory)
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash"
    settings.ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = "https://stage.free2z.cash"
    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 100, "returnMode": "zuuli_mobile"},
            format="json",
        )

    assert response.status_code == 503
    create.assert_not_called()


def _success_url(user_id, session_id="cs_test_12345678"):
    state = make_bridge_token(user_id, "success")
    return (
        "/api/stripe/native-return/success/"
        f"?state={state}&session_id={session_id}"
    ), state


def _stripe_session(user_id, state, **extra):
    return {
        "id": "cs_test_12345678",
        "status": "complete",
        "payment_status": "paid",
        "client_reference_id": str(user_id),
        "metadata": {"native_return_state_sha256": bridge_token_digest(state)},
        "payment_intent": "pi_12345678",
        **extra,
    }


def _legacy_bridge_token(user_id, purpose):
    return signing.dumps(
        {
            "v": 1,
            "uid": user_id,
            "purpose": purpose,
            "nonce": "a" * 32,
        },
        salt="free2z.stripe.native-return.bridge.v1",
        compress=False,
    )


@pytest.mark.django_db
def test_v2_return_requires_dedicated_https_host(
    api_client, creator_factory, settings
):
    user = creator_factory()
    url, state = _success_url(user.id)
    settings.ALLOWED_HOSTS = [
        "stage.free2z.cash",
        "checkout-return.stage.free2z.cash",
    ]
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash"
    settings.ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = (
        "https://checkout-return.stage.free2z.cash"
    )
    settings.USE_X_FORWARDED_HOST = True
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    ) as retrieve:
        wrong_host = api_client.get(
            url,
            HTTP_HOST="stage.free2z.cash",
            HTTP_X_FORWARDED_HOST="checkout-return.stage.free2z.cash",
            HTTP_X_FORWARDED_PROTO="https",
        )
        wrong_scheme = api_client.get(
            url,
            HTTP_HOST="checkout-return.stage.free2z.cash",
            HTTP_X_FORWARDED_PROTO="http",
        )
        right_host = api_client.get(
            url,
            HTTP_HOST="checkout-return.stage.free2z.cash",
            HTTP_X_FORWARDED_HOST="stage.free2z.cash",
            HTTP_X_FORWARDED_PROTO="https",
        )

    assert wrong_host.status_code == 404
    assert wrong_scheme.status_code == 404
    assert right_host.status_code == 200
    assert retrieve.call_count == 1


def test_callback_host_is_private_404_for_every_nonreturn_path(
    api_client, settings
):
    settings.ALLOWED_HOSTS = ["checkout-return.stage.free2z.cash"]
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash"
    settings.ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = (
        "https://checkout-return.stage.free2z.cash"
    )

    response = api_client.get(
        "/api/healthz",
        secure=True,
        HTTP_HOST="checkout-return.stage.free2z.cash",
    )

    assert response.status_code == 404
    assert response["Cache-Control"] == "no-store"
    assert response["Referrer-Policy"] == "no-referrer"
    assert response["X-Robots-Tag"] == "noindex, nofollow"


@pytest.mark.parametrize(
    "configured_origin",
    [
        "https://checkout-returns.stage.free2z.cash",
        "https://[",
    ],
)
def test_callback_host_fails_closed_when_return_origin_is_misconfigured(
    api_client, settings, configured_origin
):
    settings.ALLOWED_HOSTS = [
        "stage.free2z.cash",
        "checkout-return.stage.free2z.cash",
    ]
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash"
    settings.ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = configured_origin

    callback = api_client.get(
        "/api/healthz",
        HTTP_HOST="checkout-return.stage.free2z.cash",
        HTTP_X_FORWARDED_PROTO="https",
    )
    canonical = api_client.get(
        "/api/healthz",
        HTTP_HOST="stage.free2z.cash",
        HTTP_X_FORWARDED_PROTO="https",
    )

    assert callback.status_code == 404
    assert callback["Cache-Control"] == "no-store"
    assert canonical.status_code == 200


@pytest.mark.django_db
def test_v1_return_drains_only_on_byte_exact_legacy_origin(
    api_client, creator_factory, settings
):
    user = creator_factory()
    state = _legacy_bridge_token(user.id, "success")
    url = (
        "/api/stripe/native-return/success/"
        f"?state={state}&session_id=cs_test_12345678"
    )
    settings.ALLOWED_HOSTS = [
        "stage.free2z.cash",
        "checkout-return.stage.free2z.cash",
    ]
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash"
    settings.ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = (
        "https://checkout-return.stage.free2z.cash"
    )
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    ) as retrieve:
        encoded = api_client.get(
            url,
            secure=True,
            HTTP_HOST="stage.free2z.cash",
            RAW_URI=url.replace("success", "%73uccess", 1),
        )
        wrong_new_host = api_client.get(
            url,
            secure=True,
            HTTP_HOST="checkout-return.stage.free2z.cash",
        )
        exact = api_client.get(
            url,
            secure=True,
            HTTP_HOST="stage.free2z.cash",
            RAW_URI=url,
        )

    assert encoded.status_code == 404
    assert wrong_new_host.status_code == 404
    assert exact.status_code == 200
    assert retrieve.call_count == 1


@pytest.mark.django_db
def test_disabling_issuance_does_not_strand_existing_success_or_cancel(
    api_client, creator_factory, settings
):
    user = creator_factory()
    success_url, state = _success_url(user.id)
    cancel_state = make_bridge_token(user.id, "cancel")
    settings.ZUULI_NATIVE_CHECKOUT_ENABLED = False
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    ):
        success = api_client.get(success_url)
    cancel = api_client.get(
        f"/api/stripe/native-return/cancel/?state={cancel_state}"
    )

    assert success.status_code == 200
    assert cancel.status_code == 200


def _extract_claim(response):
    match = re.search(
        rf'{re.escape(APP_RETURN_URI)}\?code=([^"<]+)',
        response.content.decode(),
    )
    assert match, response.content
    return unquote(match.group(1))


def _assert_correlated_processing_claim(api_client, claimed):
    assert claimed.status_code == 200
    payload = claimed.json()
    assert set(payload) == {"outcome", "status", "status_token"}
    assert payload["outcome"] == "processing"
    assert payload["status"] == "processing"
    assert isinstance(payload["status_token"], str)
    status = api_client.post(
        "/api/stripe/native-return/status/",
        {"status_token": payload["status_token"]},
        format="json",
    )
    assert status.status_code == 200
    assert status.json() == {"status": "processing"}
    return payload


def test_app_claim_is_signed_user_bound_and_tamper_evident():
    state = make_bridge_token(1, "cancel")
    code = make_app_claim_token(
        state, {"v": 1, "uid": 1, "outcome": "cancel"}
    )
    with pytest.raises(NativeReturnUserMismatch):
        read_app_claim(code, 2)
    assert read_app_claim(code + "x", 1) is None
    assert read_app_claim(code, 1)["outcome"] == "cancel"


def test_native_return_stripe_lookup_has_a_five_second_zero_retry_ceiling():
    from dj.apps.ztripe import views

    requestor = views._native_return_stripe._requestor
    assert requestor._client._timeout == 5
    assert requestor._options.max_network_retries == 0


def test_native_return_stripe_lookup_has_a_real_wall_clock_deadline():
    previous_handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()
    with pytest.raises(NativeReturnStripeDeadlineExceeded):
        with native_return_stripe_deadline(0.02):
            time.sleep(0.5)
    assert time.monotonic() - started < 0.25
    assert signal.getsignal(signal.SIGALRM) == previous_handler
    assert signal.getitimer(signal.ITIMER_REAL)[0] == 0


def test_native_return_stripe_lookup_fails_closed_off_the_main_thread():
    def invoke():
        with pytest.raises(NativeReturnUnavailable):
            with native_return_stripe_deadline(0.02):
                pass

    with ThreadPoolExecutor(max_workers=1) as executor:
        executor.submit(invoke).result()


def test_native_return_redis_deadline_is_two_seconds_and_restores_alarm():
    assert NATIVE_RETURN_REDIS_DEADLINE_SECONDS == 2
    previous_handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()
    with pytest.raises(NativeReturnRedisDeadlineExceeded):
        with native_return_redis_deadline(0.02):
            time.sleep(0.5)
    assert time.monotonic() - started < 0.25
    assert signal.getsignal(signal.SIGALRM) == previous_handler
    assert signal.getitimer(signal.ITIMER_REAL)[0] == 0


def test_every_shared_redis_operation_uses_the_hard_deadline(mocker):
    # Exercise the production branch while retaining pytest's isolated LocMem
    # backend: replacing the class used by the isinstance check makes the code
    # treat the already-created backend as shared, and the raw client is mocked.
    mocker.patch(
        "dj.apps.ztripe.native_return.LocMemCache",
        new=type("NotTheConfiguredCache", (), {}),
    )
    client = mocker.patch(
        "dj.apps.ztripe.native_return._shared_redis_client"
    ).return_value
    delay = lambda *args, **kwargs: time.sleep(0.5)
    mocker.patch(
        "dj.apps.ztripe.native_return.NATIVE_RETURN_REDIS_DEADLINE_SECONDS",
        0.02,
    )

    client.ping.side_effect = delay
    started = time.monotonic()
    with pytest.raises(NativeReturnRedisDeadlineExceeded):
        ensure_native_return_admission_ready()
    assert time.monotonic() - started < 0.25

    client.eval.side_effect = delay
    started = time.monotonic()
    with pytest.raises(NativeReturnRedisDeadlineExceeded):
        admit_native_return("signed-user-1", window_seconds=60, limit=6)
    assert time.monotonic() - started < 0.25

    client.zrem.side_effect = delay
    started = time.monotonic()
    assert not release_native_return_provider_slot("valid_lease_token_1234")
    assert time.monotonic() - started < 0.25
    assert signal.getitimer(signal.ITIMER_REAL)[0] == 0


@pytest.mark.django_db
def test_success_replay_is_owner_throttled_across_auth_and_spoofed_ips(
    api_client, creator_factory, settings, mocker
):
    user = creator_factory()
    url, state = _success_url(user.id)
    retrieve = mocker.patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    )
    rates = {
        **SimpleRateThrottle.THROTTLE_RATES,
        "anon-checkout-return": "2/minute",
    }
    mocker.patch.object(SimpleRateThrottle, "THROTTLE_RATES", rates)
    settings.NATIVE_RETURN_PROVIDER_SLOTS = 1

    first = api_client.get(url, HTTP_X_FORWARDED_FOR="198.51.100.1")
    api_client.force_authenticate(user=user)
    second = api_client.get(url, HTTP_X_FORWARDED_FOR="198.51.100.2")
    api_client.force_authenticate(user=None)
    third = api_client.get(url, HTTP_X_FORWARDED_FOR="198.51.100.3")

    assert [first.status_code, second.status_code, third.status_code] == [
        200, 200, 429,
    ]
    assert retrieve.call_count == 2
    assert cache.get(_provider_slots_key()) is None
    body = third.content.decode()
    assert "Return to ZUULI" in body
    assert "Do not start another purchase" in body
    assert '<a href="">Retry verification</a>' in body
    assert body.count('<meta http-equiv="refresh"') == 1
    assert '<meta http-equiv="refresh" content="0;url=cash.free2z.zuuli:' in body
    assert third["Retry-After"]
    assert third["Cache-Control"].startswith("no-store")
    assert third["Referrer-Policy"] == "no-referrer"
    assert state not in body
    assert "cs_test_12345678" not in body
    assert APP_RETURN_URI in body


@pytest.mark.django_db
def test_authenticated_user_ceiling_cannot_preempt_paid_return_handoff(
    api_client, creator_factory, mocker
):
    user = _authenticate(api_client, creator_factory)
    url, state = _success_url(user.id)
    mocker.patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    )
    with patch(
        "dj.free2z.throttling.AuthenticatedUserRateThrottle.allow_request",
        return_value=False,
    ) as user_throttle:
        response = api_client.get(url)

    assert response.status_code == 200
    assert APP_RETURN_URI in response.content.decode()
    user_throttle.assert_not_called()
    assert cache.get(_provider_slots_key()) is None


@pytest.mark.django_db
def test_admission_outage_returns_a_non_authoritative_processing_handoff(
    api_client, creator_factory
):
    user = creator_factory()
    url, _state = _success_url(user.id)
    with patch(
        "dj.apps.ztripe.native_return.admit_native_return",
        side_effect=NativeReturnUnavailable("redis unavailable"),
    ) as admit, patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session"
    ) as retrieve:
        response = api_client.get(url)

    assert response.status_code == 503
    assert response["Retry-After"] == "2"
    assert APP_RETURN_URI in response.content.decode()
    assert "Do not start another purchase" in response.content.decode()
    admit.assert_called_once()
    retrieve.assert_not_called()

    api_client.force_authenticate(user=user)
    claimed = api_client.post(
        "/api/stripe/native-return/claim/",
        {"code": _extract_claim(response)},
        format="json",
    )
    _assert_correlated_processing_claim(api_client, claimed)


@pytest.mark.django_db
def test_stripe_outage_returns_a_non_authoritative_processing_handoff(
    api_client, creator_factory
):
    user = creator_factory()
    url, _state = _success_url(user.id)
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        side_effect=NativeReturnUnavailable("stripe unavailable"),
    ) as retrieve:
        response = api_client.get(url)

    assert response.status_code == 503
    assert response["Retry-After"] == "5"
    assert APP_RETURN_URI in response.content.decode()
    assert "Do not start another purchase" in response.content.decode()
    assert cache.get(_provider_slots_key()) is None
    retrieve.assert_called_once()

    api_client.force_authenticate(user=user)
    claimed = api_client.post(
        "/api/stripe/native-return/claim/",
        {"code": _extract_claim(response)},
        format="json",
    )
    _assert_correlated_processing_claim(api_client, claimed)


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("status", "payment_status"),
    [
        ("open", "unpaid"),
        ("complete", "unpaid"),
        ("expired", "unpaid"),
    ],
)
def test_incomplete_or_unpaid_session_never_mints_success(
    api_client, creator_factory, status, payment_status
):
    user = creator_factory()
    url, state = _success_url(user.id)
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(
            user.id,
            state,
            status=status,
            payment_status=payment_status,
        ),
    ):
        response = api_client.get(url)

    assert response.status_code == 200
    assert "Payment submitted" not in response.content.decode()
    assert "Do not start another purchase" in response.content.decode()
    api_client.force_authenticate(user=user)
    claimed = api_client.post(
        "/api/stripe/native-return/claim/",
        {"code": _extract_claim(response)},
        format="json",
    )
    _assert_correlated_processing_claim(api_client, claimed)


@pytest.mark.django_db
def test_provider_saturation_preserves_a_private_bounded_mobile_handoff(
    api_client, creator_factory, settings, mocker
):
    active_user = creator_factory()
    waiting_user = creator_factory()
    waiting_url, waiting_state = _success_url(waiting_user.id)
    settings.NATIVE_RETURN_PROVIDER_SLOTS = 1
    admitted, _, active_lease = admit_native_return(
        f"signed-user-{active_user.id}",
        window_seconds=60,
        limit=6,
        reserve_provider_slot=True,
        provider_slots=1,
        provider_lease_seconds=8,
    )
    assert admitted and active_lease
    retrieve = mocker.patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
    )

    try:
        saturated = api_client.get(waiting_url)
    finally:
        release_native_return_provider_slot(active_lease)

    assert saturated.status_code == 429
    retrieve.assert_not_called()
    body = saturated.content.decode()
    assert "Finishing checkout" in body
    assert "Return to ZUULI" in body
    assert "Do not start another purchase" in body
    assert '<a href="">Retry verification</a>' in body
    assert body.count('<meta http-equiv="refresh"') == 1
    assert '<meta http-equiv="refresh" content="0;url=cash.free2z.zuuli:' in body
    assert saturated["Retry-After"]
    assert saturated["Cache-Control"].startswith("no-store")
    assert saturated["Content-Security-Policy"].startswith("default-src 'none'")
    assert saturated["Referrer-Policy"] == "no-referrer"
    assert waiting_state not in body
    assert "cs_test_12345678" not in body
    assert APP_RETURN_URI in body

    code = _extract_claim(saturated)
    api_client.force_authenticate(user=active_user)
    cross_user = api_client.post(
        "/api/stripe/native-return/claim/", {"code": code}, format="json"
    )
    assert cross_user.status_code == 403

    api_client.force_authenticate(user=waiting_user)
    claimed = api_client.post(
        "/api/stripe/native-return/claim/", {"code": code}, format="json"
    )
    _assert_correlated_processing_claim(api_client, claimed)
    assert "credited" not in claimed.content.decode()
    repeated = api_client.post(
        "/api/stripe/native-return/claim/", {"code": code}, format="json"
    )
    _assert_correlated_processing_claim(api_client, repeated)

    with patch(
        "django.core.signing.time.time",
        return_value=time.time() + APP_CLAIM_MAX_AGE_SECONDS + 1,
    ):
        expired = api_client.post(
            "/api/stripe/native-return/claim/", {"code": code}, format="json"
        )
    assert expired.status_code == 410


def test_native_return_admission_keys_are_hashed_and_environment_scoped(settings):
    huge_namespace = "stage-secret-" + ("x" * 10_000)
    settings.NATIVE_RETURN_ADMISSION_NAMESPACE = huge_namespace
    stage_owner = _admission_key("signed-user-1")
    stage_provider = _provider_slots_key()

    settings.NATIVE_RETURN_ADMISSION_NAMESPACE = "production"
    production_owner = _admission_key("signed-user-1")
    production_provider = _provider_slots_key()

    assert huge_namespace not in stage_owner + stage_provider
    assert len(stage_owner) < 180
    assert len(stage_provider) < 180
    assert len(stage_owner) == len(production_owner)
    assert len(stage_provider) == len(production_provider)
    assert stage_owner != production_owner
    assert stage_provider != production_provider


def test_native_return_provider_capacity_isolated_and_rejections_charge_owner(
    settings,
):
    settings.NATIVE_RETURN_ADMISSION_NAMESPACE = "stage"
    allowed, _, stage_lease = admit_native_return(
        "stage-owner",
        window_seconds=60,
        limit=2,
        reserve_provider_slot=True,
        provider_slots=1,
        provider_lease_seconds=8,
    )
    assert allowed and stage_lease

    # Provider-full rejections still consume the caller's owner budget.
    for _ in range(2):
        rejected, _, rejected_lease = admit_native_return(
            "waiting-owner",
            window_seconds=60,
            limit=2,
            reserve_provider_slot=True,
            provider_slots=1,
            provider_lease_seconds=8,
        )
        assert not rejected
        assert rejected_lease is None
    assert cache.get(_admission_key("waiting-owner")) == 2

    # A deployment sharing this Redis database has independent capacity.
    settings.NATIVE_RETURN_ADMISSION_NAMESPACE = "production"
    production_allowed, _, production_lease = admit_native_return(
        "production-owner",
        window_seconds=60,
        limit=2,
        reserve_provider_slot=True,
        provider_slots=1,
        provider_lease_seconds=8,
    )
    assert production_allowed and production_lease
    assert release_native_return_provider_slot(production_lease)

    settings.NATIVE_RETURN_ADMISSION_NAMESPACE = "stage"
    assert release_native_return_provider_slot(stage_lease)
    next_allowed, _, next_lease = admit_native_return(
        "next-stage-owner",
        window_seconds=60,
        limit=2,
        reserve_provider_slot=True,
        provider_slots=1,
        provider_lease_seconds=8,
    )
    assert next_allowed and next_lease
    assert release_native_return_provider_slot(next_lease)


def test_provider_release_is_token_owned_and_ttl_remains_the_fallback(settings):
    settings.NATIVE_RETURN_ADMISSION_NAMESPACE = "lease-ownership"
    allowed, _, lease = admit_native_return(
        "active-owner",
        window_seconds=60,
        limit=6,
        reserve_provider_slot=True,
        provider_slots=1,
        provider_lease_seconds=8,
    )
    assert allowed and lease
    assert not release_native_return_provider_slot("wrong_lease_token_1234")

    blocked, _, blocked_lease = admit_native_return(
        "waiting-owner",
        window_seconds=60,
        limit=6,
        reserve_provider_slot=True,
        provider_slots=1,
        provider_lease_seconds=8,
    )
    assert not blocked
    assert blocked_lease is None

    assert release_native_return_provider_slot(lease)
    resumed, _, resumed_lease = admit_native_return(
        "resumed-owner",
        window_seconds=60,
        limit=6,
        reserve_provider_slot=True,
        provider_slots=1,
        provider_lease_seconds=8,
    )
    assert resumed and resumed_lease
    assert release_native_return_provider_slot(resumed_lease)


# A per-process key prefix: this block cleans up with a prefix-scoped delete
# instead of FLUSHDB, so two processes pointed at one Redis (two local agents,
# a future xdist) can neither see nor erase each other's admission counters.
_PRODUCTION_REDIS_KEY_PREFIX = f"native-return-ci-{os.getpid()}-{secrets.token_hex(4)}"
_production_redis_only = pytest.mark.skipif(
    not os.environ.get("REDIS_HOST"),
    reason="REDIS_HOST is required for the production Redis contract",
)
_production_redis_cache = override_settings(
    DEBUG=False,
    CACHES={
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": (
                f"redis://{os.environ.get('REDIS_HOST', '127.0.0.1')}:"
                f"{os.environ.get('REDIS_PORT', '6379')}/1"
            ),
            "KEY_PREFIX": _PRODUCTION_REDIS_KEY_PREFIX,
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
                "IGNORE_EXCEPTIONS": False,
            },
        }
    },
)


def _own_redis_keys(client) -> list[bytes]:
    return list(client.scan_iter(match=f"{_PRODUCTION_REDIS_KEY_PREFIX}:*"))


def _clear_own_redis_keys(redis_cache) -> None:
    redis_cache.delete_pattern("*")


def _window_that_cannot_roll_over(client) -> int:
    """A fixed window whose boundary is ~11.6 days from Redis's own clock.

    The admission script's window ends at ``now - now % W + W`` (Redis TIME).
    Choosing ``W = now + 10**6`` makes ``now % W == now``, so the window ends
    exactly 10**6 seconds from now, whatever the wall clock says. A 60-second
    window instead rolls over at every:00, and a test that straddles it
    legitimately admits ``limit`` in each window -- 12 of 20 with a limit of 6,
    which is what failed CI on  at 08:27:00Z.
    """
    return int(client.time()[0]) + 10**6


@_production_redis_only
@_production_redis_cache
def test_production_redis_admission_is_atomic_under_concurrency(mocker):
    # Production intentionally uses sync Gunicorn workers so SIGALRM can bound
    # dependency calls. This test uses threads only to prove the Lua operation
    # is atomic; the separate deadline tests prove the sync-worker guard.
    mocker.patch(
        "dj.apps.ztripe.native_return.native_return_redis_deadline",
        side_effect=lambda: nullcontext(),
    )
    redis_cache = caches["default"]
    client = redis_cache.client.get_client(write=True)
    _clear_own_redis_keys(redis_cache)
    try:
        ensure_native_return_admission_ready()
        window = _window_that_cannot_roll_over(client)
        # Many independent owners, each hammered by 20 concurrent callers. The
        # window cannot end mid-test, so any count other than exactly the
        # limit is a real atomicity failure, never a clock boundary.
        for round_index in range(25):
            with ThreadPoolExecutor(max_workers=20) as executor:
                results = list(executor.map(
                    lambda _: admit_native_return(
                        f"signed-user-hammer-{round_index}",
                        window_seconds=window,
                        limit=6,
                    )[0],
                    range(20),
                ))
            assert results.count(True) == 6, round_index
            assert results.count(False) == 14, round_index
        assert int(client.time()[0]) < window
        # The counters really live under this process's prefix, so the
        # prefix-scoped cleanup below is what isolates it, not luck.
        assert len(_own_redis_keys(client)) == 25

        _clear_own_redis_keys(redis_cache)
        assert _own_redis_keys(client) == []
        with ThreadPoolExecutor(max_workers=20) as executor:
            results = list(executor.map(
                lambda index: admit_native_return(
                    f"signed-user-{index}",
                    window_seconds=window,
                    limit=6,
                    reserve_provider_slot=True,
                    provider_slots=2,
                    provider_lease_seconds=8,
                ),
                range(20),
            ))
        assert [result[0] for result in results].count(True) == 2
        assert [result[0] for result in results].count(False) == 18
        leases = [result[2] for result in results if result[2] is not None]
        assert len(leases) == 2
        assert all(release_native_return_provider_slot(lease) for lease in leases)
        resumed, _, resumed_lease = admit_native_return(
            "signed-user-resumed",
            window_seconds=window,
            limit=6,
            reserve_provider_slot=True,
            provider_slots=2,
            provider_lease_seconds=8,
        )
        assert resumed and resumed_lease
        assert release_native_return_provider_slot(resumed_lease)

        with override_settings(
            NATIVE_RETURN_ADMISSION_NAMESPACE="native-return-ci-other"
        ):
            isolated, _, isolated_lease = admit_native_return(
                "signed-user-other-environment",
                window_seconds=window,
                limit=6,
                reserve_provider_slot=True,
                provider_slots=2,
                provider_lease_seconds=8,
            )
        assert isolated and isolated_lease
        with override_settings(
            NATIVE_RETURN_ADMISSION_NAMESPACE="native-return-ci-other"
        ):
            assert release_native_return_provider_slot(isolated_lease)
    finally:
        _clear_own_redis_keys(redis_cache)


def _wait_for_own_redis_counter_expiry(client, key, window_end, *, timeout=5):
    deadline = time.monotonic() + timeout
    # Redis may retain a key with PTTL=0 during the boundary millisecond even
    # after TIME's seconds field has advanced. Observe actual expiry without
    # consuming admissions or deleting the counter we are testing.
    while int(client.time()[0]) < window_end or client.exists(key):
        assert time.monotonic() < deadline, "owned admission counter did not expire"
        time.sleep(0.01)


@_production_redis_only
@_production_redis_cache
def test_production_redis_rollover_wait_rejects_a_counter_without_expiry():
    redis_cache = caches["default"]
    client = redis_cache.client.get_client(write=True)
    key = redis_cache.make_key(_admission_key("rollover-no-expiry-control"))
    client.set(key, 6)
    try:
        with pytest.raises(AssertionError, match="owned admission counter did not expire"):
            _wait_for_own_redis_counter_expiry(
                client, key, int(client.time()[0]), timeout=0.05,
            )
        assert client.get(key) == b"6", "the fixture must not reset a broken limiter"
        assert client.pttl(key) == -1
    finally:
        client.delete(key)


@_production_redis_only
@_production_redis_cache
def test_production_redis_admission_window_rollover_is_a_new_window(mocker):
    """Pin the fixed-window semantics that 's 12-of-20 came from.

    A per-owner limit of N admits N in each fixed window, so a burst that
    straddles a boundary admits up to 2N. That is the documented rate-limit
    shape, not an atomicity failure; the concurrent Stripe lookup budget is
    the provider-slot lease set, which has no window and cannot roll over.
    """
    mocker.patch(
        "dj.apps.ztripe.native_return.native_return_redis_deadline",
        side_effect=lambda: nullcontext(),
    )
    redis_cache = caches["default"]
    client = redis_cache.client.get_client(write=True)
    _clear_own_redis_keys(redis_cache)
    try:
        # W = now + 2 puts the boundary one to two seconds away on Redis's
        # clock (see _window_that_cannot_roll_over for the arithmetic). A
        # stalled runner could cross it during the first burst, so an attempt
        # that did is discarded and retried with a fresh owner and window
        # rather than failing the gate on correct behaviour.
        for attempt in range(5):
            window = int(client.time()[0]) + 2
            identity = f"signed-user-rollover-{attempt}"

            def admit():
                return admit_native_return(
                    identity, window_seconds=window, limit=6
                )[0]

            first_window = [admit() for _ in range(7)]
            if int(client.time()[0]) < window:
                break
        else:
            pytest.fail("five bursts in a row outlived a 1-2 second window")
        assert first_window == [True] * 6 + [False]
        _wait_for_own_redis_counter_expiry(
            client, redis_cache.make_key(_admission_key(identity)), window,
        )
        assert [admit() for _ in range(7)] == [True] * 6 + [False]
    finally:
        _clear_own_redis_keys(redis_cache)


@pytest.mark.django_db
def test_success_bridge_validates_session_and_claim_is_bounded_repeatable(
    api_client, creator_factory
):
    user = creator_factory()
    url, state = _success_url(user.id)
    session = _stripe_session(user.id, state)
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=session,
    ):
        first = api_client.get(url)

    assert first.status_code == 200
    first_claim = _extract_claim(first)
    assert first["Cache-Control"].startswith("no-store")
    assert first["Content-Security-Policy"].startswith("default-src 'none'")
    body = first.content.decode()
    assert "cs_test_12345678" not in body
    assert "state=" not in body
    api_client.force_authenticate(user=user)
    assert api_client.post(
        "/api/stripe/native-return/claim/", {"code": first_claim}, format="json"
    ).status_code == 200
    assert api_client.post(
        "/api/stripe/native-return/claim/", {"code": first_claim}, format="json"
    ).status_code == 200


@pytest.mark.django_db
@pytest.mark.parametrize(
    "suffix",
    [
        "&next=https://evil.example",
        "&state=duplicate",
        "&session_id=cs_test_duplicated",
        "#fragment",
    ],
)
def test_success_bridge_rejects_extra_duplicate_and_fragment_tricks(
    api_client, creator_factory, suffix
):
    user = creator_factory()
    url, state = _success_url(user.id)
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    ) as retrieve:
        response = api_client.get(url + suffix)
        valid = api_client.get(url)
    # Browsers do not transmit fragments. If a non-browser client includes one
    # in the request target, it becomes part of the strict session-id value and
    # is rejected too. No attacker-controlled component reaches the app URI.
    assert response.status_code == 400
    assert valid.status_code == 200
    assert retrieve.call_count == 1
    assert "evil.example" not in response.content.decode()


@pytest.mark.django_db
@pytest.mark.parametrize("malformation", ["missing", "invalid"])
def test_malformed_success_query_does_not_reserve_provider_capacity(
    api_client, creator_factory, malformation, settings
):
    user = creator_factory()
    url, state = _success_url(user.id)
    settings.NATIVE_RETURN_PROVIDER_SLOTS = 1
    if malformation == "missing":
        malformed_url = url.split("&session_id=", 1)[0]
    else:
        malformed_url = url.replace("cs_test_12345678", "not-a-session")

    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    ) as retrieve:
        malformed = api_client.get(malformed_url)
        valid = api_client.get(url)

    assert malformed.status_code == 400
    assert valid.status_code == 200
    assert retrieve.call_count == 1


@pytest.mark.django_db
def test_success_state_on_cancel_route_does_not_reserve_provider_capacity(
    api_client, creator_factory, settings
):
    user = creator_factory()
    success_url, state = _success_url(user.id)
    cancel_url = success_url.replace(
        "/native-return/success/", "/native-return/cancel/"
    )
    settings.NATIVE_RETURN_PROVIDER_SLOTS = 1

    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    ) as retrieve:
        malformed = api_client.get(cancel_url)
        valid = api_client.get(success_url)

    assert malformed.status_code == 400
    assert valid.status_code == 200
    assert retrieve.call_count == 1


@pytest.mark.django_db
def test_success_bridge_rejects_tampering_and_cross_user_session(
    api_client, creator_factory
):
    user = creator_factory()
    url, state = _success_url(user.id)
    forged = url.replace("state=", "state=x", 1)
    assert api_client.get(forged).status_code == 410

    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id + 1, state),
    ):
        mismatch = api_client.get(url)
    assert mismatch.status_code == 400
    assert APP_RETURN_URI not in mismatch.content.decode()

    # Each independent validation scenario needs the production one-slot
    # provider budget; the slot intentionally outlives a completed lookup.
    cache.clear()
    other_session = _stripe_session(user.id, state)
    other_session["metadata"]["native_return_state_sha256"] = "0" * 64
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=other_session,
    ):
        swapped = api_client.get(url)
    assert swapped.status_code == 400
    assert APP_RETURN_URI not in swapped.content.decode()


@pytest.mark.django_db
def test_cancel_bridge_is_truthful_and_claim_is_bounded_without_stripe(
    api_client, creator_factory
):
    user = creator_factory()
    state = make_bridge_token(user.id, "cancel")
    url = f"/api/stripe/native-return/cancel/?state={state}"
    with patch("dj.apps.ztripe.views._retrieve_native_checkout_session") as retrieve:
        first = api_client.get(url)
        repeated = api_client.get(url)
    assert first.status_code == 200
    assert "Checkout cancelled" in first.content.decode()
    first_claim = _extract_claim(first)
    repeated_claim = _extract_claim(repeated)
    assert repeated.status_code == 200
    api_client.force_authenticate(user=user)
    assert api_client.post(
        "/api/stripe/native-return/claim/", {"code": first_claim}, format="json"
    ).status_code == 200
    assert api_client.post(
        "/api/stripe/native-return/claim/", {"code": repeated_claim}, format="json"
    ).status_code == 200
    retrieve.assert_not_called()


@pytest.mark.django_db
def test_cancel_fails_open_only_when_redis_admission_is_unavailable(
    api_client, creator_factory
):
    user = creator_factory()
    state = make_bridge_token(user.id, "cancel")
    url = f"/api/stripe/native-return/cancel/?state={state}"
    with patch(
        "dj.apps.ztripe.native_return.admit_native_return",
        side_effect=NativeReturnUnavailable("redis unavailable"),
    ) as admit, patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session"
    ) as retrieve:
        response = api_client.get(url)

    assert response.status_code == 200
    assert APP_RETURN_URI in response.content.decode()
    assert response["Cache-Control"].startswith("no-store")
    assert response["Referrer-Policy"] == "no-referrer"
    admit.assert_called_once()
    retrieve.assert_not_called()


@pytest.mark.django_db
def test_cancel_replay_is_owner_limited_without_spending_success_budget(
    api_client, creator_factory, mocker
):
    user = creator_factory()
    cancel_state = make_bridge_token(user.id, "cancel")
    cancel_url = f"/api/stripe/native-return/cancel/?state={cancel_state}"
    rates = {
        **SimpleRateThrottle.THROTTLE_RATES,
        "anon-checkout-return": "2/minute",
    }
    mocker.patch.object(SimpleRateThrottle, "THROTTLE_RATES", rates)
    retrieve = mocker.patch("dj.apps.ztripe.views._retrieve_native_checkout_session")

    first = api_client.get(cancel_url, HTTP_X_FORWARDED_FOR="198.51.100.1")
    api_client.force_authenticate(user=user)
    second = api_client.get(cancel_url, HTTP_X_FORWARDED_FOR="198.51.100.2")
    api_client.force_authenticate(user=None)
    limited = api_client.get(cancel_url, HTTP_X_FORWARDED_FOR="198.51.100.3")

    assert [first.status_code, second.status_code, limited.status_code] == [
        200, 200, 429,
    ]
    assert limited["Retry-After"]
    assert APP_RETURN_URI in limited.content.decode()
    assert cancel_state not in limited.content.decode()
    assert cache.get(_provider_slots_key()) is None
    retrieve.assert_not_called()

    api_client.force_authenticate(user=user)
    claimed = api_client.post(
        "/api/stripe/native-return/claim/",
        {"code": _extract_claim(limited)},
        format="json",
    )
    assert claimed.status_code == 200
    assert claimed.json() == {"outcome": "cancel", "status": "cancelled"}

    # Cancel replay has a separate signed-owner key, so it cannot drain the
    # budget for the user's later paid-success return.
    api_client.force_authenticate(user=None)
    success_url, success_state = _success_url(user.id)
    retrieve.return_value = _stripe_session(user.id, success_state)
    success = api_client.get(success_url)
    assert success.status_code == 200
    assert retrieve.call_count == 1


def test_invalid_cancel_rejects_before_redis_admission(api_client):
    with patch(
        "dj.apps.ztripe.native_return.admit_native_return",
        side_effect=NativeReturnUnavailable("redis unavailable"),
    ) as admit:
        response = api_client.get(
            "/api/stripe/native-return/cancel/?state=attacker-controlled"
        )

    # Invalid state cannot reach Stripe, so it must not let anonymous traffic
    # occupy callback workers on a half-open Redis dependency.
    assert response.status_code == 410
    assert APP_RETURN_URI not in response.content.decode()
    admit.assert_not_called()


@pytest.mark.django_db
def test_busy_local_admission_slot_preserves_a_callback_worker(
    api_client, creator_factory
):
    user = creator_factory()
    url, _state = _success_url(user.id)
    with native_return_local_admission_slot(), patch(
        "dj.apps.ztripe.native_return.admit_native_return"
    ) as admit, patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session"
    ) as retrieve:
        response = api_client.get(url)

    assert response.status_code == 503
    assert response["Retry-After"] == "2"
    assert APP_RETURN_URI in response.content.decode()
    admit.assert_not_called()
    retrieve.assert_not_called()


@pytest.mark.django_db
def test_claim_is_authenticated_user_bound_and_retryable_after_lost_response(
    api_client, creator_factory
):
    owner = creator_factory()
    other = creator_factory()
    url, state = _success_url(owner.id)
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(owner.id, state),
    ):
        code = _extract_claim(api_client.get(url))

    api_client.force_authenticate(user=other)
    wrong_user = api_client.post(
        "/api/stripe/native-return/claim/", {"code": code}, format="json"
    )
    assert wrong_user.status_code == 403

    api_client.force_authenticate(user=owner)
    claimed = api_client.post(
        "/api/stripe/native-return/claim/", {"code": code}, format="json"
    )
    assert claimed.status_code == 200, claimed.content
    assert claimed.json()["status"] == "processing"
    assert claimed.json()["status_token"]
    retry = api_client.post(
        "/api/stripe/native-return/claim/", {"code": code}, format="json"
    )
    assert retry.status_code == 200
    assert retry.json()["outcome"] == claimed.json()["outcome"]
    assert retry.json()["status"] == claimed.json()["status"]


@pytest.mark.django_db
def test_status_waits_for_webhook_row_then_reports_credit(
    api_client, creator_factory
):
    user = _authenticate(api_client, creator_factory)
    url, state = _success_url(user.id)
    stripe_session = _stripe_session(
        user.id,
        state,
    )
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=stripe_session,
    ):
        code = _extract_claim(api_client.get(url))
        claim = api_client.post(
            "/api/stripe/native-return/claim/", {"code": code}, format="json"
        )
        status_token = claim.json()["status_token"]
        before = api_client.post(
            "/api/stripe/native-return/status/",
            {"status_token": status_token},
            format="json",
        )
        StripeTransaction.objects.create(
            user=user,
            amount=125,
            tuzis_credited=100,
            stripe_charge_id="pi_12345678",
        )
        after = api_client.post(
            "/api/stripe/native-return/status/",
            {"status_token": status_token},
            format="json",
        )

    assert before.status_code == 200
    assert before.json() == {"status": "processing"}
    assert after.status_code == 200
    assert after.json() == {"status": "credited", "tuzis_credited": 100}


@pytest.mark.django_db
def test_processing_status_correlates_only_after_authoritative_webhook_row(
    api_client, creator_factory
):
    user = creator_factory()
    url, _state = _success_url(user.id)
    with patch(
        "dj.apps.ztripe.native_return.admit_native_return",
        side_effect=NativeReturnUnavailable("redis unavailable"),
    ):
        handoff = api_client.get(url)

    api_client.force_authenticate(user=user)
    claim = api_client.post(
        "/api/stripe/native-return/claim/",
        {"code": _extract_claim(handoff)},
        format="json",
    )
    token = _assert_correlated_processing_claim(api_client, claim)["status_token"]

    StripeTransaction.objects.create(
        user=user,
        amount=125,
        tuzis_credited=100,
        stripe_charge_id="pi_12345678",
    )
    # A database row for some payment is insufficient: the verified webhook's
    # Session correlation must resolve this exact non-authoritative token.
    before_resolution = api_client.post(
        "/api/stripe/native-return/status/",
        {"status_token": token},
        format="json",
    )
    record_status_resolution(
        user.id,
        "cs_test_12345678",
        "pi_12345678",
    )
    after_resolution = api_client.post(
        "/api/stripe/native-return/status/",
        {"status_token": token},
        format="json",
    )

    assert before_resolution.json() == {"status": "processing"}
    assert after_resolution.json() == {
        "status": "credited",
        "tuzis_credited": 100,
    }


@pytest.mark.django_db
def test_status_token_is_user_bound_and_tamper_evident(
    api_client, creator_factory
):
    owner = creator_factory()
    other = creator_factory()
    url, state = _success_url(owner.id)
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(owner.id, state),
    ):
        code = _extract_claim(api_client.get(url))
    api_client.force_authenticate(user=owner)
    claim = api_client.post(
        "/api/stripe/native-return/claim/", {"code": code}, format="json"
    )
    token = claim.json()["status_token"]

    api_client.force_authenticate(user=other)
    assert api_client.post(
        "/api/stripe/native-return/status/",
        {"status_token": token},
        format="json",
    ).status_code == 410
    api_client.force_authenticate(user=owner)
    assert api_client.post(
        "/api/stripe/native-return/status/",
        {"status_token": token + "x"},
        format="json",
    ).status_code == 410


# --- Open-redirect surface -------------------------------------------------
#
# The native return renders a link/meta-refresh to the app. If any part of that
# target were caller-controlled, the signed, user-bound return would become an
# open redirect on a Free2Z HTTPS origin. These prove it is not: the target is
# the module constant plus one server-minted signed claim code, and the classic
# host-confusion payloads below cannot reach it through either query parameter.

_OPEN_REDIRECT_PAYLOADS = [
    "//evil.example",                      # scheme-relative
    "///evil.example",                     # triple slash
    "https://stripe.com@evil.example",     # userinfo confusion
    "HTTPS://EVIL.EXAMPLE",                # case variant
    "CASH.FREE2Z.ZUULI://evil.example",    # app-scheme case variant
    "https://evil.example./",              # trailing-dot host
    "https://%65vil.example",              # percent-encoded host char
    "%2f%2fevil.example",                  # percent-encoded scheme-relative
    "\\/\\/evil.example",                  # backslash variant
    "cash.free2z.zuuli://checkout/return?code=x&next=https://evil.example",
]


@pytest.mark.django_db
@pytest.mark.parametrize("payload", _OPEN_REDIRECT_PAYLOADS)
@pytest.mark.parametrize("field", ["state", "session_id"])
def test_success_return_is_not_an_open_redirect(
    api_client, creator_factory, payload, field
):
    user = creator_factory()
    url, state = _success_url(user.id)
    session_id = "cs_test_12345678"
    hostile = {"state": state, "session_id": session_id}
    hostile[field] = payload
    hostile_url = (
        "/api/stripe/native-return/success/"
        f"?state={hostile['state']}&session_id={hostile['session_id']}"
    )
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    ) as retrieve:
        response = api_client.get(hostile_url)

    # Every payload is rejected (observed: 410 Gone -- the state is neither a
    # valid v2 bridge token nor a drainable v1 link). What matters is that the
    # response is a client-error refusal, never a redirect.
    assert 400 <= response.status_code < 500, response.status_code
    assert "Location" not in response
    body = response.content.decode()
    assert "evil.example" not in body.lower()
    # A rejected return must not have cost a provider lookup, and must not have
    # minted a claim the app could mistake for a completed purchase.
    retrieve.assert_not_called()
    assert "code=" not in body


@pytest.mark.django_db
@pytest.mark.parametrize("payload", _OPEN_REDIRECT_PAYLOADS)
def test_cancel_return_is_not_an_open_redirect(
    api_client, creator_factory, payload
):
    response = api_client.get(
        f"/api/stripe/native-return/cancel/?state={payload}"
    )
    assert 400 <= response.status_code < 500, response.status_code
    assert "Location" not in response
    body = response.content.decode()
    assert "evil.example" not in body.lower()
    assert "code=" not in body


@pytest.mark.django_db
def test_return_target_is_always_the_hardcoded_app_uri(
    api_client, creator_factory
):
    """The only scheme/host the return can ever emit is the app constant."""
    user = creator_factory()
    url, state = _success_url(user.id)
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    ):
        response = api_client.get(url)

    assert response.status_code == 200
    body = response.content.decode()
    targets = re.findall(r'(?:href|url)=["\']?([^"\'>\s]+)', body)
    targets = [t for t in targets if t]
    assert targets, body
    for target in targets:
        assert target.startswith(APP_RETURN_URI + "?code="), target
    # No other absolute URL of any scheme may appear in the rendered page.
    others = [
        m for m in re.findall(r'[A-Za-z][A-Za-z0-9+.-]*://[^"\'>\s]+', body)
        if not m.startswith(APP_RETURN_URI)
    ]
    assert others == [], others


@pytest.mark.django_db
@pytest.mark.parametrize("payload", _OPEN_REDIRECT_PAYLOADS[:4])
def test_rejected_return_leaves_no_charged_but_uncredited_state(
    api_client, creator_factory, payload
):
    """Refusing a return must not be able to strand a real payment.

    Credit is issued exclusively by ``fulfill_checkout_completed`` from the
    signature-verified webhook; the browser return only ever reads
    state. So a rejected return cannot consume, settle, or poison a payment --
    the webhook still credits whenever it arrives. Assert the return path
    neither fulfills nor mutates the intent.
    """
    user = creator_factory()
    intent = CheckoutIntent.objects.create(
        user=user,
        tuzis=100,
        amount_cents=205,
        currency="usd",
        pricing_version="card-v2",
        stripe_account_id="acct_nativeReturn01",
        stripe_mode="payment",
        stripe_livemode=False,
    )
    before_state = intent.state

    with patch("dj.apps.ztripe.views.fulfill_checkout_completed") as fulfill:
        response = api_client.get(
            "/api/stripe/native-return/success/"
            f"?state={payload}&session_id=cs_test_12345678"
        )

    assert 400 <= response.status_code < 500
    fulfill.assert_not_called()
    assert not StripeTransaction.objects.filter(user=user).exists()
    intent.refresh_from_db()
    assert intent.state == before_state


@pytest.mark.django_db
@pytest.mark.parametrize("body", [[], ["zuuli_mobile"], "zuuli_mobile", 1])
def test_non_object_checkout_body_is_a_bounded_400_not_a_500(
    api_client, creator_factory, body
):
    """A non-object JSON body must not crash the returnMode discriminator.

    ``returnMode`` is read straight off ``request.data`` before the serializer
    runs, so it has to tolerate a parsed body that is not a dict. A JSON array
    previously raised ``AttributeError: 'list' object has no attribute 'get'``
    and returned 500.
    """
    api_client.force_authenticate(user=creator_factory())
    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as create:
        response = api_client.post(
            "/api/stripe/create-checkout-session/", body, format="json"
        )
    assert response.status_code == 400, response.status_code
    create.assert_not_called()


@pytest.mark.django_db
def test_return_mode_is_part_of_the_published_request_contract():
    """A generated client must be able to see and send ``returnMode``.

    Without this the native mode is undiscoverable: the spec would describe a
    request body that cannot select it, orval would emit no field for it, and
    ZUULI would silently get a web-mode Session with no signed return.
    """
    from dj.apps.ztripe.serializers import CheckoutSessionRequestSerializer

    field = CheckoutSessionRequestSerializer().fields["returnMode"]
    assert set(field.choices) == {"web", "zuuli_mobile"}
    assert field.required is False

    serializer = CheckoutSessionRequestSerializer(data={"quantity": 1})
    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["returnMode"] == "web"

    invalid = CheckoutSessionRequestSerializer(
        data={"quantity": 1, "returnMode": "native"}
    )
    assert not invalid.is_valid()


@pytest.mark.django_db
@pytest.mark.parametrize("body", [[], ["x"], "x", 1])
@pytest.mark.parametrize(
    "url",
    [
        "/api/stripe/native-return/claim/",
        "/api/stripe/native-return/status/",
    ],
)
def test_non_object_body_on_return_claim_and_status_is_a_bounded_400(
    api_client, creator_factory, url, body
):
    """The claim/status handlers read ``.keys()`` off the parsed body.

    A JSON array or scalar has no ``.keys()``, so these raised AttributeError
    and returned 500 to an authenticated caller. A malformed client -- exactly
    the situation post-checkout recovery has to survive -- must get a bounded
    400 instead.
    """
    api_client.force_authenticate(user=creator_factory())
    response = api_client.post(url, body, format="json")
    assert response.status_code == 400, response.status_code


@pytest.mark.django_db
@pytest.mark.parametrize("purpose", ["success", "cancel"])
def test_slashless_return_path_is_refused_not_redirected(
    api_client, creator_factory, settings, purpose
):
    """APPEND_SLASH must never carry signed state onto a logged backend.

    Django redirects a slashless URL to its canonical route with the query
    string intact. On the canonical host that redirect is served by the normal
    backend, whose access log is not the callback host's no-logging edge, so
    the signed state would be written to a log for its full lifetime. The
    server only ever mints trailing-slash return URLs, so refusing the
    slashless spelling costs no legitimate link.
    """
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash"
    settings.ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN = (
        "https://checkout-return.stage.free2z.cash"
    )
    settings.ALLOWED_HOSTS = [
        "stage.free2z.cash",
        "checkout-return.stage.free2z.cash",
    ]
    user = creator_factory()
    state = make_bridge_token(user.id, purpose)
    slashless = f"/api/stripe/native-return/{purpose}?state={state}"

    for host in ("stage.free2z.cash", "checkout-return.stage.free2z.cash"):
        response = api_client.get(slashless, HTTP_HOST=host, secure=True)
        # A private 404 -- never a 301/302 whose Location would carry the
        # signed state onward to a logged backend.
        assert response.status_code == 404, (host, response.status_code)
        assert "Location" not in response
        assert state not in response.content.decode()

    # Positive control: the canonical trailing-slash route on the callback host
    # is still reachable, so this is a slashless refusal and not a blanket one.
    with patch(
        "dj.apps.ztripe.views._retrieve_native_checkout_session",
        return_value=_stripe_session(user.id, state),
    ):
        ok = api_client.get(
            f"/api/stripe/native-return/{purpose}/?state={state}"
            + ("&session_id=cs_test_12345678" if purpose == "success" else ""),
            HTTP_HOST="checkout-return.stage.free2z.cash",
            secure=True,
        )
    assert ok.status_code == 200, ok.status_code
