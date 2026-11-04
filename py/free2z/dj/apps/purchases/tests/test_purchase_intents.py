"""``POST /api/purchases/intents/`` + ``GET /api/purchases/intents/{id}``
(PU1), end to end against real Postgres: the spec shape, the
idempotency contract, the three credentials, the card fulfilment through the
existing signed webhook, and the rollout-window heal.

Only Stripe's HTTP API is mocked (``Session.create``); the webhook is a
really-signed event through the real endpoint, so the credit, the ledger
journal and the receipt link are the production code path.
"""
from __future__ import annotations

import time
import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import pytest
import stripe
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.oidc.models import F2ZApplication
from dj.apps.oidc.tests.conftest import Flow
from dj.apps.pricing.constants import card_charge_cents
from dj.apps.purchases.models import PurchaseIntent, PurchaseReceipt, Status
from dj.apps.tuzis.models import IdempotencyKey
from dj.apps.ztripe.models import CheckoutIntent, StripeTransaction
from dj.apps.ztripe.test_checkout_money_integrity import (  # noqa: F401 -- autouse fixture
    balance,
    completed_payload,
    post_signed,
    stripe_configuration,
)
from dj.free2z.throttling import StripeCheckoutUserRateThrottle

pytestmark = pytest.mark.django_db

URL = "/api/sdk/v1/purchases"
ONE = URL + "/"
LOOPBACK_RETURN = "http://127.0.0.1:49153/purchase-done"
APP_REDIRECT = "https://tutor.example.com/oauth/callback"
#The Free2Z billing page a Zcash refusal names.
BILLING = "https://free2z.cash/buy-2z"
SPEC_KEYS = {
    "id", "rail", "status", "quantity_2z", "price", "pricing_version",
    "created_at", "expires_at", "credited_at", "credited_milli_2z", "rail_data",
    "can_replace_instruction", "usage_credited_m2z", "usage_debt_repaid_m2z",
}


@pytest.fixture(autouse=True)
def _settings(settings):
    settings.CANONICAL_ORIGIN = "https://free2z.cash"
    StripeCheckoutUserRateThrottle.cache.clear()
    yield
    StripeCheckoutUserRateThrottle.cache.clear()


def fake_session(suffix):
    return SimpleNamespace(
        id=f"cs_test_{suffix}",
        url=f"https://checkout.stripe.com/c/pay/cs_test_{suffix}",
        mode="payment",
        livemode=False,
        account=None,
    )


def body(**overrides):
    payload = {
        "rail": "card",
        "quantity_2z": 500,
        "platform": "desktop",
        "return_url": LOOPBACK_RETURN,
    }
    payload.update(overrides)
    return {k: v for k, v in payload.items() if v is not None}


def create(client, key="key-1", suffix="p1", create_mock=None, **overrides):
    headers = {} if key is None else {"HTTP_IDEMPOTENCY_KEY": key}
    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as session_create:
        if create_mock is not None:
            session_create.side_effect = create_mock
        else:
            session_create.return_value = fake_session(suffix)
        response = client.post(URL, body(**overrides), format="json", **headers)
    return response, session_create


@pytest.fixture
def buyer(creator_factory):
    return creator_factory()


@pytest.fixture
def client(buyer):
    api = APIClient()
    api.force_authenticate(user=buyer)
    return api


def pay(intent_kwargs, *, event_id="evt_test_pu1", payment_intent="pi_test_pu1", user):
    """Deliver a really-signed checkout.session.completed for a Session
    opened with ``intent_kwargs`` (the Session.create call)."""
    metadata = intent_kwargs["metadata"]
    quantity = int(metadata["tuzis"])
    return post_signed(APIClient(), completed_payload(
        user=user,
        metadata=metadata,
        quantity=quantity,
        event_id=event_id,
        session_id="cs_test_p1",
        payment_intent=payment_intent,
        session_created=int(time.time()),
    ))


