"""The provider call must not run inside a database transaction.

 wrapped the persistence *and* the 2Z debit of an AI chat in one
``transaction.atomic()`` — the right money semantic — but the provider stream
ended up inside the block too. A chat generation is 10-90s of third-party
network I/O, so that left a Cloud SQL connection ``idle in transaction`` for
the whole generation: an xmin pinned, vacuum held back, and a connection slot
burned in a state every monitoring tool reports as idle.

These tests pin the *shape* of the fix, not just its happy path:

* the provider stream runs with the connection in autocommit, outside any
  atomic block;
* the persist + settlement still share ONE atomic block, so neither can land
  without the other;
* provider failures before a stream starts stay free, while interrupted,
  started calls settle reported usage or the visible estimate without
  persisting a partial reply.

``@pytest.mark.django_db(transaction=True)`` is MANDATORY for the first two.
The default ``django_db`` wraps every test in an atomic block that never
commits, so ``connection.in_atomic_block`` is ``True`` for the whole test no
matter what the production code does. That does not make the assertion
permissive — it makes it **impossible to satisfy**: with plain ``django_db``
these tests fail against the FIXED code (verified, not assumed). The marker is
not a detail to tidy away later; without it the assertion cannot distinguish
anything at all, and the obvious "fix" for the resulting red is to delete the
assertion that is the entire point of the file.

Real Postgres throughout; only the provider HTTP call is faked.
"""
from decimal import Decimal
import uuid

import pytest
from django.db import DEFAULT_DB_ALIAS, connection, transaction
from django.test import RequestFactory
from rest_framework.test import APIClient

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.tuzis import ledger

from .models import AIModel, Conversation, PromptResponse


def _setup(creator_factory, tuzis="1000"):
    user = creator_factory(tuzis=Decimal(tuzis))
    model = AIModel.objects.create(
        model="test-model", display_name="Test", system_message="hi",
        max_tokens=100000,
    )
    conversation = Conversation.objects.create(
        user=user, ai_model=model, display_name="c")
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    return user, model, conversation, client


def _post(client, conversation, idempotency_key=None, generation_model_id=None):
    headers = {
        "HTTP_IDEMPOTENCY_KEY": idempotency_key or str(uuid.uuid4()),
    }
    if generation_model_id is not None:
        headers["HTTP_X_AI_GENERATION_MODEL"] = str(generation_model_id)
    return client.post(
        f"/api/ai/conversations/{conversation.id}/promptresponses/",
        {"user_input": "hello"}, format="json", **headers,
    )


def balance(user):
    return Creator.objects.get(pk=user.pk).tuzis


@pytest.fixture
def no_channel_layer(monkeypatch):
    """The live-token WebSocket push is a best-effort side-channel."""
    monkeypatch.setattr(
        "dj.apps.openai.models.get_channel_layer", lambda: None)


@pytest.mark.django_db(transaction=True)
def test_provider_stream_runs_outside_any_transaction(
        creator_factory, monkeypatch, no_channel_layer):
    """The regression test for  itself.

    Records the transaction state on every token. On the pre-fix code every one
    of these is inside the atomic block and this fails. It also fails if the
    `transaction=True` marker above is dropped -- see the module docstring.
    """
    seen = []

    def fake_stream(ai_model, messages, **kwargs):
        for word in ["Hello", ", ", "world"]:
            seen.append(
                (connection.in_atomic_block, connection.get_autocommit())
            )
            yield word

    monkeypatch.setattr("f2z.ai.providers.stream_chat", fake_stream)
    monkeypatch.setattr("dj.apps.openai.models.configured_providers", lambda: {"openai"})
    user, _, conversation, client = _setup(creator_factory)
    idempotency_key = str(uuid.uuid4())

    response = _post(client, conversation, idempotency_key)

    assert response.status_code == 200, response.content
    assert seen, "the provider stream was never iterated"
    for in_atomic_block, autocommit in seen:
        assert in_atomic_block is False, (
            "the provider stream ran inside transaction.atomic() — that is a "
            "Cloud SQL connection held `idle in transaction` for the whole "
            "10-90s generation (#737)"
        )
        assert autocommit is True, (
            "the connection was not in autocommit during the provider call"
        )
    # The answer still lands and is still paid for.
    assert PromptResponse.objects.filter(response="Hello, world").exists()
    assert balance(user) < Decimal("1000")


@pytest.mark.django_db(transaction=True)
def test_idempotency_key_correlates_live_websocket_deltas(
        creator_factory, monkeypatch):
    """A validated receipt key tags live deltas for late-event filtering."""
    sent = []

    class ChannelLayer:
        async def group_send(self, group, message):
            sent.append((group, message))

    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat",
        lambda *_args, **_kwargs: iter(["answer"]),
    )
    monkeypatch.setattr(
        "dj.apps.openai.models.get_channel_layer", lambda: ChannelLayer())
    _, _, conversation, client = _setup(creator_factory)
    idempotency_key = str(uuid.uuid4())

    response = _post(client, conversation, idempotency_key)

    assert response.status_code == 200, response.content
    assert sent == [(
        f"conversation_{conversation.id}",
        {
            "type": "send_word",
            "message": "answer",
            "stream_id": idempotency_key,
        },
    )]


@pytest.mark.django_db(transaction=True)
def test_persist_and_settlement_still_share_one_transaction(
        creator_factory, monkeypatch, no_channel_layer):
    """Shrinking the transaction must not un-couple the money from the answer.

    At the moment of settlement we must be inside an atomic block AND the
    PromptResponse must already be written in it — that is the whole guarantee
     bought: the two commit together or not at all.
    """
    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat",
        lambda ai_model, messages, **kwargs: iter(["paid answer"]),
    )
    user, _, conversation, client = _setup(creator_factory)

    real_settle = ledger.settle_reservation
    seen = {}

    def spy_settle(reservation, *, amount=None):
        seen["in_atomic_block"] = connection.in_atomic_block
        seen["row_written"] = PromptResponse.objects.filter(
            response="paid answer").exists()
        return real_settle(reservation, amount=amount)

    monkeypatch.setattr(ledger, "settle_reservation", spy_settle)

    response = _post(client, conversation)

    assert response.status_code == 200, response.content
    assert seen["in_atomic_block"] is True, (
        "settlement ran outside transaction.atomic() — a failure after it would "
        "charge the user with nothing to roll it back"
    )
    assert seen["row_written"] is True, (
        "the answer was not persisted in the same transaction as settlement"
    )


@pytest.mark.django_db
def test_started_stream_that_dies_is_charged_without_persisting_partial_reply(
        creator_factory, monkeypatch, no_channel_layer):
    """A started call is charged conservatively, but its partial reply is not
    persisted or returned as a successful answer.

    Half the tokens are on the wire (and already pushed over the WebSocket)
    when the provider connection drops. The admitted ceiling is held and
    settled because the provider may have billed hidden reasoning as well.
    """
    def dying_stream(ai_model, messages, **kwargs):
        yield "half an "
        raise ConnectionError("provider stream died mid-generation")

    monkeypatch.setattr("f2z.ai.providers.stream_chat", dying_stream)
    monkeypatch.setattr("dj.apps.openai.models.configured_providers", lambda: {"openai"})
    user, _, conversation, client = _setup(creator_factory)
    idempotency_key = str(uuid.uuid4())

    response = _post(client, conversation, idempotency_key)

    assert response.status_code == 503, response.content
    assert balance(user) < Decimal("1000"), (
        "the started provider call was refunded"
    )
    assert Event.objects.get(type="CHAT2Z", receiving_user=user).amount > 0
    assert not PromptResponse.objects.filter(
        user_input="hello").exists(), (
        "a half-generated answer was persisted"
    )