# ------------------------------------------------------------------ create
def test_create_returns_the_spec_intent_and_opens_the_same_checkout_as_the_web(client, buyer):
    response, session_create = create(client)
    assert response.status_code == 201, response.content
    data = response.json()
    assert set(data) == SPEC_KEYS
    intent = PurchaseIntent.objects.get(pk=data["id"])
    assert data["rail"] == "card"
    assert data["status"] == "pending"
    assert data["quantity_2z"] == 500
    assert data["price"] == {"currency": "USD", "amount_minor": card_charge_cents(500)}
    assert data["pricing_version"] == "card-v3"
    assert data["credited_at"] is None and data["credited_milli_2z"] is None
    assert data["rail_data"] == {"checkout_url": "https://checkout.stripe.com/c/pay/cs_test_p1"}
    assert response["Retry-After"] == "2"
    assert response["Cache-Control"] == "no-store"
    assert intent.creator_id == buyer.pk and intent.application_id is None
    assert intent.expires_at - intent.created_at == timedelta(minutes=30)

    checkout = CheckoutIntent.objects.get(purchase_intent=intent)
    assert checkout.state == CheckoutIntent.State.OPEN
    assert checkout.stripe_checkout_session_id == "cs_test_p1"
    kwargs = session_create.call_args.kwargs
    # The exact signed contract the webhook verifies -- nothing added.
    assert set(kwargs["metadata"]) == {
        "checkout_intent_id", "user_id", "tuzis", "amount_cents", "currency",
        "pricing_version", "stripe_account_id", "stripe_mode", "stripe_livemode",
    }
    assert kwargs["metadata"]["checkout_intent_id"] == str(checkout.public_id)
    assert kwargs["line_items"][0]["price_data"]["unit_amount"] == card_charge_cents(500)
    assert kwargs["idempotency_key"] == f"free2z-checkout-intent-{checkout.public_id}"
    assert kwargs["max_network_retries"] == 0
    success = urlsplit(kwargs["success_url"])
    assert f"{success.scheme}://{success.netloc}{success.path}" == LOOPBACK_RETURN
    assert parse_qs(success.query) == {"purchase_id": [str(intent.pk)], "status": ["success"]}
    assert parse_qs(urlsplit(kwargs["cancel_url"]).query)["status"] == ["cancel"]
    assert 30 * 60 < kwargs["expires_at"] - time.time() <= 31 * 60


def test_the_idempotency_key_is_required(client):
    for key in (None, "", "x" * 129, "has space", "ünï"):
        response, session_create = create(client, key=key)
        assert response.status_code == 400, key
        assert response.json()["error"]["code"] == "invalid_request"
        assert response.json()["error"]["details"]["field"] == "Idempotency-Key"
        session_create.assert_not_called()
    assert not PurchaseIntent.objects.exists()


def test_a_replay_returns_the_same_intent_and_opens_nothing(client):
    first, _ = create(client, key="replay-me")
    again, session_create = create(client, key="replay-me")
    assert again.status_code == 201
    assert again.json()["id"] == first.json()["id"]
    session_create.assert_not_called()
    assert PurchaseIntent.objects.count() == 1 == CheckoutIntent.objects.count()


def test_the_same_key_with_a_different_body_is_a_conflict(client):
    create(client, key="k")
    conflict, session_create = create(client, key="k", quantity_2z=600)
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"
    session_create.assert_not_called()
    assert PurchaseIntent.objects.count() == 1


def test_an_unfinished_claim_is_in_flight(client, buyer):
    IdempotencyKey.objects.create(scope="purchase_intent:first_party", user=buyer, key="busy")
    response, session_create = create(client, key="busy")
    assert response.status_code == 409
    assert response.json()["error"]["details"] == {"in_flight": True}
    session_create.assert_not_called()


@pytest.mark.parametrize(
    ("overrides", "status", "code"),
    [
        ({"quantity_2z": 99}, 400, "invalid_quantity"),
        ({"quantity_2z": 10_001}, 400, "invalid_quantity"),
        ({"quantity_2z": "500"}, 400, "invalid_quantity"),
        ({"quantity_2z": 500.5}, 400, "invalid_request"),
        ({"rail": "zcash"}, 400, "rail_unavailable"),
        ({"rail": "apple_iap", "platform": "ios"}, 400, "rail_unavailable"),
        ({"rail": "google_iap", "platform": "android"}, 400, "rail_unavailable"),
        ({"rail": "paypal"}, 400, "invalid_request"),
        ({"platform": "tv"}, 400, "invalid_request"),
        ({"embed": True}, 400, "invalid_request"),
        ({"price_minor": 1}, 400, "invalid_request"),
        ({"return_url": None}, 400, "invalid_request"),
        ({"return_url": "https://evil.example/done"}, 400, "invalid_request"),
        ({"return_url": "http://localhost:4000/done"}, 400, "invalid_request"),
        ({"return_url": "http://127.0.0.1:4000/done?x=1"}, 400, "invalid_request"),
        ({"return_url": "com.example.app:/done"}, 400, "invalid_request"),
    ],
)
def test_refusals_create_nothing_and_do_not_burn_the_key(client, overrides, status, code):
    response, session_create = create(client, key="refused", **overrides)
    assert response.status_code == status, response.content
    assert response.json()["error"]["code"] == code
    details = response.json()["error"].get("details") or {}
    if overrides.get("rail") == "zcash":
        assert details == {"billing_url": BILLING}
    else:
        assert "billing_url" not in details
    session_create.assert_not_called()
    assert not PurchaseIntent.objects.exists()
    # The same key still works for a valid request.
    ok, _ = create(client, key="refused")
    assert ok.status_code == 201


# ------------------------------------------------- zcash: Free2Z billing
# Apps don't sell 2Z. A Zcash request is refused as before, and the
# refusal names the user's Free2Z billing page (Zcash first, card second).
def assert_zcash_refusal_names_billing(api, expected_url, **overrides):
    response, session_create = create(api, key="zec", rail="zcash", **overrides)
    assert response.status_code == 400, response.content
    error = response.json()["error"]
    assert error["code"] == "rail_unavailable"
    assert error["details"] == {"billing_url": expected_url}
    assert expected_url in error["message"]
    assert "Zcash" in error["message"]
    session_create.assert_not_called()
    assert not PurchaseIntent.objects.exists()
    assert not CheckoutIntent.objects.exists()
    # Refused before the idempotency claim: no receipt, and the same key
    # still opens a card intent afterwards.
    assert not IdempotencyKey.objects.filter(key="zec").exists()
    ok, _ = create(api, key="zec", **overrides)
    assert ok.status_code == 201, ok.content
    return error


def test_a_first_party_zcash_request_points_at_the_bare_billing_page(client):
    error = assert_zcash_refusal_names_billing(client, BILLING)
    assert "client_id" not in error["details"]["billing_url"]


def test_an_app_zcash_request_points_at_billing_with_its_client_id(buyer, app):
    api = bearer(oauth_token(buyer, app, "purchase:create"))
    error = assert_zcash_refusal_names_billing(
        api, f"{BILLING}?client_id={app.client_id}", return_url=APP_REDIRECT,
    )
    assert parse_qs(urlsplit(error["details"]["billing_url"]).query) == {"client_id": [app.client_id]}


def test_the_billing_url_is_built_on_the_canonical_origin(client, settings):
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash/"
    response, _ = create(client, rail="zcash")
    assert response.json()["error"]["details"] == {"billing_url": "https://stage.free2z.cash/buy-2z"}


def test_an_app_card_intent_still_opens_checkout_and_names_no_billing_page(buyer, app):
    api = bearer(oauth_token(buyer, app, "purchase:create"))
    response, _ = create(api, return_url=APP_REDIRECT)
    assert response.status_code == 201, response.content
    assert response.json()["rail_data"] == {"checkout_url": "https://checkout.stripe.com/c/pay/cs_test_p1"}
    assert "buy-2z" not in response.content.decode()


def test_a_zcash_request_without_purchase_create_is_still_refused_for_scope(buyer, app):
    api = bearer(oauth_token(buyer, app, "balance:read"))
    response, _ = create(api, rail="zcash")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "insufficient_scope"
    assert "buy-2z" not in response.content.decode()


def test_first_party_may_return_to_a_free2z_page(client):
    response, _ = create(client, return_url="https://free2z.cash/wallet/fund")
    assert response.status_code == 201, response.content


def test_an_unready_checkout_refuses_before_creating_and_frees_the_key(client, settings):
    settings.STRIPE_CHECKOUT_ENABLED = "false"
    response, session_create = create(client, key="later")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "checkout_not_activated"
    session_create.assert_not_called()
    assert not PurchaseIntent.objects.exists()
    settings.STRIPE_CHECKOUT_ENABLED = "true"
    assert create(client, key="later")[0].status_code == 201


def test_a_stripe_failure_fails_the_intent_and_replays_the_error(client):
    def boom(**kwargs):
        raise stripe.error.APIConnectionError("down")

    response, _ = create(client, key="stripe-down", create_mock=boom)
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "stripe_unavailable"
    intent = PurchaseIntent.objects.get()
    assert intent.status == Status.FAILED
    assert CheckoutIntent.objects.get().state == CheckoutIntent.State.PROVIDER_FAILED
    again, session_create = create(client, key="stripe-down")
    assert again.status_code == 502
    assert again.json()["error"]["code"] == "stripe_unavailable"
    session_create.assert_not_called()


def test_an_invalid_session_url_fails_the_intent(client):
    def evil(**kwargs):
        session = fake_session("evil")
        session.url = "https://checkout.stripe.com.evil.example/c/pay/cs_test_evil"
        return session

    with patch("dj.apps.ztripe.views.stripe.checkout.Session.expire") as expire:
        response, _ = create(client, create_mock=evil)
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "stripe_invalid_session"
    assert PurchaseIntent.objects.get().status == Status.FAILED
    expire.assert_called_once()