@pytest.mark.django_db
def test_interrupted_conversation_charges_observable_usage_and_discloses_it(
        creator_factory, monkeypatch, no_channel_layer):
    user = creator_factory(tuzis=Decimal("1000"))
    ai_model = AIModel.objects.create(
        provider="xai", model="grok-4.5", display_name="Grok 4.5",
        system_message="hi", max_tokens=100000, max_output_tokens=256,
        max_response_tokens=4096, input_price="0.000005",
        output_price="0.00003", markup="1.5", is_ga=True,
    )
    conversation = Conversation.objects.create(
        user=user, ai_model=ai_model, display_name="reasoning")
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    key = str(uuid.uuid4())
    provider_calls = []

    def thinking_then_timeout(ai_model, messages, **kwargs):
        provider_calls.append(1)
        yield ""
        raise TimeoutError("provider stream timed out")

    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat", thinking_then_timeout)

    path = f"/api/ai/conversations/{conversation.id}/promptresponses/"
    body = {"user_input": "hello", "max_output_tokens": 512}
    response = client.post(path, body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    input_tokens = conversation.build_messages("hello")[1]
    observed = ai_model.get_tuzi_price(input_tokens, 0)
    ceiling = ai_model.get_admission_price(input_tokens, 512)
    assert response.status_code == 503, response.content
    assert ceiling > observed
    assert balance(user) == Decimal("1000") - Decimal(observed)
    assert Event.objects.get(type="CHAT2Z", receiving_user=user).amount == observed
    assert response.data["charge_status"] == "settled"
    assert response.data["tuzis_charged"] == observed
    assert response.data["response_saved"] is False
    assert not PromptResponse.objects.filter(user_input="hello").exists()

    replay = client.post(path, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    assert replay.status_code == 503
    assert replay.data["tuzis_charged"] == observed
    assert balance(user) == Decimal("1000") - Decimal(observed)
    assert provider_calls == [1]
    assert Event.objects.filter(type="CHAT2Z", receiving_user=user).count() == 1


@pytest.mark.django_db
def test_a_provider_failure_leaves_no_transaction_open(
        creator_factory, monkeypatch, no_channel_layer):
    """The 503 path must not leak an open transaction onto the connection."""
    def dying_stream(ai_model, messages, **kwargs):
        raise RuntimeError("No API key configured for anthropic")
        yield  # pragma: no cover - generator marker

    monkeypatch.setattr("f2z.ai.providers.stream_chat", dying_stream)
    monkeypatch.setattr("dj.apps.openai.models.configured_providers", lambda: {"openai"})
    user, _, conversation, client = _setup(creator_factory)
    idempotency_key = str(uuid.uuid4())

    # Baseline, because pytest-django's non-transactional `django_db` wraps the
    # test itself in atomic() + a savepoint; only a NEW one left behind by the
    # view is a leak.
    before = list(connection.savepoint_ids)
    response = _post(client, conversation, idempotency_key)
    assert response.status_code == 503
    assert response.data["charge_status"] == "not_charged"
    assert response.data["tuzis_charged"] == 0
    assert list(connection.savepoint_ids) == before
    assert balance(user) == Decimal("1000")
    from dj.apps.ledger import api
    assert api.read_balance(user.pk).held == 0

    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat",
        lambda *args, **kwargs: iter(["answer"]))
    retry = _post(client, conversation, idempotency_key)
    assert retry.status_code == 200
    assert retry.data["response"] == "answer"


@pytest.mark.django_db
def test_chat_replay_survives_a_conversation_model_change(
        creator_factory, monkeypatch, no_channel_layer):
    calls = []
    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat",
        lambda *args, **kwargs: calls.append(1) or iter(["answer"]))
    user, model, conversation, client = _setup(creator_factory)
    idempotency_key = str(uuid.uuid4())

    first = _post(client, conversation, idempotency_key)
    assert first.status_code == 200
    charged = balance(user)

    # Simulate a paid receipt created by the previous release, whose request
    # fingerprint included the conversation's model id.
    from dj.apps.tuzis.models import IdempotencyKey, fingerprint
    old_hash = fingerprint({
        "action": "ai_chat",
        "intent": "openai_chat",
        "conversation": str(conversation.pk),
        "user_input": "hello",
        "max_output_tokens": None,
        "model": str(model.pk),
    })
    IdempotencyKey.objects.filter(
        user=user, key=idempotency_key,
        scope="ai_chat",
    ).update(request_hash=old_hash)

    legacy_replay = _post(client, conversation, idempotency_key)
    assert legacy_replay.status_code == 200
    assert legacy_replay.data["id"] == first.data["id"]

    replacement = AIModel.objects.create(
        model="replacement-model", display_name="Replacement",
        system_message="hi", max_tokens=100000,
    )
    conversation.ai_model = replacement
    conversation.save(update_fields=["ai_model"])

    replacement.is_enabled = False
    replacement.save(update_fields=["is_enabled"])

    replay = _post(
        client, conversation, idempotency_key,
        generation_model_id=model.pk)
    assert replay.status_code == 200
    assert replay.data["id"] == first.data["id"]
    assert calls == [1]
    assert balance(user) == charged