# ------------------------------------------------------------- fulfilment
def test_the_webhook_credits_once_and_links_the_receipt(client, buyer):
    response, session_create = create(client)
    intent_id = response.json()["id"]
    before = balance(buyer)
    delivered = pay(session_create.call_args.kwargs, user=buyer)
    assert delivered.status_code == 200, delivered.content
    assert balance(buyer) == before + 500
    # Linked by the webhook's own transaction, before anything reads it (the
    # GET would otherwise heal it and hide a missing link).
    stored = PurchaseIntent.objects.get(pk=intent_id)
    assert stored.status == Status.CREDITED
    assert stored.credited_milli_2z == 500_000
    assert PurchaseReceipt.objects.filter(intent=stored).count() == 1

    got = client.get(f"{ONE}{intent_id}")
    assert got.status_code == 200
    data = got.json()
    assert data["status"] == "credited"
    assert data["credited_milli_2z"] == 500_000
    assert data["credited_at"] is not None
    assert "Retry-After" not in got
    stripe_tx = StripeTransaction.objects.get(stripe_charge_id="pi_test_pu1")
    receipt = PurchaseReceipt.objects.get()
    assert receipt.intent_id == uuid.UUID(intent_id)
    assert (receipt.rail, receipt.provider_event_id) == ("stripe", "pi_test_pu1")
    assert (receipt.ledger_ref_kind, receipt.ledger_ref_id) == ("stripe_transaction", str(stripe_tx.pk))
    assert receipt.amount_minor == card_charge_cents(500) and receipt.currency == "USD"

    # A redelivery (a new event id for the same payment) credits nothing more.
    again = pay(session_create.call_args.kwargs, user=buyer, event_id="evt_test_pu1_again")
    assert again.status_code == 200
    assert balance(buyer) == before + 500
    assert PurchaseReceipt.objects.count() == 1


def test_a_web_wallet_checkout_is_untouched(api_client, buyer):
    api_client.force_authenticate(user=buyer)
    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as session_create:
        session_create.return_value = fake_session("p1")
        response = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 500, "currentPath": "/wallet/fund"}, format="json",
        )
    assert response.status_code == 200
    assert CheckoutIntent.objects.get().purchase_intent_id is None
    assert pay(session_create.call_args.kwargs, user=buyer).status_code == 200
    assert not PurchaseIntent.objects.exists()
    assert not PurchaseReceipt.objects.exists()


def test_an_expired_intent_still_credits_a_late_payment(client, buyer):
    response, session_create = create(client)
    intent = PurchaseIntent.objects.get(pk=response.json()["id"])
    PurchaseIntent.objects.filter(pk=intent.pk).update(
        created_at=timezone.now() - timedelta(hours=1),
        expires_at=timezone.now() - timedelta(minutes=30),
    )
    assert client.get(f"{ONE}{intent.pk}").json()["status"] == "expired"
    assert pay(session_create.call_args.kwargs, user=buyer).status_code == 200
    assert client.get(f"{ONE}{intent.pk}").json()["status"] == "credited"


def test_an_intent_fulfilled_by_an_old_pod_is_caught_up_on_read(client, buyer):
    """The rollout window: the previous release runs the webhook, credits,
    and knows nothing about purchase intents."""
    response, session_create = create(client)
    intent_id = response.json()["id"]
    with patch("dj.apps.purchases.services.record_card_fulfillment"):
        assert pay(session_create.call_args.kwargs, user=buyer).status_code == 200
    assert PurchaseIntent.objects.get(pk=intent_id).status == Status.PENDING
    assert not PurchaseReceipt.objects.exists()
    data = client.get(f"{ONE}{intent_id}").json()
    assert data["status"] == "credited"
    assert data["credited_milli_2z"] == 500_000
    assert PurchaseReceipt.objects.get().provider_event_id == "pi_test_pu1"


# ------------------------------------------------------------- credentials
@pytest.fixture
def app(creator_factory):
    return F2ZApplication.objects.create(
        name="Tutor",
        user=creator_factory(username="tutor-dev"),
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris=f"{APP_REDIRECT} http://127.0.0.1:0/callback",
        allowed_scopes="openid offline_access balance:read purchase:create ai:invoke",
    )


def oauth_token(buyer, app, scope):
    session = APIClient()
    session.force_login(buyer)
    return Flow(session, buyer, app, redirect_uri=APP_REDIRECT, scope=scope).run()["access_token"]


def bearer(token):
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return api


def test_an_oauth_app_with_purchase_create_buys_and_reads_its_own(buyer, app, client):
    api = bearer(oauth_token(buyer, app, "purchase:create"))
    response, _ = create(api, return_url=APP_REDIRECT)
    assert response.status_code == 201, response.content
    intent = PurchaseIntent.objects.get(pk=response.json()["id"])
    assert intent.application_id == app.pk and intent.creator_id == buyer.pk
    assert api.get(f"{ONE}{intent.pk}").status_code == 200
    # The user's own first-party session sees it too.
    assert client.get(f"{ONE}{intent.pk}").status_code == 200


def test_an_app_may_not_send_the_browser_anywhere_else(buyer, app):
    api = bearer(oauth_token(buyer, app, "purchase:create"))
    response, _ = create(api, return_url="https://free2z.cash/wallet/fund")
    assert response.status_code == 400
    assert response.json()["error"]["details"]["field"] == "return_url"
    assert create(api, key="k2", return_url=LOOPBACK_RETURN)[0].status_code == 201


def test_a_token_without_purchase_create_is_refused(buyer, app):
    api = bearer(oauth_token(buyer, app, "balance:read"))
    response, session_create = create(api)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "insufficient_scope"
    assert response.json()["error"]["details"] == {"scope": "purchase:create"}
    session_create.assert_not_called()
    assert not PurchaseIntent.objects.exists()


def test_idempotency_keys_are_scoped_per_app(buyer, app, client):
    api = bearer(oauth_token(buyer, app, "purchase:create"))
    first, _ = create(api, key="shared")
    second, _ = create(client, key="shared", suffix="p2")
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] != second.json()["id"]


def test_nobody_else_can_read_an_intent(buyer, app, client, creator_factory):
    response, _ = create(client)
    intent_id = response.json()["id"]
    stranger = APIClient()
    stranger.force_authenticate(user=creator_factory())
    for reader in (stranger, bearer(oauth_token(buyer, app, "purchase:create"))):
        refused = reader.get(f"{ONE}{intent_id}")
        assert refused.status_code == 404
        assert refused.json()["error"]["code"] == "purchase_not_found"
    anonymous = APIClient().get(f"{ONE}{intent_id}")
    assert anonymous.status_code == 401
    assert anonymous.json()["error"] == {
        "code": "invalid_token", "message": anonymous.json()["error"]["message"],
        "details": {"reason": "missing"},
    }
    assert anonymous["WWW-Authenticate"].startswith("Bearer")


# ------------------------------------------------------- crash recovery
def _crash_after_create(client, key, monkeypatch):
    """Run a create that dies right after its rows commit (a worker killed
    between the intent commit and the Stripe call)."""
    from dj.apps.purchases.views import PurchaseIntentCreateView

    def die(self, intent, checkout, identity):
        raise RuntimeError("worker killed")

    monkeypatch.setattr(PurchaseIntentCreateView, "_open_session", die)
    crashed, _ = create(client, key=key)
    assert crashed.status_code == 500
    assert crashed.json()["error"]["code"] == "internal_error"
    monkeypatch.undo()


def _age_claim(key):
    IdempotencyKey.objects.filter(key=key).update(created_at=timezone.now() - timedelta(minutes=16))


def test_a_crash_after_create_keeps_the_key_bound_to_its_intent(client, monkeypatch):
    _crash_after_create(client, "crashy", monkeypatch)
    intent = PurchaseIntent.objects.get()
    assert intent.status == Status.CREATED
    claim = IdempotencyKey.objects.get(key="crashy")
    assert claim.response_status is None
    assert claim.response_body == {"purchase_id": str(intent.pk)}
    # Before STALE_CLAIM the retry is told to wait, and opens nothing.
    waiting, session_create = create(client, key="crashy")
    assert waiting.status_code == 409 and waiting.json()["error"]["details"] == {"in_flight": True}
    session_create.assert_not_called()


def test_a_stale_retry_replaces_a_purchase_whose_checkout_never_opened(client, monkeypatch):
    """Nobody can pay a Session whose URL was never disclosed, and Stripe
    refuses a reused idempotency key with different parameters, so the dead
    purchase is failed and a new one opened under the same key."""
    _crash_after_create(client, "crashy", monkeypatch)
    dead = PurchaseIntent.objects.get()
    _age_claim("crashy")
    recovered, session_create = create(client, key="crashy")
    assert recovered.status_code == 201, recovered.content
    assert recovered.json()["id"] != str(dead.pk)
    assert recovered.json()["status"] == "pending"
    dead.refresh_from_db()
    assert dead.status == Status.FAILED
    assert CheckoutIntent.objects.get(purchase_intent=dead).state == CheckoutIntent.State.PROVIDER_FAILED
    fresh = CheckoutIntent.objects.get(purchase_intent_id=recovered.json()["id"])
    assert session_create.call_args.kwargs["idempotency_key"] == f"free2z-checkout-intent-{fresh.public_id}"
    # The key is finished now and names the new purchase.
    again, session_create = create(client, key="crashy")
    assert again.json()["id"] == recovered.json()["id"]
    session_create.assert_not_called()