@pytest.mark.django_db
def test_disabled_model_refusal_resolves_a_fresh_claim(
        creator_factory, monkeypatch, no_channel_layer):
    user, _, conversation, client = _setup(creator_factory)
    conversation.ai_model.is_enabled = False
    conversation.ai_model.save(update_fields=["is_enabled"])
    key = str(uuid.uuid4())

    response = _post(client, conversation, key)

    assert response.status_code == 409
    assert response.data["charge_status"] == "not_charged"
    assert response.data["tuzis_charged"] == 0
    from dj.apps.tuzis.models import IdempotencyKey
    assert not IdempotencyKey.objects.filter(user=user, key=key).exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("endpoint", ["conversation", "metered_prompt"])
@pytest.mark.parametrize(
    "failure", ["result_shape", "price", "interrupted_price"])
def test_post_generation_settlement_errors_release_the_hold(
        endpoint, failure, creator_factory, monkeypatch, no_channel_layer):
    """Post-provider settlement errors cannot strand a metered hold."""
    from dj.apps.ledger import api
    from . import views
    from .models import GenerationInterrupted, GenerationResult

    monkeypatch.setattr("dj.apps.openai.models.configured_providers", lambda: {"openai"})
    user, _, conversation, client = _setup(creator_factory)
    idempotency_key = str(uuid.uuid4())
    starting_balance = balance(user)
    result = ("answer", 10, 10) if failure == "result_shape" else (
        GenerationResult("answer", 10, 10, 10))

    provider_calls = []
    provider_observations = []
    reservation_releases = []
    if endpoint == "conversation":
        def generate(*args, **kwargs):
            if failure == "interrupted_price":
                raise GenerationInterrupted(
                    RuntimeError("provider interrupted"), response_text="",
                    input_tokens=10, settlement_output_tokens=10, usage=None)
            return result

        monkeypatch.setattr(Conversation, "generate", generate)
        path = f"/api/ai/conversations/{conversation.id}/promptresponses/"
        body = {"user_input": "hello"}
    else:
        # MeteredPromptView rechecks live provider configuration before it
        # reserves credits. Keep this test independent of ambient API keys,
        # while still exercising that production guard and the quote flow.
        monkeypatch.setattr(
            "dj.apps.openai.models.configured_providers",
            lambda: {"openai"},
        )
        release_reservation = views.ledger.release_reservation

        def record_release(reservation):
            released = release_reservation(reservation)
            reservation_releases.append(released)
            return released

        monkeypatch.setattr(views.ledger, "release_reservation", record_release)
        from .test_metered_prompt import _model as create_metered_model
        metered_model = create_metered_model()

        def fake_provider_stream(*args, **kwargs):
            provider_calls.append((args, kwargs))
            provider_observations.append((
                connection.in_atomic_block,
                connection.get_autocommit(),
                api.read_balance(user.pk).held,
            ))
            if failure == "interrupted_price":
                yield "partial"
                raise RuntimeError("provider interrupted")
            yield "answer"

        monkeypatch.setattr("f2z.ai.providers.stream_chat", fake_provider_stream)
        from .models import generate_reply as real_generate_reply

        def generate(*args, **kwargs):
            generation = real_generate_reply(*args, **kwargs)
            if failure == "result_shape":
                # Preserve a real provider invocation, then reproduce a
                # malformed post-generation result at the view boundary.
                return result
            return generation

        monkeypatch.setattr(views, "generate_reply", generate)
        path = "/api/ai/prompt/"
        quote = client.post(
            "/api/ai/creator-options/",
            {"model": str(metered_model.pk), "prompt": "hello"},
            format="json",
        )
        assert quote.status_code == 200, quote.content
        body = {
            "model": str(metered_model.pk),
            "prompt": "hello",
            "max_output_tokens": quote.data["requested_output_tokens"],
            "quote_token": quote.data["quote_token"],
        }

    if failure in ("price", "interrupted_price"):
        monkeypatch.setattr(
            views, "_clamp_to_ceiling",
            lambda *a, **k: (_ for _ in ()).throw(
                RuntimeError("transient price failure")))

    expected_actor = (
        {"HTTP_X_EXPECTED_ACTOR": str(user.pk)}
        if endpoint == "metered_prompt" else {}
    )
    with pytest.raises((AttributeError, RuntimeError, ValueError)):
        client.post(path, body, format="json",
                    HTTP_IDEMPOTENCY_KEY=idempotency_key,
                    **expected_actor)

    assert api.read_balance(user.pk).held == 0
    assert balance(user) == starting_balance
    assert not Event.objects.filter(receiving_user=user).exists()
    from dj.apps.tuzis.models import IdempotencyKey
    assert not IdempotencyKey.objects.filter(
        user=user, key=idempotency_key).exists()
    if endpoint == "metered_prompt":
        assert len(provider_calls) == 1, "provider must be invoked exactly once"
        assert len(provider_observations) == 1
        assert provider_observations[0][:2] == (False, True), (
            "provider generation must stay outside the request transaction"
        )
        assert provider_observations[0][2] > 0, "the hold must precede provider I/O"
        assert provider_calls[0][0][0].pk == metered_model.pk
        assert provider_calls[0][1]["max_output_tokens"] == quote.data["max_output_tokens"]
        assert reservation_releases == [True], (
            "the failed settlement must release its hold exactly once"
        )