def test_a_crash_between_failing_and_replacing_still_recovers(client, monkeypatch):
    """Failing the dead purchase and creating its replacement are two
    commits; dying between them must not strand the key (codex round 3)."""
    from dj.apps.purchases.views import PurchaseIntentCreateView

    _crash_after_create(client, "crashy", monkeypatch)
    dead = PurchaseIntent.objects.get()
    _age_claim("crashy")

    def die(self, *args, **kwargs):
        raise RuntimeError("worker killed again")

    monkeypatch.setattr(PurchaseIntentCreateView, "_open_card", die)
    assert create(client, key="crashy")[0].status_code == 500
    monkeypatch.undo()
    dead.refresh_from_db()
    assert dead.status == Status.FAILED and not dead.rail_data

    _age_claim("crashy")
    recovered, session_create = create(client, key="crashy")
    assert recovered.status_code == 201, recovered.content
    assert recovered.json()["id"] != str(dead.pk)
    assert recovered.json()["rail_data"]["checkout_url"].startswith("https://checkout.stripe.com/")
    session_create.assert_called_once()


def _unfinish_and_age(key):
    IdempotencyKey.objects.filter(key=key).update(
        response_status=None, created_at=timezone.now() - timedelta(minutes=16),
    )


def test_a_stale_retry_of_an_opened_purchase_returns_it(client):
    """A worker that died after opening the checkout but before finishing the
    claim: its URL may already be out (an in-flight replay returns it)."""
    first, _ = create(client, key="opened")
    _unfinish_and_age("opened")
    again, session_create = create(client, key="opened")
    assert again.status_code == 201
    assert again.json()["id"] == first.json()["id"]
    session_create.assert_not_called()
    assert PurchaseIntent.objects.count() == 1


def test_a_stale_retry_with_a_different_body_is_still_a_conflict(client):
    first, _ = create(client, key="opened")
    original_hash = IdempotencyKey.objects.get(key="opened").request_hash
    _unfinish_and_age("opened")
    changed, session_create = create(client, key="opened", suffix="p2", quantity_2z=700)
    # Never rebound, not even for an instant (codex round 5): a concurrent
    # changed-body retry must not find the key matching ITS body.
    assert IdempotencyKey.objects.get(key="opened").request_hash == original_hash
    concurrent, _ = create(client, key="opened", suffix="p3", quantity_2z=700)
    assert concurrent.status_code == 409
    assert changed.status_code == 409
    assert changed.json()["error"]["code"] == "idempotency_conflict"
    session_create.assert_not_called()
    assert PurchaseIntent.objects.count() == 1
    # The key still belongs to the original body.
    _unfinish_and_age("opened")
    same, _ = create(client, key="opened")
    assert same.json()["id"] == first.json()["id"]


def test_a_changed_body_is_refused_before_any_takeover(client, monkeypatch):
    """codex round 5: the shared takeover rebound the fingerprint first and
    restored it in a later commit; a worker dying in between left the key
    matching the WRONG body. Now nothing past claim() runs for it."""
    from dj.apps.purchases.views import PurchaseIntentCreateView

    create(client, key="opened")
    original_hash = IdempotencyKey.objects.get(key="opened").request_hash
    _unfinish_and_age("opened")

    def die(self, *args, **kwargs):
        raise RuntimeError("worker killed mid-recovery")

    monkeypatch.setattr(PurchaseIntentCreateView, "_recover", die)
    changed, _ = create(client, key="opened", suffix="p2", quantity_2z=700)
    assert changed.status_code == 409
    assert IdempotencyKey.objects.get(key="opened").request_hash == original_hash


def test_an_in_flight_retry_gets_the_intent_once_its_checkout_is_open(client, buyer):
    response, _ = create(client, key="slow")
    # Pretend the original request had not finished its claim yet.
    IdempotencyKey.objects.filter(key="slow").update(response_status=None)
    again, session_create = create(client, key="slow")
    assert again.status_code == 201
    assert again.json()["id"] == response.json()["id"]
    session_create.assert_not_called()