# --------------------------------------------------------------------------- #
# The opt-out itself. `AtomicMiddleware` wraps EVERY POST/PUT/PATCH in a
# transaction, so the split above buys nothing unless this endpoint is exempt
# from it -- and everything else must stay exactly as atomic as it was.
# --------------------------------------------------------------------------- #

def test_only_the_opted_out_view_escapes_the_request_wide_transaction():
    from dj.util.middleware import wants_atomic_request

    rf = RequestFactory()
    cid = uuid.uuid4()

    assert wants_atomic_request(
        rf.post(f"/api/ai/conversations/{cid}/promptresponses/")
    ) is False, "PromptResponseViewSet did not opt out (#737)"

    # Its neighbours -- and every other write endpoint -- keep the request-wide
    # transaction they have always had.
    assert wants_atomic_request(rf.post("/api/ai/conversations/")) is True
    assert wants_atomic_request(rf.post("/api/ai/personalities/")) is True
    assert wants_atomic_request(
        rf.post(f"/api/ai/conversations/{cid}/")) is True


def test_an_unroutable_path_stays_atomic():
    """Fail CLOSED: if we cannot tell what runs, keep the transaction."""
    from dj.util.middleware import wants_atomic_request

    assert wants_atomic_request(
        RequestFactory().post("/no/such/endpoint/here/")) is True


def test_every_view_opted_out_of_request_atomicity_is_inventoried():
    """Inventory guard, in the spirit of ``test_permission_inventory.py``.

    The path tests above say nothing about a view added
    next year. `AtomicMiddleware` now governs write-transaction semantics for
    the ENTIRE app, and the marker that switches it off is a single class
    attribute -- easy to copy onto a view whose author wanted "faster writes"
    and never read this file. So walk the live URLconf and pin the whole
    inventory explicitly.

    Adding another opt-out is not forbidden. It is required to be a decision
    someone writes down here, with the reason the view can be trusted to
    manage its own transactions.

    There are now TWO ways out, and this guard pins both. The other is
    `NON_ATOMIC_POST_PATHS` (-era), which exempts three email endpoints by
    literal path so they do not hold a Creator row lock through an SMTP call.
    That one is invisible to `wants_atomic_request` -- the middleware checks it
    separately -- so a URLconf walk alone would report those endpoints as
    atomic when they are not. Pinning the frozenset here is what keeps the
    inventory honest.
    """
    from dj.util.middleware import NON_ATOMIC_POST_PATHS
    from django.urls import URLPattern, URLResolver, get_resolver

    def walk(resolver, prefix=""):
        for pattern in resolver.url_patterns:
            if isinstance(pattern, URLResolver):
                yield from walk(pattern, prefix + str(pattern.pattern))
            elif isinstance(pattern, URLPattern):
                yield prefix + str(pattern.pattern), pattern.callback

    routes = list(walk(get_resolver()))
    # Guard against the walker silently finding nothing and the assertion
    # below passing vacuously.
    assert len(routes) > 100, f"only walked {len(routes)} routes"

    # URL functions decorated with ``@api_view`` are all named
    # ``WrappedAPIView``. Keep the route in the key: grouping by the wrapper's
    # module/qualname would silently merge two independent opt-outs in one
    # module and let one disappear from this inventory.
    opted_out = {}
    for route, callback in routes:
        cls = getattr(callback, "cls", None) or getattr(
            callback, "view_class", None)
        markers = (
            getattr(cls, "atomic_request", True) is False
            or DEFAULT_DB_ALIAS in getattr(callback, "_non_atomic_requests", ())
        )
        if markers:
            identity = (
                f"{cls.__module__}.{cls.__qualname__}" if cls
                else f"{callback.__module__}.{callback.__qualname__}"
            )
            opted_out[(identity, route)] = True

    identities = {identity for identity, _ in opted_out}
    assert identities == {
        # Paid comment routes claim their retry receipt before their
        # debit/create transaction, so duplicates can return promptly.
        "dj.apps.comments.views.CommentListCreateAPIView",
        "dj.apps.comments.views.CommentViewSet",
        "dj.apps.comments.views.ParentCommentListCreateAPIView",
        "dj.apps.comments.views.WrappedAPIView",
        # The page vote function opts out while it claims the idempotency key
        # before entering its own score/debit transaction.
        "dj.apps.g12f.views.zpage.WrappedAPIView",
        # Image generation owns its charge/persistence transaction so a
        # storage failure can write recovery after that transaction rolls
        # back; it must not sit inside AtomicMiddleware's doomed outer block.
        "dj.apps.openai.views.ImageView",
        "dj.apps.openai.views.PromptResponseViewSet",
        # This provider-backed paid endpoint owns its transaction boundary.
        "dj.apps.openai.views.PromptView",
        # The metered prompt  generates outside any transaction and
        # owns the short debit + receipt transaction, like the conversation
        # path it shares its metering with.
        "dj.apps.openai.views.MeteredPromptView",
        # Storytime's provider-backed paid endpoints use explicit claim and
        # transaction boundaries too.
        "dj.apps.storytime.views.ImageView",
        "dj.apps.storytime.views.PromptView",
        # Zcash admission is Redis-first and must reject a full bucket, cache
        # outage, or oversized body without first acquiring a Cloud SQL
        # connection. Challenge issuance performs no DB work; login owns an
        # explicit inner claim + provisioning + token transaction.
        "dj.apps.zauth.views.ZcashChallengeView",
        "dj.apps.zauth.views.ZcashLoginView",
        # Same reason as the two tuzis routes below: the paid AI translation
        # purchase ( P8) claims its idempotency key BEFORE the debit, and
        # that claim only blocks a concurrent duplicate if it is committed by
        # the time the duplicate arrives. It owns the debit + receipt
        # transaction explicitly and defers the job on commit.
        "dj.apps.g12f.views.translate.ZPageTranslationView",
        # The BULK translation purchase  claims its batch key the same
        # way, before the debit, and owns one explicit transaction for the
        # debit, the N charge records and the batch receipt. Its GET (the job
        # tray) is a read and writes nothing.
        "dj.apps.g12f.views.translate_batch.ZPageTranslationJobsView",
        # Page funding owns the same explicit idempotency and debit/receipt
        # transaction boundary as the other paid endpoints.
        "dj.apps.g12f.views.zpage.FundPageView",
        # These explicit retry-safe money routes commit the idempotency claim
        # before entering their own atomic balance/result transaction. Wrapping
        # them request-wide would make duplicates block on the uncommitted
        # unique row instead of returning request_in_progress.
        "dj.apps.tuzis.views.ConfirmedSubscribeView",
        "dj.apps.tuzis.views.IdempotentDonate2Z",
        # The paid encrypted chat request (dj.apps.e2ee) is the same shape:
        # it reuses the donation claim/transfer helpers and must commit its
        # claim before its own money transaction for the same reason.
        "dj.apps.e2ee.views.ChatRequestView",
        # Recovery uses explicit savepoints while it reconciles a single
        # subscription intent and its durable fence. It must stay outside the
        # request-wide transaction so an IntegrityError in one savepoint does
        # not poison the response or authorize a browser rotation falsely.
        "dj.apps.tuzis.views.SubscriptionIntentRecoveryView",
        # SDK purchase intents, the web checkout's shape plus the
        # money routes' claim: the Idempotency-Key claim must COMMIT before
        # the intent exists (a concurrent duplicate blocks on it) and the
        # Stripe Session call must run outside any DB transaction (same
        # reason /api/stripe/create-checkout-session is non-atomic). Every
        # write it makes is its own explicit block: claim/takeover, the
        # intent + CheckoutIntent + key binding (one atomic), fail, open,
        # and the single-statement finish/release; tests prove a mid-block
        # failure leaves no half-written intent, checkout or claim.
        "dj.apps.purchases.views.PurchaseIntentCreateView",
        # The signed Stripe webhook commits funding revalidation before
        # manual capture outside any DB transaction, then owns the atomic
        # fulfillment or durable captured-funds resolution. A request-wide
        # block would keep finance locks through provider I/O and roll back
        # an observed receipt when a later response asks Stripe to retry.
        "dj.apps.ztripe.views.stripe_webhook",
        # The opposite reason to every other entry here: this one owns no
        # transaction at all. Minting a key-transparency handle assertion reads
        # one row to decide handle eligibility and writes nothing -- there is
        # nothing for AtomicMiddleware to protect, and no reason to hold a
        # write transaction open across a Secret Manager fetch and an Ed25519
        # signature. dj/apps/ktauth/tests/test_app_shape.py pins that the app
        # has no models at all.
        "dj.apps.ktauth.views.HandleAssertionView",
    }, (
        "The set of views exempt from AtomicMiddleware's request-wide "
        "transaction changed. Every one of these takes full responsibility "
        "for its own transactions -- if that is deliberate, add it to this "
        "test with the reason.\n  "
        + "\n  ".join(f"{k}: {v}" for k, v in sorted(opted_out.items()))
    )

    # The class attribute has to survive `as_view()` and its wrappers
    # (`ViewSetMixin.as_view` sets `view.cls` before `csrf_exempt`, which uses
    # `wraps()`) on EVERY route the viewset is registered under -- list and
    # detail, each with its format-suffix variant. Finding it on only some of
    # them would mean the marker is reaching the middleware by accident.
    routes_found = [
        route for identity, route in opted_out
        if identity == "dj.apps.openai.views.PromptResponseViewSet"
    ]
    assert len(routes_found) >= 4, (
        "the opt-out did not survive as_view() on every route of the viewset; "
        f"found only {routes_found}"
    )
    assert ("dj.apps.tuzis.views.ConfirmedSubscribeView",
            "api/tuzis/subscribe-confirmed/<str:username>") in opted_out
    assert ("dj.apps.tuzis.views.IdempotentDonate2Z",
            "api/tuzis/donate-idempotent/<str:username>") in opted_out
    assert ("dj.apps.zauth.views.ZcashChallengeView",
            "api/auth/zcash/challenge/") in opted_out
    assert ("dj.apps.zauth.views.ZcashLoginView",
            "api/auth/zcash/login/") in opted_out
    assert ("dj.apps.ztripe.views.stripe_webhook",
            "api/stripe/webhook/") in opted_out

    # These are the two route-level function opt-outs. Both must remain
    # visible even though their callbacks expose the same generic wrapper
    # class name within their respective modules.
    assert {
        (identity, route) for identity, route in opted_out
        if identity.endswith(".WrappedAPIView")
    } == {
        (
            "dj.apps.comments.views.WrappedAPIView",
            "api/comments/<uuid:uuid>/vote/",
        ),
        (
            "dj.apps.g12f.views.zpage.WrappedAPIView",
            "api/zpage/<str:free2zaddr>/vote/",
        ),
    }

    # The second mechanism. Same contract: growing this set is a decision, not
    # a detail, and it does not show up in the URLconf walk above.
    assert NON_ATOMIC_POST_PATHS == {
        '/api/emails/reset-password',
        '/api/emails/resend',
        '/api/emails/add',
        '/api/stripe/create-checkout-session',
        '/api/stripe/webhook',
    }, (
        "The path-based exemptions from AtomicMiddleware changed. These "
        "endpoints run their writes in autocommit; each needs its own "
        "explicit transaction.atomic() and a reason recorded in "
        f"dj/util/middleware.py.\n  {sorted(NON_ATOMIC_POST_PATHS)}"
    )