# ------------------------------------------------------ review round
def test_a_paid_intent_never_expires(client, buyer):
    from dj.apps.purchases.models import EXPIRABLE_STATUSES

    assert Status.PAID not in EXPIRABLE_STATUSES
    response, _ = create(client)
    intent = PurchaseIntent.objects.get(pk=response.json()["id"])
    intent.transition(Status.PAID)
    PurchaseIntent.objects.filter(pk=intent.pk).update(
        created_at=timezone.now() - timedelta(hours=2),
        expires_at=timezone.now() - timedelta(hours=1),
    )
    assert client.get(f"{ONE}{intent.pk}").json()["status"] == "paid"
    assert PurchaseIntent.objects.get(pk=intent.pk).status == Status.PAID


def test_a_payment_already_linked_elsewhere_is_not_relinked(client, buyer):
    """The receipt-conflict guard: a payment id that already names another
    intent leaves this intent untouched -- and the credit still happens."""
    response, session_create = create(client)
    other, _ = create(client, key="other", suffix="p2")
    PurchaseReceipt.objects.create(
        intent_id=other.json()["id"], rail="stripe", provider_event_id="pi_test_pu1",
        amount_minor=1, currency="USD", credited_milli_2z=0,
        ledger_ref_kind="stripe_transaction", ledger_ref_id="0",
    )
    before = balance(buyer)
    assert pay(session_create.call_args.kwargs, user=buyer).status_code == 200
    assert balance(buyer) == before + 500
    assert PurchaseIntent.objects.get(pk=response.json()["id"]).status == Status.PENDING
    assert PurchaseReceipt.objects.get().intent_id == uuid.UUID(other.json()["id"])


def test_a_linking_integrity_error_never_rolls_back_the_credit(client, buyer, monkeypatch):
    from django.db import IntegrityError

    from dj.apps.purchases import services

    def explode(*args, **kwargs):
        raise IntegrityError("simulated")

    response, session_create = create(client)
    monkeypatch.setattr(services, "_advance_to_credited", explode)
    before = balance(buyer)
    assert pay(session_create.call_args.kwargs, user=buyer).status_code == 200
    assert balance(buyer) == before + 500
    assert StripeTransaction.objects.filter(stripe_charge_id="pi_test_pu1").exists()
    # The link rolled back as a unit: no receipt, intent untouched.
    assert not PurchaseReceipt.objects.exists()
    assert PurchaseIntent.objects.get(pk=response.json()["id"]).status == Status.PENDING


def test_a_failure_mid_create_leaves_nothing_half_written(client, monkeypatch):
    """The view opts out of AtomicMiddleware (it must: the claim commits
    first, and Stripe is called outside any transaction), so its own create
    block has to be all-or-nothing: an error after the intent row is written
    but before the CheckoutIntent and the key binding leaves no intent, no
    checkout, and no claim (the key stays usable)."""
    from dj.apps.ztripe.models import CheckoutIntent as ZCheckoutIntent

    def boom(*args, **kwargs):
        raise RuntimeError("database hiccup after the intent insert")

    monkeypatch.setattr(ZCheckoutIntent.objects, "create", boom)
    response, session_create = create(client, key="halfway")
    assert response.status_code == 500
    session_create.assert_not_called()
    assert not PurchaseIntent.objects.exists()
    assert not CheckoutIntent.objects.exists()
    assert not IdempotencyKey.objects.filter(key="halfway").exists()
    monkeypatch.undo()
    assert create(client, key="halfway")[0].status_code == 201


def test_a_failed_key_binding_fails_the_request(client, monkeypatch):
    """If the claim is no longer ours when the intent commits, nothing may be
    created under someone else's key."""
    from dj.apps.purchases import views

    real_claim = views.idempotency.claim

    def stolen(*args, **kwargs):
        record = real_claim(*args, **kwargs)
        IdempotencyKey.objects.filter(pk=record.pk).update(owner=uuid.uuid4())
        return record

    monkeypatch.setattr(views.idempotency, "claim", stolen)
    response, session_create = create(client, key="stolen")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    session_create.assert_not_called()
    assert not PurchaseIntent.objects.exists()
    assert not CheckoutIntent.objects.exists()


# ----------------------------------------------------- the SDK error envelope
def _assert_envelope(response, status, code):
    assert response.status_code == status, response.content
    body = response.json()
    assert set(body) == {"error"}
    assert body["error"]["code"] == code
    assert isinstance(body["error"]["message"], str)
    assert response["Cache-Control"] == "no-store"