def test_djangos_own_non_atomic_requests_marker_is_honoured(monkeypatch):
    """A plain view decorated the Django way opts out too.

    Two mechanisms that disagree about what "non atomic" means is how a view
    ends up believing it is exempt while still running in a transaction.
    """
    from dj.util import middleware

    @transaction.non_atomic_requests
    def view(request):  # pragma: no cover - never called
        raise AssertionError

    monkeypatch.setattr(middleware, "resolve_view", lambda request: view)
    assert middleware.wants_atomic_request(
        RequestFactory().post("/anything/")) is False


@pytest.mark.django_db
def test_a_failure_while_rendering_the_reply_unwinds_the_charge(
        creator_factory, monkeypatch, no_channel_layer):
    """Nothing may commit until the reply the user gets back is in hand.

    `AtomicMiddleware`'s request-wide transaction used to stay open through
    response rendering, so a serializer blowing up rolled the charge back with
    it. Opting this view out  removed that net: if the money commits
    before `.data` is evaluated, a transient failure there charges the user,
    500s, and they retry and pay twice. Found by the codex adversarial review.
    """
    from .serializers import PromptResponseSerializer

    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat",
        lambda ai_model, messages, **kwargs: iter(["answer"]),
    )
    user, _, conversation, client = _setup(creator_factory)

    def boom(self, instance):
        raise RuntimeError("serializer blew up after the writes")

    monkeypatch.setattr(PromptResponseSerializer, "to_representation", boom)

    with pytest.raises(RuntimeError):
        _post(client, conversation)

    assert balance(user) == Decimal("1000"), (
        "charged for a reply the user never received"
    )
    assert not PromptResponse.objects.filter(user_input="hello").exists()


@pytest.mark.django_db
def test_an_html_post_is_refused_before_anything_is_generated(
        creator_factory, monkeypatch, no_channel_layer):
    """`renderer_classes = [JSONRenderer]` closes the post-commit render window.

    DRF's default renderers include `BrowsableAPIRenderer`, and rendering
    happens AFTER the view returns -- i.e. after the money has committed. An
    `Accept: text/html` POST would therefore run templates and their queries
    with the charge already durable: a transient failure there is a 500 the
    client retries, paying twice.

    With the renderer pinned, content negotiation refuses that request in
    `APIView.initial()` -- before the provider call, before the charge. Costs
    the browsable API on this one endpoint, which the SvelteKit client does not
    use. Found by the review of.
    """
    called = []
    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat",
        lambda ai_model, messages, **kwargs: called.append(1) or iter(["answer"]),
    )
    user, _, conversation, client = _setup(creator_factory)

    response = client.post(
        f"/api/ai/conversations/{conversation.id}/promptresponses/",
        {"user_input": "hello"}, format="json", HTTP_ACCEPT="text/html",
    )

    assert response.status_code == 406, response.content
    assert not called, "the provider was called before content negotiation"
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_the_json_reply_is_unchanged(creator_factory, monkeypatch,
                                     no_channel_layer):
    """Pinning the renderer must not change what the client actually gets."""
    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat",
        lambda ai_model, messages, **kwargs: iter(["answer"]),
    )
    _, _, conversation, client = _setup(creator_factory)

    response = _post(client, conversation)

    assert response.status_code == 200, response.content
    assert response["Content-Type"] == "application/json"
    body = response.json()
    assert body["response"] == "answer"
    assert body["user_input"] == "hello"
    # Still the serializer's full field set -- the renderer decides encoding,
    # not content, so pinning it changes nothing the client can observe.
    from .serializers import PromptResponseSerializer
    assert set(body) == set(PromptResponseSerializer().fields)


def test_a_resolver_explosion_does_not_become_a_500(monkeypatch):
    """`resolve_view` must swallow everything, not just Resolver404.

    This runs on every write request in the app and the only thing its answer
    decides is whether to open a transaction. An unexpected exception escaping
    it turns a request that Django was going to handle -- a 404, a 400 --
    into a 500 raised out of middleware. Fail closed: keep the transaction,
    let the real error surface from Django's own resolution a moment later.
    Found by the review of.
    """
    from dj.util import middleware

    def boom(*args, **kwargs):
        raise ValueError("a resolver blew up in a way nobody predicted")

    monkeypatch.setattr(middleware, "resolve", boom)

    assert middleware.resolve_view(RequestFactory().post("/anything/")) is None
    assert middleware.wants_atomic_request(
        RequestFactory().post("/anything/")) is True