def test_every_sdk_error_is_the_spec_envelope(client, buyer):
    _assert_envelope(APIClient().post(URL, {}, format="json"), 401, "invalid_token")
    bad = APIClient()
    bad.credentials(HTTP_AUTHORIZATION="Bearer not.a.jwt")
    _assert_envelope(bad.get(f"{ONE}{uuid.uuid4()}"), 401, "invalid_token")
    _assert_envelope(client.get(f"{ONE}{uuid.uuid4()}"), 404, "purchase_not_found")
    _assert_envelope(client.get("/api/sdk/v1/nope"), 404, "not_found")
    _assert_envelope(APIClient().delete("/api/sdk/v1/purchases/x/y"), 404, "not_found")
    _assert_envelope(client.get(URL), 405, "method_not_allowed")
    malformed = client.post(URL, "{", content_type="application/json", HTTP_IDEMPOTENCY_KEY="k")
    _assert_envelope(malformed, 400, "invalid_request")


def test_other_apis_keep_their_own_error_shape(api_client):
    response = api_client.get("/api/stripe/transactions/")
    assert response.status_code in (401, 403)
    assert "error" not in response.json()


# --------------------------------------------------------------- throttling
def test_an_app_has_its_own_bucket_and_cannot_throttle_the_web_wallet(buyer, app, api_client):
    api = bearer(oauth_token(buyer, app, "purchase:create"))
    for i in range(6):
        ok, _ = create(api, key=f"k{i}", suffix=f"t{i}")
        assert ok.status_code == 201, ok.content
    limited, session_create = create(api, key="k-over", suffix="t-over")
    _assert_envelope(limited, 429, "rate_limited")
    assert int(limited["Retry-After"]) > 0
    session_create.assert_not_called()
    # The user's web wallet is on its own bucket, untouched by the app.
    api_client.force_authenticate(user=buyer)
    with patch("dj.apps.ztripe.views.stripe.checkout.Session.create") as web_create:
        web_create.return_value = fake_session("web")
        web = api_client.post(
            "/api/stripe/create-checkout-session/",
            {"quantity": 500, "currentPath": "/wallet/fund"}, format="json",
        )
    assert web.status_code == 200, web.content
    # A replay of a finished key spends no token, even with the bucket empty.
    replay, session_create = create(api, key="k0", suffix="t0")
    assert replay.status_code == 201
    session_create.assert_not_called()


def test_a_first_party_caller_shares_the_users_checkout_bucket(client, buyer):
    for i in range(6):
        assert create(client, key=f"f{i}", suffix=f"f{i}")[0].status_code == 201
    _assert_envelope(create(client, key="f-over", suffix="f-over")[0], 429, "rate_limited")


def test_a_registered_browser_app_passes_the_sdk_preflight(buyer, app):
    """codex round 4: without this a public web app could get a token and
    then never call the endpoint it was granted."""
    app.allowed_origins = "https://tutor.example.com"
    app.save()
    for path, method in ((URL, "POST"), (f"{ONE}{uuid.uuid4()}", "GET")):
        preflight = APIClient().options(
            path,
            HTTP_ORIGIN="https://tutor.example.com",
            HTTP_ACCESS_CONTROL_REQUEST_METHOD=method,
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS="authorization, idempotency-key, content-type",
        )
        assert preflight["Access-Control-Allow-Origin"] == "https://tutor.example.com"
        assert "idempotency-key" in preflight["Access-Control-Allow-Headers"]
    stranger = APIClient().options(
        URL, HTTP_ORIGIN="https://evil.example", HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
    )
    assert not stranger.has_header("Access-Control-Allow-Origin")
    # Other APIs are not opened to registered app origins.
    other = APIClient().options(
        "/api/stripe/create-checkout-session/",
        HTTP_ORIGIN="https://tutor.example.com", HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
    )
    assert not other.has_header("Access-Control-Allow-Origin")


def test_one_app_cannot_throttle_another_app_for_the_same_user(buyer, app, creator_factory):
    other_app = F2ZApplication.objects.create(
        name="Other",
        user=creator_factory(username="other-dev"),
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris=f"{APP_REDIRECT} http://127.0.0.1:0/callback",
        allowed_scopes="openid purchase:create",
    )
    first = bearer(oauth_token(buyer, app, "purchase:create"))
    for i in range(6):
        assert create(first, key=f"a{i}", suffix=f"a{i}")[0].status_code == 201
    assert create(first, key="a-over", suffix="a-over")[0].status_code == 429
    second = bearer(oauth_token(buyer, other_app, "purchase:create"))
    assert create(second, key="b0", suffix="b0")[0].status_code == 201
