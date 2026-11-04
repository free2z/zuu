"""WHO PAYS when a paid AI translation fails.

``test_translation_purchase.py`` proves a failed translation is refunded. That
was the whole of the money story, and it was the bug: a refunded job cost the
buyer exactly zero while the provider had already billed us for every output
token it generated. Measured on a 100,000-character zPage at gpt-4o's seeded
prices: **$0.4447 of provider spend, $0.0000 of revenue** -- and nothing in the
code bounded how often that could be repeated. (Realised loss so far is small:
six refunds, ~$0.60, in fourteen days of production. The missing bound is the
defect, not the bill.)

So this file is written around the four things that must now hold, in the order
they matter:

1. **A creator is NEVER charged for our own defect.** Not once, not after the
   tenth time, not when the provider spend was real and large. This is the
   assertion that has to survive every future change to the fault table, so it
   is made against a failure where the provider DID bill us -- a test where the
   meter is empty proves nothing about the rule.
2. **A refunded failure cannot be repeated indefinitely at zero cost to the
   caller.** Not by charging for it, but by refusing to sell the next one until
   the window clears.
3. **The concurrency cap is a real bound**, at whatever number it is set to.
4. **Work already paid for is not bought twice**, and the attributable case
   settles honestly and never above the quote.

Every number asserted here is a balance or a stored field, never a log line.
"""
import logging
import re
import uuid
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import (
    zPage, ZPageMutationActor, ZPageTranslation,
)
from dj.apps.g12f.models.zpage import (
    LANGUAGE_SOURCE_CREATOR,
    LANGUAGE_SOURCE_DETECTED,
)
from dj.apps.g12f.translation import charges, service, settlement
from dj.apps.g12f.translation.tasks import translate_zpage
from dj.apps.g12f.variants import content_digest
from dj.apps.openai.models import AIModel
from dj.apps.tuzis.models import IdempotencyKey


BODY = """\
# Free2Z is for creators

Support the work at [our docs](https://free2z.cash/docs) or read the
[reference][r]. It costs $5 a month.

Creators keep what they earn, and a zPage is the unit of publishing here. The
paragraphs below exist so this document plans into several fragments rather
than one, because "fragment seventeen failed and the first sixteen were thrown
away" is the shape of the loss under test.

A second paragraph of ordinary prose, long enough to be worth tokenizing and
short enough to read. Nothing in it is a link, a price or a tag, so the safety
invariants have nothing to complain about either way.

[r]: https://example.com/ref
"""


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
@pytest.fixture
def ai_model(db):
    """The catalogue row translation actually resolves to.

    Resolved through ``DEFAULT_MODEL_PREFERENCE`` rather than hardcoded, for
    the reason ``test_translation_purchase.py`` spells out: which row wins is
    not a constant, and pinning a name quietly stops testing the row
    production picks.
    """
    for entry in service.DEFAULT_MODEL_PREFERENCE:
        provider, _, model = entry.partition(":")
        row = AIModel.objects.filter(
            provider=provider, model=model, is_enabled=True
        ).first()
        if row is not None:
            return row
    raise AssertionError(
        "No enabled model in DEFAULT_MODEL_PREFERENCE -- translation cannot be "
        "sold at all, which is a product outage, not a test setup problem."
    )


@pytest.fixture(autouse=True)
def keyed_provider(monkeypatch):
    """Pretend every provider has an API key. No network I/O either way."""
    monkeypatch.setattr(service, "get_client", lambda provider: object())


@pytest.fixture(autouse=True)
def roomy_ceilings(settings):
    """Default the failure ceilings OUT of the way.

    Every test that is about a ceiling sets its own. Tests that are about
    settlement must not trip one by accident, or they would be asserting the
    cooldown's behaviour while claiming to assert the refund's.
    """
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER = 0
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PLATFORM = 0


class Provider:
    """A stand-in for ``stream_chat`` that records what it was asked."""

    def __init__(self, transform=None, error=None, lazy_error=None, empty=False,
                 mutate=None, fail_after=None, termination_reason=None):
        self.transform = transform
        self.error = error
        #Raised from the FIRST ITERATION of the stream rather than from the
        #call, which is how the real thing fails. ``f2z.ai.providers.
        #stream_chat`` is a generator function (it is all `yield from`), so the
        #outbound request is not made until the caller iterates -- a connection
        #refused, a DNS failure or an auth rejection therefore surfaces inside
        #`_complete`'s loop, not at the call. A stub that raises eagerly never
        #reaches the metering code at all, which made the first version of
        #`test_a_request_that_never_reached_the_provider_is_not_billable` pass
        #against the unfixed code. This distinction IS the test.
        self.lazy_error = lazy_error
        self.empty = empty
        self.mutate = mutate
        #Behave normally for this many fragments, then emit a runaway answer.
        #This is the shape the whole issue is about: the document fails on a
        #LATE fragment, so every earlier one was generated and billed.
        self.fail_after = fail_after
        self.termination_reason = termination_reason
        self.fragments = []

    def __call__(self, ai_model, messages, **kwargs):
        user = messages[1]["content"]
        fragment = user.split(">\n", 1)[1].rsplit("\n</fragment", 1)[0]
        if self.mutate is not None and not self.fragments:
            self.mutate()
        self.fragments.append(fragment)
        if self.error is not None:
            raise self.error
        if self.lazy_error is not None:
            def failing_stream():
                raise self.lazy_error
                yield ""  # pragma: no cover - makes this a generator

            return failing_stream()
        if self.fail_after is not None and len(self.fragments) > self.fail_after:
            text = fragment + ("padding " * 20000)
        elif self.empty:
            text = ""
        elif self.transform is not None:
            text = self.transform(fragment)
        else:
            text = f"[tr] {fragment}"

        class Stream:
            def __init__(stream_self):
                stream_self.termination_reason = (
                    self.termination_reason
                    or ("end_turn" if ai_model.provider == "anthropic" else "stop")
                )

            def __iter__(self):
                yield text

        return Stream()

    @property
    def calls(self):
        return len(self.fragments)

    @property
    def distinct(self):
        """How many DIFFERENT fragments this provider was asked to translate.

        Not the same as:attr:`calls` since: a fragment that trips the cap
        is retried once at a larger one, so one fragment can cost two calls. The
        carry-over is about not paying for the same WORK twice, so the fragment
        count is the measure -- and pinning `calls` instead is how a test ends up
        asserting today's retry policy while claiming to assert the cache.
        """
        return len(set(self.fragments))


@pytest.fixture
def provider(monkeypatch):
    fake = Provider()
    monkeypatch.setattr(service, "stream_chat", fake)
    return fake


@pytest.fixture
def deferred(monkeypatch):
    """Capture ``translate_zpage.defer`` instead of touching a real queue."""
    jobs = []
    monkeypatch.setattr(
        translate_zpage, "defer", lambda **kwargs: jobs.append(kwargs)
    )
    return jobs


def make_page(creator, **overrides):
    values = {
        "creator": creator,
        "free2zaddr": str(uuid.uuid4()),
        "title": "Free2Z is for creators",
        "description": "A short summary of the article.",
        "content": BODY,
        "source_language": "en",
        "is_published": True,
    }
    values.update(overrides)
    return zPage.objects.create(**values)


def client_for(creator):
    client = APIClient()
    client.force_authenticate(creator)
    return client


def translate_url(page, language="es"):
    return f"/api/zpage/{page.free2zaddr}/variants/{language}/translate/"


def quote_url(page, language="es"):
    return f"/api/zpage/{page.free2zaddr}/variants/{language}/translate/quote/"


def flush_on_commit():
    """Run the ``transaction.on_commit`` callbacks the test transaction eats."""
    from django.db import connection

    pending, connection.run_on_commit = connection.run_on_commit, []
    for entry in pending:
        entry[1]()


#Sentinel for "send no settlement policy at all", which is how a client that
#predates  buys. Distinct from ``None`` so a test cannot ask for it by
#accident.
LEGACY_CLIENT = object()


def buy(client, page, language="es",
        settlement_policy=settlement.METERED_POLICY_VERSION):
    """Quote then purchase, returning the purchase response.

    Declares the CURRENT settlement terms by default, because that is what the
    shipped client does. Pass ``settlement_policy=LEGACY_CLIENT`` to buy the way
    a page that still promises an unconditional refund buys.
    """
    quote = client.get(quote_url(page, language)).data
    body = {
        "expected_price": quote["price"],
        "source_digest": quote.get(
            "source_digest", content_digest(page.content)
        ),
    }
    if settlement_policy is not LEGACY_CLIENT:
        body["settlement_policy"] = settlement_policy
    response = client.post(
        translate_url(page, language),
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    flush_on_commit()
    response.quoted_price = quote["price"]
    return response


def run_job(response):
    return translate_zpage(job_id=response.data["job_id"])


def balance(creator):
    creator.refresh_from_db(fields=["tuzis"])
    return creator.tuzis


def assert_accounting_projection_is_bounded(sql):
    projection = sql.split(" FROM ", 1)[0].split("SELECT ", 1)[1]
    table_columns = set(re.findall(
        r'"tuzis_idempotencykey"\."([^"]+)"', projection
    ))
    assert table_columns <= {"id", "created_at", "response_body"}
    json_keys = re.findall(
        r'"response_body"\s*->\s*\'([^\']+)\'', projection
    )
    assert set(json_keys) <= {
        "status", "settled_at", "estimated_cost", "metered_cost",
        "requester_caused", "error", "source_digest", "started_at",
        "zpage_id",
    }
    assert not re.search(r'"response_body"(?!\s*->)', projection), (
        "a ceiling query selected the full response_body JSON blob"
    )


def record_for(response):
    return IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    ).response_body


def _openai_stream_client(replies):
    """Minimal SDK client for exercising the real adapter in paid workers."""
    calls = []

    class Completions:
        def create(self, **kwargs):
            calls.append(kwargs)
            text, reason = replies[len(calls) - 1]
            return iter([
                SimpleNamespace(choices=[SimpleNamespace(
                    delta=SimpleNamespace(content=text), finish_reason=None,
                )]),
                SimpleNamespace(choices=[SimpleNamespace(
                    delta=SimpleNamespace(content=None), finish_reason=reason,
                )]),
            ])

    client = SimpleNamespace(
        chat=SimpleNamespace(completions=Completions()), calls=calls,
    )
    return client


def _openai_translation_model(settings):
    model = AIModel.objects.create(
        provider="openai", model="issue-1909-gpt-4o",
        display_name="Issue 1909 GPT-4o", system_message="Translate.",
        max_tokens=128000, max_output_tokens=100, max_response_tokens=100,
        is_enabled=True,
    )
    settings.ZPAGE_TRANSLATION_MODELS = [
        f"{model.provider}:{model.model}"
    ]
    return model


def _anthropic_stream_client(text, reason):
    """Minimal Messages SDK client with a native terminal event."""
    class Stream:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def __iter__(self):
            yield SimpleNamespace(
                type="content_block_delta",
                delta=SimpleNamespace(type="text_delta", text=text),
            )
            yield SimpleNamespace(
                type="message_delta",
                delta=SimpleNamespace(stop_reason=reason),
            )

    return SimpleNamespace(
        messages=SimpleNamespace(stream=lambda **_kwargs: Stream())
    )


# ---------------------------------------------------------------------------
# 1. A creator is NEVER charged for our own defect
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_real_provider_length_signal_refunds_paid_worker_without_delivery(
    creator_factory, monkeypatch, settings
):
    """The real adapter's ``length`` reaches settlement below the count cap."""
    from f2z.ai import providers

    _openai_translation_model(settings)
    sdk = _openai_stream_client([("Hola mundo.", "length")])
    monkeypatch.setattr(providers, "get_client", lambda _provider: sdk)
    monkeypatch.setattr(service, "_output_cap", lambda *args: 100)
    monkeypatch.setattr(service, "provider_tokens", lambda _model, _text: 1)
    monkeypatch.setattr(service, "provider_message_tokens", lambda *_args: 3)
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(
        creator, title="Hola", description="", content="Hello world.\n"
    )
    before = balance(creator)
    response = buy(client_for(creator), page)
    assert response.status_code == 202

    run_job(response)

    body = record_for(response)
    assert sdk.calls and sdk.calls[0]["max_completion_tokens"] == 100
    assert body["status"] == charges.REFUNDED
    assert body["error"] == "output_truncated"
    assert body["provider_billed"] is True
    assert body["provider_calls"] == 1
    assert body["provider_input_tokens"] == 3
    assert body["provider_output_tokens"] == 1
    assert balance(creator) == before
    assert not ZPageTranslation.objects.filter(
        zpage=page, language="es"
    ).exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "provider,reason",
    [
        ("anthropic", "pause_turn"),
        ("anthropic", "tool_use"),
        ("anthropic", "refusal"),
        ("openai", "content_filter"),
    ],
)
def test_noncompletion_adapter_reasons_refund_safe_looking_partial_text(
    creator_factory, monkeypatch, settings, provider, reason
):
    """Unsupported continuation/refusal/filter outcomes are never delivered."""
    from f2z.ai import providers as provider_adapters

    model_name = f"issue-1909-{provider}"
    AIModel.objects.create(
        provider=provider, model=model_name,
        display_name=f"Issue 1909 {provider}", system_message="Translate.",
        max_tokens=128000, max_output_tokens=100, max_response_tokens=100,
        is_enabled=True,
    )
    settings.ZPAGE_TRANSLATION_MODELS = [f"{provider}:{model_name}"]
    # Enough replies for EVERY unit of the page (title + content). With only
    # one, the second unit's call raised IndexError inside the stub, which is
    # itself a `provider_error` refund -- so the OpenAI case passed with the
    # non-completion guard deleted (reviewer negative control on ).
    sdk = (
        _anthropic_stream_client("Hola mundo.", reason)
        if provider == "anthropic"
        else _openai_stream_client([("Hola mundo.", reason)] * 8)
    )
    monkeypatch.setattr(provider_adapters, "get_client", lambda _provider: sdk)
    monkeypatch.setattr(service, "_output_cap", lambda *args: 100)
    monkeypatch.setattr(service, "provider_tokens", lambda _model, _text: 1)
    monkeypatch.setattr(service, "provider_message_tokens", lambda *_args: 3)
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(
        creator, title="Hello", description="", content="Hello world.\n"
    )
    before = balance(creator)
    response = buy(client_for(creator), page)
    assert response.status_code == 202

    run_job(response)

    body = record_for(response)
    if provider != "anthropic":
        # The first non-completing reply fails the document: no further unit
        # is requested, and the stub was not exhausted into a fake failure.
        assert len(sdk.calls) == 1
    assert body["status"] == charges.REFUNDED
    assert body["error"] == "provider_error"
    assert body["provider_billed"] is True
    assert body["provider_calls"] == 1
    assert body["provider_output_tokens"] == 1
    assert balance(creator) == before
    assert not ZPageTranslation.objects.filter(
        zpage=page, language="es"
    ).exists()


@pytest.mark.django_db
def test_count_only_negative_control_would_deliver_provider_capped_text(
    creator_factory, monkeypatch, settings
):
    """Simulate the removed count-only rule and assert its paid-delivery bug."""
    from f2z.ai import providers

    _openai_translation_model(settings)
    sdk = _openai_stream_client([
        ("Hola mundo.", "length"), ("Descripción.", "stop"),
        ("Hola mundo.", "stop"),
    ])
    monkeypatch.setattr(providers, "get_client", lambda _provider: sdk)
    monkeypatch.setattr(service, "_output_cap", lambda *args: 100)
    monkeypatch.setattr(service, "provider_tokens", lambda _model, _text: 1)
    monkeypatch.setattr(service, "provider_message_tokens", lambda *_args: 3)
    monkeypatch.setattr(
        service, "_hit_output_token_limit", lambda _provider, _reason: False
    )
    monkeypatch.setattr(
        service, "_completed_termination_reason",
        lambda _provider, _reason: True,
    )
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(
        creator, title="Hello", description="Description.",
        content="Hello world.\n",
    )
    before = balance(creator)
    response = buy(client_for(creator), page)
    assert response.status_code == 202

    run_job(response)

    body = record_for(response)
    assert sdk.calls[0]["max_completion_tokens"] == 100
    assert body["status"] == charges.DELIVERED
    assert body["actual_cost"] > 0
    assert balance(creator) < before
    assert ZPageTranslation.objects.filter(
        zpage=page, language="es"
    ).exists()


@pytest.mark.django_db
def test_our_own_output_cap_never_charges_the_creator_however_much_we_spent(
    creator_factory, ai_model, monkeypatch, settings
):
    """THE non-negotiable one.

    A truncation is OUR defect, and  is the worked example: the six real
    refunds on production came from our reply-token count being in a different
    tokenizer from the cap the provider enforces, and from our own `<fragment>`
    envelope being echoed back into the reply. Neither is the article's fault.
    The provider still generated -- and billed us for -- every fragment up to
    the failure.

    The assertion that matters is not "it refunded"; that is the old test. It is
    that it refunded **while the meter was full**: the settlement saw real,
    billable provider spend, priced it, recorded it, and still credited back
    every last 2Z. Anything less and the next person to widen the fault table
    can charge for  without a test noticing.

    Also pinned: the forgiveness setting is turned OFF here, so not even the
    repetition escalation can reach a platform fault.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    assert response.status_code == 202

    # Succeed on the first fragments, then trip the cap -- so the spend we
    # refuse to bill for is a whole document's worth, not a rounding error.
    fake = Provider(fail_after=2)
    monkeypatch.setattr(service, "stream_chat", fake)

    run_job(response)

    body = record_for(response)
    assert body["error"] == "output_truncated"
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == "refunded"
    assert body["billed"] == "0.000"
    assert body["refunded"] == body["charged"]
    assert balance(creator) == before, "the creator paid nothing"
    assert Decimal(body["balance"]) == balance(creator), (
        "the record must report the balance after the credit, not before it"
    )
    assert not ZPageTranslation.objects.filter(zpage=page).exists()
    # The negative control's target: the meter was NOT empty. If this is ever
    # 0/False the test above has stopped proving anything.
    assert body["provider_billed"] is True
    assert body["provider_calls"] >= 3
    assert body["provider_output_tokens"] > 0
    assert body["metered_cost"] >= 1, (
        "the failure cost us real money and the record must say so, even "
        "though none of it was billed"
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    "code,expected_fault",
    [
        ("output_truncated", settlement.PLATFORM),
        ("timeout", settlement.PLATFORM),
        ("output_too_long", settlement.PLATFORM),
        ("model_unavailable", settlement.PLATFORM),
        ("mirror_disabled", settlement.PLATFORM),
        ("provenance_unwritten", settlement.PLATFORM),
        ("draft_variant_limit", settlement.PLATFORM),
        ("abandoned", settlement.PLATFORM),
        # Deleting the article, or it changing hands, is not in the terms the
        # buyer was shown (policy version 1 names only changing or publishing),
        # so it is never billed -- even with actor evidence. (Adversarial
        # review of.)
        ("zpage_gone", settlement.PLATFORM),
        ("not_owner", settlement.PLATFORM),
        ("provider_error", settlement.PROVIDER),
        ("empty_output", settlement.PROVIDER),
        ("url_not_in_source", settlement.PROVIDER),
        ("unsafe_url_scheme", settlement.PROVIDER),
        ("markup_not_in_source", settlement.PROVIDER),
        ("amount_not_in_source", settlement.PROVIDER),
        ("zip321_amount_not_in_source", settlement.PROVIDER),
    ],
)
def test_every_non_attributable_code_is_a_full_refund_even_when_billed(
    creator_factory, ai_model, code, expected_fault, settings
):
    """The fault table, exhaustively, against a FULL meter.

    One parametrisation per failure code we classify as ours or the provider's.
    Each is settled with a meter holding a whole document's worth of spend and
    with forgiveness disabled, so the only thing that can keep the charge at
    zero is the classification itself.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    record = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    )

    meter = settlement.SpendMeter()
    meter.record(input_tokens=29_066, output_tokens=37_208)
    fault = settlement.classify(code, prior_mutations=99)
    assert fault == expected_fault
    assert charges.settle_failure(
        record.pk, code=code, detail="under test", fault=fault,
        meter=meter, ai_model=ai_model,
    ) is True

    body = record_for(response)
    assert body["status"] == "refunded"
    assert body["billed"] == "0.000"
    assert body["refunded"] == body["charged"]
    assert body["provider_billed"] is True
    assert body["metered_cost"] > 0
    assert balance(creator) == before


def test_an_unclassified_failure_code_is_our_problem():
    """Fail-safe by default.

    A code nobody has classified is a failure mode nobody understands, and the
    creator is not the right person to fund our ignorance. Asserted separately
    from the table because it is the behaviour of the DEFAULT, which no entry
    in the table can demonstrate.
    """
    assert settlement.classify(
        "a_failure_mode_from_2027", prior_mutations=1000
    ) == settlement.PLATFORM


# ---------------------------------------------------------------------------
# 2. A refunded failure cannot be repeated indefinitely at zero cost
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_a_refunded_failure_cannot_be_repeated_indefinitely_for_free(
    creator_factory, ai_model, monkeypatch, settings
):
    """The drain  is about, closed.

    Before: buy -> fail -> full refund -> buy again, forever. Each iteration
    cost us a measured $0.4447 of provider spend on a max-size zPage and cost
    the caller nothing, and nothing in the code stopped the loop -- the only
    limiter was the generic ``user: 1200/minute`` DRF scope.

    After: the same loop burns a per-account ceiling on FAILED provider spend
    and is refused with a 429 that moves no money. The creator is still never
    charged for any of the failures -- the bound is a refusal, not a bill,
    because these failures are ours.

    Deliberately asserts the refusal is NOT immediate. A cooldown that fires on
    the first failure would be a different bug: an honest creator whose one
    translation failed must be able to try again.
    """
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER = 3
    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    before = balance(creator)
    client = client_for(creator)
    fake = Provider(fail_after=1)
    monkeypatch.setattr(service, "stream_chat", fake)

    refused = None
    completed = 0
    for _ in range(12):
        response = buy(client, page)
        if response.status_code == 429:
            refused = response
            break
        assert response.status_code == 202
        run_job(response)
        assert record_for(response)["status"] == "refunded"
        completed += 1

    assert refused is not None, (
        "the failure loop was never refused -- a refunded translation is still "
        "free to repeat, which is #1908"
    )
    assert refused.data["code"] == "translation_failure_cooldown"
    assert refused.data["retry_after"] > 0
    # The 429 body may only speak for THIS attempt. `failed_spend` counts
    # `charges.FAILED`, which includes `settled` rows, so "every failed
    # translation was refunded" was told precisely to the creator who had been
    # partially billed -- and there is no localized frontend case for this code,
    # so that English prose is what they read. (Reviewer of, finding 2.)
    assert "This attempt has not been charged" in refused.data["error"]
    assert "every failed translation was refunded" not in refused.data["error"]
    assert completed >= 1, (
        "the very first failure locked the account out; a creator whose one "
        "translation failed must be able to try again"
    )
    assert balance(creator) == before, (
        "every failure was ours, so every 2Z came back -- the bound is a "
        "refusal, never a charge"
    )
    calls_at_refusal = fake.calls
    # And the refusal really stops the spend: the refused purchase never
    # reached the provider.
    assert buy(client, page).status_code == 429
    assert fake.calls == calls_at_refusal


def test_the_shipped_configuration_has_both_ceilings_switched_ON(settings):
    """The control that stayed green when the mechanism was switched off.

    ``settings.py`` defines neither ceiling, so production runs the module
    defaults in ``charges`` -- and every ceiling test in this file overrides them
    through the autouse ``roomy_ceilings`` fixture. The reviewer of  set
    both defaults to 0, disabling the entire rate limit in production, and the
    suite stayed green: the mechanism this whole PR exists to add was unpinned in
    its shipped configuration.

    So this test deletes the overrides and asserts what a production process
    actually gets. Asserting the DEFAULT_ constants would not do it -- the
    getters are what the view calls, and a typo'd setting name reads through to
    them.
    """
    for name in (
        "ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER",
        "ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PLATFORM",
    ):
        if hasattr(settings, name):
            delattr(settings, name)
    assert charges.max_failed_spend_per_user() == 100
    assert charges.max_failed_spend_platform() == 2000
    # And a ceiling of 0 means OFF, so a nonzero assertion is the thing that
    # says "on". Spelled out so nobody reads the numbers above as arbitrary.
    assert charges.max_failed_spend_per_user() > 0
    assert charges.max_failed_spend_platform() > 0
    # The concurrency cap ships on too, at ten (it was one).
    assert charges.max_in_flight() == 10
    # And the forgiveness allowance is finite, or nothing is ever billable.
    assert 0 < settlement.forgiven_mutations() < 10


@pytest.mark.django_db
def test_the_platform_wide_ceiling_stops_selling_a_feature_that_is_failing(
    creator_factory, ai_model, monkeypatch, settings
):
    """A release that is failing everything, bounded.

    The shape a per-account cooldown cannot see: not one abusive account, but
    many honest creators each losing us a document, which is exactly what
    looked like from the ledger. This ceiling refuses the sale rather than take
    money for a translation that will not arrive -- for a creator who has never
    bought one before and has no failures of their own.
    """
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PLATFORM = 2
    burner = creator_factory(tuzis=Decimal("5000"))
    page = make_page(burner)
    fake = Provider(fail_after=1)
    monkeypatch.setattr(service, "stream_chat", fake)
    response = buy(client_for(burner), page)
    run_job(response)
    assert record_for(response)["status"] == "refunded"

    innocent = creator_factory(tuzis=Decimal("5000"))
    their_page = make_page(innocent)
    before = balance(innocent)
    refused = buy(client_for(innocent), their_page)

    assert refused.status_code == 429
    assert refused.data["code"] == "translation_failing"
    assert balance(innocent) == before


@pytest.mark.django_db
@pytest.mark.parametrize("ceiling", ["per_user", "platform"])
def test_worker_rechecks_failure_spend_before_provider_work(
    ceiling, creator_factory, ai_model, monkeypatch, settings
):
    """A batch bought before its first failure must stop at the worker too.

    Purchase-time checks cannot see failures that happen after admission. This
    reproduces the bulk shape from: both jobs are bought while the
    failure total is clear, the first spends provider money and fails, then
    the second is delivered to the worker. Its refund must not trigger one
    more provider call.
    """
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER = (
        1 if ceiling == "per_user" else 0
    )
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PLATFORM = (
        1 if ceiling == "platform" else 0
    )
    first_creator = creator_factory(tuzis=Decimal("5000"))
    second_creator = (
        first_creator
        if ceiling == "per_user"
        else creator_factory(tuzis=Decimal("5000"))
    )
    first_page = make_page(first_creator)
    second_page = make_page(second_creator)
    client_one = client_for(first_creator)
    client_two = client_for(second_creator)
    second_balance_before_purchase = balance(second_creator)

    first = buy(client_one, first_page)
    second = buy(client_two, second_page)
    assert first.status_code == second.status_code == 202

    fake = Provider(fail_after=1)
    monkeypatch.setattr(service, "stream_chat", fake)
    run_job(first)
    assert record_for(first)["status"] == "refunded"
    _, spend = charges.failed_spend(
        user=first_creator if ceiling == "per_user" else None
    )
    assert spend >= 1, "the first failure must establish the configured ceiling"

    calls_before_cooldown = fake.calls
    run_job(second)

    settled = record_for(second)
    assert settled["status"] == "refunded"
    assert settled["error"] == "failure_cooldown"
    assert settled["fault"] == settlement.PLATFORM
    assert settled["provider_billed"] is False
    assert fake.calls == calls_before_cooldown
    assert balance(second_creator) == second_balance_before_purchase


@pytest.mark.django_db
def test_a_failure_that_cost_us_nothing_counts_against_nobody(
    creator_factory, ai_model, monkeypatch, settings
):
    """"Charge them if openai charges us", read the other way.

    A job that failed before any generation -- the article was deleted, the
    model was flagged off, the mirror was down -- cost the provider nothing and
    cost us nothing. It must not be billed, and it must not consume the
    caller's failure budget either, or an outage in our own catalogue would
    lock creators out of a feature that never ran.
    """
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER = 1
    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    before = balance(creator)
    client = client_for(creator)

    for _ in range(4):
        response = buy(client, page)
        assert response.status_code == 202, response.data
        AIModel.objects.filter(pk=ai_model.pk).update(is_enabled=False)
        try:
            run_job(response)
        finally:
            AIModel.objects.filter(pk=ai_model.pk).update(is_enabled=True)
        body = record_for(response)
        assert body["error"] == "model_unavailable"
        assert body["provider_billed"] is False
        assert body["metered_cost"] == 0

    assert balance(creator) == before
    assert charges.failed_spend(user=creator) == (0, 0)


# ---------------------------------------------------------------------------
# 3. The concurrency cap
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_the_concurrent_job_cap_is_a_real_bound_at_whatever_it_is_set_to(
    creator_factory, ai_model, deferred, settings
):
    """One in-flight translation per account -- and two when it says two.

    ``has_in_flight`` has always refused a second concurrent job, but as a
    property of an ``.exists()`` call rather than as a stated cap.  asks
    for the cap to be a bound with a test on it, so this drives it at TWO as
    well: a test that only ever exercises the default cannot tell "the cap is
    one" from "there is no cap and a hardcoded refusal".

    No money moves on the refusal -- that is the other half of the assertion,
    and it is what makes this backpressure rather than a charge.
    """
    settings.ZPAGE_TRANSLATION_MAX_IN_FLIGHT = 2
    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    client = client_for(creator)

    first = buy(client, page, language="es")
    assert first.status_code == 202
    second = buy(client, page, language="fr")
    assert second.status_code == 202, second.data
    assert charges.in_flight_count(creator) == 2

    before = balance(creator)
    third = buy(client, page, language="it")
    assert third.status_code == 409
    assert third.data["code"] == "translation_in_progress"
    assert balance(creator) == before
    assert len(deferred) == 2, "the refused purchase enqueued nothing"

    settings.ZPAGE_TRANSLATION_MAX_IN_FLIGHT = 1
    fourth = buy(client, page, language="it")
    assert fourth.status_code == 409
    assert fourth.data["code"] == "translation_in_progress"


# ---------------------------------------------------------------------------
# 4. The attributable case, and never above the quote
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_two_purchases_for_one_target_are_refused_whatever_the_account_cap_is(
    creator_factory, ai_model, deferred, settings
):
    """codex adversarial review of, round 5, finding 1.

    Raise the account cap and two live jobs for the SAME article and language
    both pass their pre-flight checks. The first delivers; the second finds the
    draft changed and reports ``variant_changed``, which  attributes to the
    BUYER -- who edited nothing. Our own delivery moved the row.

    The attribution is only sound because this exclusion exists, so it is tested
    at a RAISED cap: at the default of one the account cap hides it, and a test
    that only ever runs at the default would let the day somebody raises it
    become the day creators are charged for our conflicts.
    """
    settings.ZPAGE_TRANSLATION_MAX_IN_FLIGHT = 5
    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    client = client_for(creator)

    first = buy(client, page, language="es")
    assert first.status_code == 202
    before = balance(creator)

    same_target = buy(client, page, language="es")
    assert same_target.status_code == 409
    assert same_target.data["code"] == "translation_in_progress"
    assert balance(creator) == before, "the refusal moved money"
    assert len(deferred) == 1

    # A DIFFERENT language is still allowed: this is a per-target exclusion, not
    # a second account cap wearing a different name.
    other = buy(client, page, language="fr")
    assert other.status_code == 202, other.data
    assert len(deferred) == 2


@pytest.mark.django_db
def test_the_same_target_stays_excluded_past_the_abandonment_deadline(
    creator_factory, ai_model, deferred, settings
):
    """codex adversarial review of, round 6, finding 1.

    ``_live_queued`` drops charges older than ``abandoned_after()``, which is
    right for the backpressure count and wrong for the target exclusion:
    ``translate_zpage`` requires only ``status == "queued"``, so a job that
    started late is still live past that cutoff. Excluding it re-opens the
    overlap at the one moment it is most likely -- a rolling deploy re-queuing
    old jobs -- and the resulting ``variant_changed`` is attributed to a buyer
    who edited nothing.

    Driven by ageing the charge past the deadline while leaving it ``queued``,
    which is exactly the state the reaper has not reached yet.
    """
    settings.ZPAGE_TRANSLATION_MAX_IN_FLIGHT = 5
    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)
    client = client_for(creator)

    first = buy(client, page, language="es")
    assert first.status_code == 202
    record = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=first.data["job_id"]
    )
    # `created_at` is auto_now_add, so it moves only by an explicit update.
    IdempotencyKey.objects.filter(pk=record.pk).update(
        created_at=timezone.now() - (charges.abandoned_after() * 2)
    )
    assert charges.in_flight_count(creator) == 0, (
        "the charge must be outside the backpressure window, or this test is "
        "asserting nothing about the difference between the two"
    )
    assert record_for(first)["status"] == "queued"

    before = balance(creator)
    again = buy(client, page, language="es")
    assert again.status_code == 409
    assert again.data["code"] == "translation_in_progress"
    assert balance(creator) == before
    assert len(deferred) == 1


@pytest.mark.django_db
def test_unattributed_queryset_source_edit_is_refunded(
    creator_factory, ai_model, monkeypatch
):
    """A queryset edit has no actor record and cannot be blamed on the buyer."""
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def edit():
        zPage.objects.filter(pk=page.pk).update(
            content=BODY + "\n\nA typo fixed while the model was working.\n"
        )

    monkeypatch.setattr(service, "stream_chat", Provider(mutate=edit))
    run_job(response)

    body = record_for(response)
    assert body["error"] == "source_changed"
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == "refunded"
    assert body["provider_billed"] is True, (
        "this regression needs provider spend to exercise settlement"
    )
    assert body["requester_caused"] is None, (
        "a queryset update has no trustworthy actor and must not be blamed on "
        "the buyer by default"
    )
    assert balance(creator) == before


@pytest.mark.django_db
def test_our_own_detector_relabelling_the_article_is_never_billed(
    creator_factory, ai_model, monkeypatch, settings
):
    """A detector relabel is a mutation, but its provenance is not its actor.

    With forgiveness disabled and prior mutations present, this test ensures
    historical ``language_source`` cannot make an unowned write chargeable.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def detector_relabels():
        # Exactly what `apply_detection` writes: the tag AND the provenance.
        zPage.objects.filter(pk=page.pk).update(
            source_language="es", language_source=LANGUAGE_SOURCE_DETECTED
        )

    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=detector_relabels)
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "same_language"
    assert body["fault"] == settlement.PLATFORM, (
        "our own detector's relabel was billed to the creator"
    )
    assert body["status"] == "refunded"
    assert body["billed"] == "0.000"
    assert balance(creator) == before
    assert body["requester_caused"] is None, (
        "language_source describes provenance, not the actor of this write"
    )
    # And it must not burn a forgiven slot either -- that is the half that bites
    # even though this refund was full.
    assert charges.requester_action_failures(creator) == 0


@pytest.mark.django_db
def test_a_relabel_without_a_write_actor_is_not_billed(
    creator_factory, ai_model, monkeypatch, settings
):
    """A provenance label alone does not identify the actor of this write."""
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def creator_relabels():
        zPage.objects.filter(pk=page.pk).update(
            source_language="es", language_source=LANGUAGE_SOURCE_CREATOR
        )

    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=creator_relabels)
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "same_language"
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == "refunded"
    assert body["requester_caused"] is None
    assert body["billed"] == "0.000"
    assert balance(creator) == before


@pytest.mark.django_db
def test_authenticated_api_edit_is_attributed_and_billed_after_allowance(
    creator_factory, ai_model, monkeypatch, settings
):
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def authenticated_edit():
        edit = client_for(creator).patch(
            f"/api/zpage/{page.free2zaddr}/",
            {"content": BODY + "\n\nAn authenticated creator edit."},
            format="json",
        )
        assert edit.status_code == 200

    monkeypatch.setattr(service, "stream_chat", Provider(mutate=authenticated_edit))
    run_job(response)

    body = record_for(response)
    assert body["error"] == "source_changed"
    assert body["requester_caused"] is True
    assert body["fault"] == settlement.REQUEST
    assert body["status"] == charges.SETTLED
    assert Decimal(body["billed"]) > 0
    assert balance(creator) < before
    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk,
        actor_id=creator.pk,
        action=ZPageMutationActor.SOURCE_CONTENT,
    ).exists()


@pytest.mark.django_db
def test_later_untracked_edit_invalidates_older_authenticated_actor_evidence(
    creator_factory, monkeypatch, settings
):
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def authenticated_then_untracked_edit():
        edit = client_for(creator).patch(
            f"/api/zpage/{page.free2zaddr}/",
            {"content": BODY + "\n\nTracked revision."},
            format="json",
        )
        assert edit.status_code == 200
        zPage.objects.filter(pk=page.pk).update(
            content=BODY + "\n\nLater untracked revision."
        )

    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=authenticated_then_untracked_edit)
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "source_changed"
    assert body["requester_caused"] is None
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == charges.REFUNDED
    assert balance(creator) == before


@pytest.mark.django_db
def test_an_undone_api_edit_cannot_take_credit_for_a_later_untracked_one(
    creator_factory, monkeypatch, settings
):
    """Only the LATEST recorded write may name the buyer.

    The buyer edits D -> X and back X -> D through the API; an untracked write
    then puts X back. The current state is X, and the buyer's FIRST row also
    says X -- but the buyer's last word was D, so nothing establishes that the
    buyer wrote the state this job died on.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    changed = BODY + "\n\nTracked revision."

    def edit_undo_then_untracked_redo():
        client = client_for(creator)
        for content in (changed, BODY):
            edit = client.patch(
                f"/api/zpage/{page.free2zaddr}/",
                {"content": content},
                format="json",
            )
            assert edit.status_code == 200
        zPage.objects.filter(pk=page.pk).update(content=changed)

    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=edit_undo_then_untracked_redo)
    )
    run_job(response)

    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk,
        actor_id=creator.pk,
        action=ZPageMutationActor.SOURCE_CONTENT,
        state_digest=content_digest(changed),
    ).exists(), "the stale row this test is about must actually exist"
    body = record_for(response)
    assert body["error"] == "source_changed"
    assert body["requester_caused"] is None
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == charges.REFUNDED
    assert balance(creator) == before


@pytest.mark.django_db
def test_a_deleted_draft_cannot_vouch_for_an_untracked_recreation(
    creator_factory, monkeypatch, settings
):
    """A buyer's VARIANT_DELETED ends what their earlier VARIANT_CONTENT said.

    The buyer creates draft X in the target language and deletes it, both
    through the API; something untracked then recreates exactly X. The buyer's
    content row still matches the observed digest, but the latest recorded
    write of that variant is their delete. (Codex review of.)
    """
    from dj.apps.g12f.translation import actors

    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    draft = {"title": "Hola", "description": "", "content": "Contenido"}

    def create_delete_then_untracked_recreate():
        client = client_for(creator)
        created = client.put(
            f"/api/zpage/{page.free2zaddr}/variants/es/",
            {**draft, "tags": []},
            format="json",
        )
        assert created.status_code == 200
        deleted = client.delete(f"/api/zpage/{page.free2zaddr}/variants/es/")
        assert deleted.status_code == 204
        ZPageTranslation.objects.create(zpage=page, language="es", **draft)

    monkeypatch.setattr(
        service, "stream_chat",
        Provider(mutate=create_delete_then_untracked_recreate),
    )
    run_job(response)

    observed = actors.observed_state_digest(
        code="variant_changed", zpage_id=page.pk, language="es"
    )
    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk, actor_id=creator.pk, language="es",
        action=ZPageMutationActor.VARIANT_CONTENT, state_digest=observed,
    ).exists(), "the stale row this test is about must match the observed state"
    body = record_for(response)
    assert body["error"] == "variant_changed"
    assert body["requester_caused"] is None
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == charges.REFUNDED
    assert balance(creator) == before


@pytest.mark.django_db
def test_a_buyer_save_after_the_abort_is_not_the_cause_of_it(
    creator_factory, monkeypatch, settings
):
    """Evidence is bounded by when delivery SAW the conflict (codex, ).

    An untracked write aborts delivery. The delivery transaction rolls back and
    releases the page lock; the buyer's autosave lands before attribution runs
    and is now both the latest row and the current state. It happened after
    the failure, so it cannot have caused it.
    """
    from dj.apps.g12f.translation import tasks

    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def untracked_edit():
        zPage.objects.filter(pk=page.pk).update(content=BODY + "\n\nStaff.")

    real_warning = tasks.logger.warning

    def buyer_saves_right_after_the_abort(message, *args, **kwargs):
        real_warning(message, *args, **kwargs)
        if "aborted at delivery" in message:
            saved = client_for(creator).patch(
                f"/api/zpage/{page.free2zaddr}/",
                {"content": BODY + "\n\nBuyer autosave."},
                format="json",
            )
            assert saved.status_code == 200

    monkeypatch.setattr(tasks.logger, "warning", buyer_saves_right_after_the_abort)
    monkeypatch.setattr(service, "stream_chat", Provider(mutate=untracked_edit))
    run_job(response)

    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk, actor_id=creator.pk,
        action=ZPageMutationActor.SOURCE_CONTENT,
        state_digest=content_digest(BODY + "\n\nBuyer autosave."),
    ).exists(), "the late buyer save this test is about must have happened"
    body = record_for(response)
    assert body["error"] == "source_changed"
    assert body["requester_caused"] is None
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == charges.REFUNDED
    assert balance(creator) == before


@pytest.mark.django_db
def test_conflict_digest_is_captured_before_rollback_and_late_autosave(
    creator_factory, monkeypatch, settings
):
    """A post-abort save cannot replace the digest delivery saw under lock."""
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    tracked = BODY + "\n\nBuyer revision X."
    untracked = BODY + "\n\nUntracked revision Y."

    def tracked_then_untracked_edit():
        saved = client_for(creator).patch(
            f"/api/zpage/{page.free2zaddr}/",
            {"content": tracked}, format="json",
        )
        assert saved.status_code == 200
        zPage.objects.filter(pk=page.pk).update(content=untracked)

    from dj.apps.g12f.translation import tasks

    real_warning = tasks.logger.warning

    def autosave_after_abort(message, *args, **kwargs):
        real_warning(message, *args, **kwargs)
        if "aborted at delivery" in message:
            saved = client_for(creator).patch(
                f"/api/zpage/{page.free2zaddr}/",
                {"content": tracked}, format="json",
            )
            assert saved.status_code == 200

    monkeypatch.setattr(
        tasks.logger, "warning", autosave_after_abort,
    )
    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=tracked_then_untracked_edit)
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "source_changed"
    assert body["requester_caused"] is None
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == charges.REFUNDED
    assert balance(creator) == before


@pytest.mark.django_db
def test_unpublish_invalidates_publish_attribution_for_untracked_republish(
    creator_factory, monkeypatch, settings
):
    from dj.apps.g12f.models import ZPageVariant

    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    client = client_for(creator)
    created = client.put(
        f"/api/zpage/{page.free2zaddr}/variants/es/",
        {"title": "Hola", "description": "", "content": "X", "tags": []},
        format="json",
    )
    assert created.status_code == 200
    before = balance(creator)
    response = buy(client, page)

    def publish_unpublish_then_untracked_republish():
        published = client.patch(
            f"/api/zpage/{page.free2zaddr}/variants/es/",
            {"is_published": True}, format="json",
        )
        assert published.status_code == 200
        unpublished = client.patch(
            f"/api/zpage/{page.free2zaddr}/variants/es/",
            {"is_published": False}, format="json",
        )
        assert unpublished.status_code == 200
        ZPageVariant.objects.filter(
            zpage=page, language="es",
        ).update(is_published=True, updated_at=timezone.now())

    monkeypatch.setattr(
        service, "stream_chat",
        Provider(mutate=publish_unpublish_then_untracked_republish),
    )
    run_job(response)

    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk,
        actor_id=creator.pk,
        action=ZPageMutationActor.VARIANT_UNPUBLISHED,
        language="es",
    ).exists()
    body = record_for(response)
    assert body["error"] == "variant_published"
    assert body["requester_caused"] is None
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == charges.REFUNDED
    assert balance(creator) == before


@pytest.mark.django_db
def test_edit_after_buyer_publish_is_attributed_while_variant_stays_published(
    creator_factory, monkeypatch, settings
):
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    client = client_for(creator)
    created = client.put(
        f"/api/zpage/{page.free2zaddr}/variants/es/",
        {"title": "Hola", "description": "", "content": "X", "tags": []},
        format="json",
    )
    assert created.status_code == 200
    response = buy(client, page)

    def publish_then_edit_content():
        published = client.patch(
            f"/api/zpage/{page.free2zaddr}/variants/es/",
            {"is_published": True}, format="json",
        )
        assert published.status_code == 200
        edited = client.patch(
            f"/api/zpage/{page.free2zaddr}/variants/es/",
            {"content": "Y"}, format="json",
        )
        assert edited.status_code == 200

    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=publish_then_edit_content)
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "variant_published"
    assert body["requester_caused"] is True
    assert body["fault"] == settlement.REQUEST
    assert body["status"] == charges.SETTLED


@pytest.mark.django_db
@pytest.mark.parametrize("lifecycle", ["unpublish", "delete"], ids=[
    "unpublish-then-edit-draft", "delete-then-recreate-draft",
])
def test_invalidated_publish_cannot_be_resurrected_by_a_later_draft_edit(
    lifecycle, creator_factory, monkeypatch, settings,
):
    """A draft edit cannot borrow a publish from before its lifecycle reset."""
    from dj.apps.g12f.models import ZPageVariant

    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    client = client_for(creator)
    path = f"/api/zpage/{page.free2zaddr}/variants/es/"
    created = client.put(
        path,
        {"title": "Hola", "description": "", "content": "X", "tags": []},
        format="json",
    )
    assert created.status_code == 200
    before = balance(creator)
    response = buy(client, page)

    def invalidate_then_edit_and_untracked_republish():
        published = client.patch(
            path, {"is_published": True}, format="json",
        )
        assert published.status_code == 200
        if lifecycle == "unpublish":
            invalidated = client.patch(
                path, {"is_published": False}, format="json",
            )
            assert invalidated.status_code == 200
            edited = client.patch(path, {"content": "Y"}, format="json")
            assert edited.status_code == 200
            invalidated_action = ZPageMutationActor.VARIANT_UNPUBLISHED
        else:
            invalidated = client.delete(path)
            assert invalidated.status_code == 204
            recreated = client.put(
                path,
                {"title": "Hola", "description": "", "content": "Y", "tags": []},
                format="json",
            )
            assert recreated.status_code == 200
            invalidated_action = ZPageMutationActor.VARIANT_DELETED
        assert ZPageMutationActor.objects.filter(
            zpage_id=page.pk,
            actor_id=creator.pk,
            action=invalidated_action,
            language="es",
        ).exists()
        ZPageVariant.objects.filter(
            zpage=page, language="es",
        ).update(is_published=True, updated_at=timezone.now())

    monkeypatch.setattr(
        service, "stream_chat",
        Provider(mutate=invalidate_then_edit_and_untracked_republish),
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "variant_published"
    assert body["requester_caused"] is None
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == charges.REFUNDED
    assert balance(creator) == before


@pytest.mark.django_db
def test_draft_edit_after_untracked_unpublish_does_not_vouch_for_republish(
    creator_factory, monkeypatch, settings,
):
    """A content row is not publication evidence on its own.

    The buyer publishes X; an untracked write unpublishes it; the buyer edits
    the now-DRAFT translation to Y; an untracked write republishes Y. The
    buyer's last authenticated action was a draft edit, so the publication
    conflict is not theirs, even though their earlier publish row exists and
    their content row matches the observed state.
    """
    from dj.apps.g12f.models import ZPageTranslation, ZPageVariant

    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    client = client_for(creator)
    path = f"/api/zpage/{page.free2zaddr}/variants/es/"
    created = client.put(
        path,
        {"title": "Hola", "description": "", "content": "X", "tags": []},
        format="json",
    )
    assert created.status_code == 200
    before = balance(creator)
    response = buy(client, page)

    def untracked_publish_state(is_published):
        # A queryset write fires no signal, so it bypasses the dual-write
        # mirror: set both tables, as an untracked SQL fix would.
        for model in (ZPageVariant, ZPageTranslation):
            model.objects.filter(zpage=page, language="es").update(
                is_published=is_published, updated_at=timezone.now(),
            )

    def untracked_unpublish_draft_edit_untracked_republish():
        published = client.patch(path, {"is_published": True}, format="json")
        assert published.status_code == 200
        untracked_publish_state(False)
        edited = client.patch(path, {"content": "Y"}, format="json")
        assert edited.status_code == 200
        untracked_publish_state(True)

    monkeypatch.setattr(
        service, "stream_chat",
        Provider(mutate=untracked_unpublish_draft_edit_untracked_republish),
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "variant_published"
    assert body["requester_caused"] is None
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == charges.REFUNDED
    assert balance(creator) == before


@pytest.mark.django_db
def test_actor_prune_is_bounded_and_keeps_evidence_inside_retention(
    creator_factory, settings,
):
    from dj.apps.g12f.translation.actors import prune_mutation_actors

    settings.ZPAGE_TRANSLATION_FAILURE_WINDOW = 3600
    settings.ZPAGE_TRANSLATION_ABANDONED_HARD_AFTER = 6 * 3600
    creator = creator_factory()
    page = make_page(creator)
    now = timezone.now()
    stale = ZPageMutationActor.objects.create(
        zpage_id=page.pk, actor_id=creator.pk,
        action=ZPageMutationActor.SOURCE_CONTENT,
    )
    inside = ZPageMutationActor.objects.create(
        zpage_id=page.pk, actor_id=creator.pk,
        action=ZPageMutationActor.SOURCE_CONTENT,
    )
    retention = timedelta(hours=7)
    ZPageMutationActor.objects.filter(pk=stale.pk).update(
        occurred_at=now - retention - timedelta(seconds=1)
    )
    ZPageMutationActor.objects.filter(pk=inside.pk).update(
        occurred_at=now - retention + timedelta(seconds=1)
    )

    assert prune_mutation_actors(limit=1, now=now) == 1
    assert not ZPageMutationActor.objects.filter(pk=stale.pk).exists()
    assert ZPageMutationActor.objects.filter(pk=inside.pk).exists()


def test_translation_reaper_keeps_refunds_when_actor_prune_is_contended(
    monkeypatch,
):
    from django.db import DatabaseError

    from dj.apps.g12f.translation import actors, charges, tasks

    monkeypatch.setattr(charges, "reap_abandoned", lambda: 2)

    def prune_contended():
        raise DatabaseError("prune statement timed out")

    monkeypatch.setattr(actors, "prune_mutation_actors", prune_contended)
    assert tasks.reap_translation_charges(timestamp=0) == 2


@pytest.mark.django_db
def test_authenticated_variant_and_delete_writes_leave_surviving_actor_evidence(
    creator_factory,
):
    creator = creator_factory()
    page = make_page(creator)
    client = client_for(creator)

    created = client.put(
        f"/api/zpage/{page.free2zaddr}/variants/es/",
        {
            "title": "Hola", "content": "Contenido", "description": "",
            "tags": [],
        },
        format="json",
    )
    assert created.status_code == 200
    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk,
        actor_id=creator.pk,
        action=ZPageMutationActor.VARIANT_CONTENT,
        language="es",
    ).exists()

    published = client.patch(
        f"/api/zpage/{page.free2zaddr}/variants/es/",
        {"is_published": True},
        format="json",
    )
    assert published.status_code == 200
    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk,
        actor_id=creator.pk,
        action=ZPageMutationActor.VARIANT_PUBLISHED,
        language="es",
    ).exists()

    deleted = client.delete(
        f"/api/zpage/{page.free2zaddr}/variants/es/"
    )
    assert deleted.status_code == 204
    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk,
        actor_id=creator.pk,
        action=ZPageMutationActor.VARIANT_DELETED,
        language="es",
    ).exists()

    relabeled = client.patch(
        f"/api/zpage/{page.free2zaddr}/",
        {"source_language": "fr"},
        format="json",
    )
    assert relabeled.status_code == 200
    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk,
        actor_id=creator.pk,
        action=ZPageMutationActor.SOURCE_LANGUAGE,
        language="fr",
    ).exists()

    page_deleted = client.delete(f"/api/zpage/{page.free2zaddr}/")
    assert page_deleted.status_code == 204
    assert not zPage.objects.filter(pk=page.pk).exists()
    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk,
        actor_id=creator.pk,
        action=ZPageMutationActor.PAGE_DELETED,
    ).exists(), "the actor row must survive the deleted zPage"


@pytest.mark.django_db
def test_authenticated_target_variant_edit_is_attributed_after_allowance(
    creator_factory, monkeypatch, settings
):
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    client = client_for(creator)
    initial = client.put(
        f"/api/zpage/{page.free2zaddr}/variants/es/",
        {
            "title": "Hola", "content": "Contenido", "description": "",
            "tags": [],
        },
        format="json",
    )
    assert initial.status_code == 200
    response = buy(client, page)

    def authenticated_variant_edit():
        edit = client.patch(
            f"/api/zpage/{page.free2zaddr}/variants/es/",
            {"content": "Contenido corregido"},
            format="json",
        )
        assert edit.status_code == 200

    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=authenticated_variant_edit)
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "variant_changed"
    assert body["requester_caused"] is True
    assert body["fault"] == settlement.REQUEST
    assert body["status"] == charges.SETTLED


@pytest.mark.django_db
def test_authenticated_page_delete_survives_but_is_never_billed(
    creator_factory, monkeypatch, settings
):
    """The actor row survives the cascade; the terms still refund the delete.

    Policy version 1 names changing or publishing as the only non-refundable
    case. A buyer who deletes their own article mid-translation is not billed,
    whatever the repetition count and whatever evidence we hold.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def authenticated_delete():
        deleted = client_for(creator).delete(
            f"/api/zpage/{page.free2zaddr}/"
        )
        assert deleted.status_code == 204

    monkeypatch.setattr(service, "stream_chat", Provider(mutate=authenticated_delete))
    run_job(response)

    body = record_for(response)
    assert body["error"] == "zpage_gone"
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == charges.REFUNDED
    assert balance(creator) == before, "a deleted article is refunded in full"
    assert ZPageMutationActor.objects.filter(
        zpage_id=page.pk,
        actor_id=creator.pk,
        action=ZPageMutationActor.PAGE_DELETED,
    ).exists()


def test_a_code_needing_evidence_is_ours_when_nobody_supplied_any():
    """The default for the gate is fail-safe, and that is what makes it safe.

    A caller that forgets to establish who caused a
    ``NEEDS_REQUESTER_EVIDENCE`` code gets a full refund, not a charge -- so
    adding a code to that set can never accidentally start billing for it.
    """
    assert settlement.NEEDS_REQUESTER_EVIDENCE == {
        "source_changed", "variant_changed", "variant_published",
        "same_language",
    }
    for code in settlement.NEEDS_REQUESTER_EVIDENCE:
        assert settlement.classify(code, prior_mutations=99) == settlement.PLATFORM
        assert settlement.classify(
            code, prior_mutations=99, requester_caused=False
        ) == settlement.PLATFORM
        assert settlement.classify(
            code, prior_mutations=99, requester_caused=True
        ) == settlement.REQUEST
    # Evidence is not consent: deleting the article or losing it to another
    # owner is outside the terms the buyer was shown, so even a buyer-named
    # actor row cannot bill it. (Adversarial review of.)
    for code in ("zpage_gone", "not_owner"):
        assert settlement.classify(
            code, prior_mutations=99, requester_caused=True
        ) == settlement.PLATFORM
    # `requester_caused=False` overrides repetition for EVERY attributable code,
    # not just the ones that need evidence today.
    for code in ("source_changed", "variant_changed", "variant_published"):
        assert settlement.classify(
            code, prior_mutations=99, requester_caused=False
        ) == settlement.PLATFORM


@pytest.mark.django_db
def test_an_our_fault_occurrence_does_not_burn_a_forgiven_slot(
    creator_factory, ai_model, settings
):
    """Reviewer of, finding 1, second half — and it is the worse half.

    The allowance counter used to count the error CODE, so an occurrence we
    caused consumed one of the creator's two forgiven mutations and brought
    their next genuine one forward into being billable. That happens even when
    the failure it came from was refunded in full, which is why it is worse than
    the headline case: nothing on the record shows the creator anything went
    against them.

    Counting the stored adjudication instead is the fix, and this drives it
    directly: two of OUR occurrences must leave the allowance untouched.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 2
    creator = creator_factory(tuzis=Decimal("5000"))
    page = make_page(creator)

    meter = settlement.SpendMeter()
    meter.record(input_tokens=5_000, output_tokens=6_000)
    for _ in range(2):
        response = buy(client_for(creator), page)
        record = IdempotencyKey.objects.get(
            scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
        )
        assert charges.settle_failure(
            record.pk, code="same_language", detail="our detector did it",
            fault=settlement.classify(
                "same_language", prior_mutations=0, requester_caused=False
            ),
            meter=meter, ai_model=ai_model, requester_caused=False,
        ) is True
        assert record_for(response)["status"] == "refunded"

    assert charges.requester_action_failures(creator) == 0, (
        "our own occurrences consumed the creator's forgiveness allowance"
    )
    #...and one the creator DID cause is counted, or the counter is just off.
    response = buy(client_for(creator), page)
    record = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    )
    assert charges.settle_failure(
        record.pk, code="source_changed", detail="they did it",
        fault=settlement.PLATFORM, meter=meter, ai_model=ai_model,
        requester_caused=True,
    ) is True
    assert charges.requester_action_failures(creator) == 1


@pytest.mark.django_db
def test_a_staff_edit_through_the_admin_is_never_billed_to_the_creator(
    creator_factory, ai_model, monkeypatch, settings
):
    """codex adversarial review of the  review fixes, finding 1.

    ``PageAdmin`` lets staff edit a creator's article and
    ``ZPageTranslationAdmin`` lets them edit and publish its translations. A
    staff correction landing inside the generation window produces
    ``source_changed`` with a full meter and the buyer named as the cause --
    past the allowance, a creator paying for our moderator's edit.

    ``django.contrib.admin``'s own ``LogEntry`` is the actor record and it is
    already written on every admin form save, so the check costs a query and no
    migration.
    """
    from django.contrib.admin.models import CHANGE, LogEntry
    from django.contrib.contenttypes.models import ContentType

    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    staff = creator_factory(tuzis=Decimal("0"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def staff_edits_through_the_admin():
        zPage.objects.filter(pk=page.pk).update(
            content=BODY + "\n\nA moderator fixed a typo.\n"
        )
        LogEntry.objects.create(
            user_id=staff.pk,
            content_type=ContentType.objects.get_for_model(zPage),
            object_id=str(page.pk),
            object_repr=str(page)[:200],
            action_flag=CHANGE,
            change_message="moderation edit",
        )

    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=staff_edits_through_the_admin)
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "source_changed"
    assert body["fault"] == settlement.PLATFORM, (
        "a staff edit through the admin was billed to the creator"
    )
    assert body["status"] == "refunded"
    assert body["billed"] == "0.000"
    assert body["requester_caused"] is False
    assert balance(creator) == before
    #...and it does not consume the creator's allowance either.
    assert charges.requester_action_failures(creator, zpage_id=page.pk) == 0


@pytest.mark.django_db
def test_queryset_edits_remain_unattributed_across_repeated_failures(
    creator_factory, ai_model, monkeypatch, settings
):
    """Repeating an unattributed write cannot turn it into a buyer action.

    A separate direct counter test pins article scoping for records with
    explicit adjudication. This end-to-end path pins the money boundary: raw
    queryset writes stay unknown even when a creator repeats them.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 1
    creator = creator_factory(tuzis=Decimal("5000"))
    first_page = make_page(creator)
    second_page = make_page(creator)
    before = balance(creator)

    # Each edit must be DISTINCT: the worker compares the live body against the
    # digest quoted for THIS purchase, so writing the same bytes a second time
    # is not a change at all and the job delivers instead of failing.
    edits = {"n": 0}

    def mutate_during_the_job(page):
        def edit():
            edits["n"] += 1
            zPage.objects.filter(pk=page.pk).update(
                content=BODY + f"\n\nEdit {edits['n']} during a paid job.\n"
            )
        return edit

    outcomes = []
    for page in (first_page, second_page):
        response = buy(client_for(creator), page)
        monkeypatch.setattr(
            service, "stream_chat", Provider(mutate=mutate_during_the_job(page))
        )
        run_job(response)
        body = record_for(response)
        assert body["error"] == "source_changed"
        assert body["provider_billed"] is True, (
            "the meter must be full, or forgiveness is not what is being tested"
        )
        assert body["requester_caused"] is None
        outcomes.append(body)

    assert outcomes[0]["status"] == "refunded", (
        "the first mutation on an article is inside the allowance"
    )
    assert outcomes[1]["status"] == "refunded", (
        "a mutation on a DIFFERENT article consumed this article's allowance -- "
        "the purchase screen promises the exception is about THIS article"
    )
    assert balance(creator) == before

    # A second unrecorded mutation is still ambiguous and cannot be billed.
    response = buy(client_for(creator), first_page)
    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=mutate_during_the_job(first_page))
    )
    run_job(response)
    billed_body = record_for(response)
    assert billed_body["status"] == "refunded"
    assert billed_body["requester_caused"] is None


@pytest.mark.django_db
def test_the_forgiveness_allowance_is_scoped_to_the_article_the_screen_named(
    creator_factory, ai_model, settings
):
    """codex adversarial review of the  review fixes, finding 2.

    The purchase screen says "unless you keep changing THIS ARTICLE, or changing
    or publishing ITS translation". The counter was account-wide, so one
    mutation each on three different articles inside an hour billed the third --
    a creator who never repeated anything, told otherwise on the screen they
    consented from, and sending policy version 1 as confirmation of the narrower
    terms.

    The anti-abuse bound does not rest on this counter: the per-account
    failed-spend ceiling is account-wide and is what stops article-cycling.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 1
    creator = creator_factory(tuzis=Decimal("5000"))
    first_page = make_page(creator)
    second_page = make_page(creator)
    meter = settlement.SpendMeter()
    meter.record(input_tokens=5_000, output_tokens=6_000)

    def record_a_mutation(page, language):
        response = buy(client_for(creator), page, language=language)
        record = IdempotencyKey.objects.get(
            scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
        )
        assert charges.settle_failure(
            record.pk, code="source_changed", detail="they edited it",
            fault=settlement.PLATFORM, meter=meter, ai_model=ai_model,
            requester_caused=True,
        ) is True
        # Settled records can carry large reusable fragments. The ceilings
        # need only their accounting metadata, not this payload.
        body = IdempotencyKey.objects.get(pk=record.pk).response_body
        body["_fragments"] = {"body": "x" * settlement.MAX_CARRIED_CHARS}
        IdempotencyKey.objects.filter(pk=record.pk).update(response_body=body)

    record_a_mutation(first_page, "es")
    record_a_mutation(first_page, "fr")

    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    with CaptureQueriesContext(connection) as captured:
        first_page_failures = charges.requester_action_failures(
            creator, zpage_id=first_page.pk
        )
        second_page_failures = charges.requester_action_failures(
            creator, zpage_id=second_page.pk
        )
        account_failures = charges.requester_action_failures(creator)
        failures, spend = charges.failed_spend(user=creator)

    # The two sequential paid attempts have disjoint mutation windows and are
    # both scoped to the first article...
    assert first_page_failures == 2
    #...and the second article, which they have never done this to, is not.
    assert second_page_failures == 0
    # The account-wide view still sees both, which is what the spend ceiling
    # and any future abuse review read.
    assert account_failures == 2
    assert failures == 2
    assert spend > 0
    accounting_queries = [
        query["sql"] for query in captured
        if 'FROM "tuzis_idempotencykey"' in query["sql"]
    ]
    assert len(accounting_queries) == 4
    for query in accounting_queries:
        assert_accounting_projection_is_bounded(query)


def test_projection_guard_rejects_the_original_full_body_scan():
    old_scan = (
        'SELECT "tuzis_idempotencykey"."id", '
        '"tuzis_idempotencykey"."response_body" '
        'FROM "tuzis_idempotencykey"'
    )
    with pytest.raises(AssertionError, match="full response_body JSON blob"):
        assert_accounting_projection_is_bounded(old_scan)


@pytest.mark.django_db
def test_requester_action_failure_counter_requires_native_json_true(
    creator_factory,
):
    creator = creator_factory()
    page = make_page(creator)
    values = [True, False, "true", 1, None]
    for value in values:
        response = buy(client_for(creator), page)
        record = IdempotencyKey.objects.get(
            scope=charges.SCOPE,
            response_body__job_id=response.data["job_id"],
        )
        body = record.response_body.copy()
        body.update({
            "status": charges.REFUNDED,
            "provider_billed": True,
            "requester_caused": value,
            "error": "source_changed",
            "settled_at": timezone.now().isoformat(),
            "zpage_id": page.pk,
        })
        IdempotencyKey.objects.filter(pk=record.pk).update(response_body=body)

    assert charges.requester_action_failures(creator, zpage_id=page.pk) == 1


@pytest.mark.django_db
def test_repeatedly_moving_the_target_without_actor_record_is_refunded(
    creator_factory, ai_model, monkeypatch, settings
):
    """A repeated queryset edit still lacks positive actor evidence."""
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def edit():
        zPage.objects.filter(pk=page.pk).update(
            content=BODY + "\n\nAnd again, and again, and again.\n"
        )

    monkeypatch.setattr(service, "stream_chat", Provider(mutate=edit))
    run_job(response)

    body = record_for(response)
    assert body["error"] == "source_changed"
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == "refunded"
    assert body["requester_caused"] is None
    assert body["billed"] == "0.000"
    assert balance(creator) == before
    # The record's own `balance` must be the balance AFTER the settlement. The
    # status endpoint and the idempotent replay both report this field, and the
    # first draft of `settle_failure` dropped it -- leaving the purchase-time
    # figure, which tells a creator their balance is the one they had before the
    # credit landed. Found by `ruff` (unused variable), not by a test, which is
    # why there is now a test.
    assert Decimal(body["balance"]) == balance(creator)
    assert not ZPageTranslation.objects.filter(zpage=page).exists(), (
        "settled is still a failure: nothing is delivered"
    )


@pytest.mark.django_db
def test_a_purchase_made_under_the_old_promise_is_always_refunded_in_full(
    creator_factory, ai_model, monkeypatch, settings
):
    """codex adversarial review of, round 3, its riskiest line.

    An editor tab opened before this deploy still says "if it fails for any
    reason, every 2Z is credited straight back", and it can still buy. Stamping
    the SERVER's policy version at purchase would charge that creator against a
    promise they were never shown. So the version travels with the purchase, and
    a purchase that declares none is settled under the terms it displayed.

    Same job, same fault, same spend as
    ``test_repeatedly_moving_the_target_without_actor_record_is_refunded`` --
    only the declared policy differs.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page, settlement_policy=LEGACY_CLIENT)
    assert record_for(response)["settlement_policy"] is None

    def edit():
        zPage.objects.filter(pk=page.pk).update(
            content=BODY + "\n\nAnd again, and again, and again.\n"
        )

    monkeypatch.setattr(service, "stream_chat", Provider(mutate=edit))
    run_job(response)

    body = record_for(response)
    # Provider work is present, but the write has no trusted actor record...
    assert body["error"] == "source_changed"
    assert body["provider_billed"] is True
    assert body["metered_cost"] > 0
    #...and it is still refunded in full, because of the terms they saw.
    assert body["status"] == "refunded"
    assert body["billed"] == "0.000"
    assert balance(creator) == before


@pytest.mark.django_db
def test_a_nonsense_declared_policy_is_treated_as_the_old_promise(
    creator_factory, ai_model, monkeypatch, settings
):
    """Fail-safe on the field itself, not just on its absence.

    ``0``, or anything below the current version, is a client that did not show
    these terms. The gate is a floor, so it cannot be satisfied by sending
    something that merely parses.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page, settlement_policy=0)

    def edit():
        zPage.objects.filter(pk=page.pk).update(
            content=BODY + "\n\nEdited again.\n"
        )

    monkeypatch.setattr(service, "stream_chat", Provider(mutate=edit))
    run_job(response)

    body = record_for(response)
    assert body["status"] == "refunded"
    assert body["billed"] == "0.000"
    assert balance(creator) == before
    assert settlement.may_bill_under_policy(None) is False
    assert settlement.may_bill_under_policy("not a number") is False
    assert settlement.may_bill_under_policy(0) is False
    assert settlement.may_bill_under_policy(
        settlement.METERED_POLICY_VERSION
    ) is True


@pytest.mark.django_db
def test_publishing_the_target_without_actor_record_is_refunded(
    creator_factory, ai_model, monkeypatch, settings
):
    """Publication is a mutation, but this write path has no trusted actor."""
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    assert settlement.is_requester_action("variant_published"), (
        "publishing the target during generation is the buyer's action"
    )
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def publish_the_target():
        ZPageTranslation.objects.create(
            zpage=page, language="es", title="Publicado",
            description="Ya publicado.", content="Contenido publicado.",
            is_published=True,
        )

    monkeypatch.setattr(
        service, "stream_chat", Provider(mutate=publish_the_target)
    )
    run_job(response)

    body = record_for(response)
    assert body["error"] == "variant_published"
    assert body["fault"] == settlement.PLATFORM
    assert body["status"] == "refunded"
    assert body["requester_caused"] is None
    assert body["billed"] == "0.000"
    assert balance(creator) == before


def test_the_fragment_cache_key_is_scoped_to_the_generation_pipeline():
    """codex adversarial review of, round 3, finding 4.

    A deploy that fixes the prompt must not leave a creator's retry serving the
    fragments the BROKEN prompt produced -- ``translate_unit`` returns a cached
    fragment before it reaches the corrected path at all, so a wrong translation
    that happens to pass the document safety checks survives the fix and is
    delivered for payment.

    Asserted as a property of the KEY, not of the constant: bumping the version
    must change the identity of every fragment.
    """
    def key():
        return settlement.fragment_key(
            ai_model_id=7, source_language="en", target_language="es",
            context="body", text="Some words to translate.",
        )

    before = key()
    original = settlement.GENERATION_POLICY_VERSION
    try:
        settlement.GENERATION_POLICY_VERSION = original + 1
        assert key() != before, (
            "bumping the generation policy must invalidate every carried "
            "fragment, or a prompt fix cannot take effect on a retry"
        )
    finally:
        settlement.GENERATION_POLICY_VERSION = original
    assert key() == before


@pytest.mark.django_db
def test_the_spend_ceiling_counts_our_real_loss_not_the_discounted_charge(
    creator_factory, ai_model, monkeypatch, settings
):
    """codex adversarial review of, round 4, finding 1.

    The charge figure is deliberately discounted so an estimate can never
    over-bill. Summing THAT into the loss budget makes the budget let through as
    much extra spend as the discount -- a "2,000 2Z" platform ceiling quietly
    worth 6,400. Two numbers, two directions of error, and the ceiling must use
    the honest one.
    """
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER = 0
    creator = creator_factory(tuzis=Decimal("2000"))
    page = make_page(creator, content=CHAINED_BODY)
    monkeypatch.setattr(service, "stream_chat", Provider(fail_after=2))
    response = buy(client_for(creator), page)
    run_job(response)

    body = record_for(response)
    assert body["status"] == "refunded"
    assert body["estimated_cost"] > body["metered_cost"], (
        "the loss estimate must not be the deliberately-conservative charge"
    )
    failures, spend = charges.failed_spend(user=creator)
    assert failures == 1
    assert spend == body["estimated_cost"], (
        "the ceiling is summed from what the failure cost US"
    )


@pytest.mark.django_db
def test_relabelling_before_the_job_starts_never_reaches_the_provider(
    creator_factory, ai_model, monkeypatch, settings
):
    """codex adversarial review of, round 4, finding 3.

    ``same_language`` and ``variant_changed`` were checked only under the
    delivery lock. That was fine while every failure refunded in full -- the
    cost of finding out late was one provider call we ate. It is no longer only
    ours to eat: past the forgiveness allowance the creator would be charged for
    a whole document that was ALREADY undeliverable when the job started.

    Money must never be taken for work that was avoidable at the point we chose
    to do it, so the answer is to not do the work.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)

    # Relabelled between the purchase and the worker starting.
    zPage.objects.filter(pk=page.pk).update(source_language="es")
    fake = Provider()
    monkeypatch.setattr(service, "stream_chat", fake)
    run_job(response)

    body = record_for(response)
    assert body["error"] == "same_language"
    assert fake.calls == 0, (
        "a whole document was generated for a job already known to be "
        "undeliverable"
    )
    assert body["provider_billed"] is False
    assert body["status"] == "refunded"
    assert body["billed"] == "0.000"
    assert balance(creator) == before


@pytest.mark.django_db
def test_editing_the_target_draft_before_the_job_starts_costs_nothing(
    creator_factory, ai_model, monkeypatch, settings
):
    """The other half of round 4's finding 3.

    The creator's own draft in the target language changed between paying and
    the worker starting. Delivering would overwrite their work, so the job was
    undeliverable from the moment it began -- and must not spend a penny of
    provider time discovering that.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Borrador",
        description="Mi propio borrador.", content="Mi propio texto.",
        is_published=False,
    )
    before = balance(creator)
    response = buy(client_for(creator), page)

    ZPageTranslation.objects.filter(zpage=page, language="es").update(
        content="Mi propio texto, ahora mejorado."
    )
    fake = Provider()
    monkeypatch.setattr(service, "stream_chat", fake)
    run_job(response)

    body = record_for(response)
    assert body["error"] == "variant_changed"
    assert fake.calls == 0
    assert body["provider_billed"] is False
    assert body["billed"] == "0.000"
    assert balance(creator) == before


def test_the_metered_spend_is_discounted_when_the_encoding_is_not_the_providers():
    """codex adversarial review of, round 3, finding 2 -- still true.

    ``count_tokens`` counts a reply in ``cl100k_base`` for every model tiktoken
    cannot map, while the provider meters in its own encoding;  measured
    that over-counting non-English text by up to 3.15x on the languages we sell.
    Over-counting is harmless for a cap and NOT harmless for a charge, and
    capping at the quote does not stop an over-estimate billing two thirds of a
    quote for a third of a quote's work. So the settlement prices a DISCOUNTED
    count -- a floor on our spend rather than a ceiling.

    The model here is ``anthropic:claude-haiku-4-5``, which is what
    ``DEFAULT_MODEL_PREFERENCE`` selects in production and what tiktoken has no
    mapping for. It was ``gpt-4o`` until, and for gpt-4o the discount is
    now a bug rather than a protection -- see
    ``test_a_model_counted_in_its_own_encoding_is_not_discounted_twice``.
    """
    assert settlement.OUTPUT_TOKEN_UNCERTAINTY >= 3.15, (
        "the discount must cover the worst over-count #1912 measured"
    )

    class Priced:
        provider = "anthropic"
        model = "claude-haiku-4-5"
        input_price = "0.0000025"
        output_price = "0.00001"
        markup = 1.0

        def get_tuzi_price(self, input_tokens, output_tokens):
            return AIModel.get_tuzi_price(self, input_tokens, output_tokens)

    # INPUT as well as output. The prompt is the creator's article, and Free2Z
    # sells translation FROM the languages it sells translation into, so an
    # input-heavy Hindi article with a short reply is billed on an inflated
    # input count that an output-only discount cannot offset -- and the quote
    # cannot rescue it, because the quote uses the same inflated counts.
    # (codex adversarial review of, round 4.)
    def expected(tokens_in, tokens_out):
        """The price of the DISCOUNTED counts, exactly as the code computes it.

        Compared against the real formula rather than against a ratio: the
        cost-plus price ceils to a whole 2Z, so "roughly a third" is not a
        statement a small number can satisfy.
        """
        divisor = settlement.OUTPUT_TOKEN_UNCERTAINTY
        return Priced().get_tuzi_price(
            int(tokens_in / divisor), int(tokens_out / divisor)
        )

    meter = settlement.SpendMeter()
    meter.record(input_tokens=300_000, output_tokens=320_000)
    undiscounted = Priced().get_tuzi_price(300_000, 320_000)
    assert settlement.metered_cost(Priced(), meter) == expected(
        300_000, 320_000
    )
    assert settlement.metered_cost(Priced(), meter) < undiscounted
    # An input-only meter must be discounted too, or the assertion above could
    # pass on the output term alone.
    input_only = settlement.SpendMeter()
    input_only.record(input_tokens=300_000, output_tokens=0)
    assert settlement.metered_cost(Priced(), input_only) == expected(
        300_000, 0
    )
    assert settlement.metered_cost(Priced(), input_only) < Priced(
    ).get_tuzi_price(300_000, 0)
    #...and the LOSS estimate is the undiscounted one.
    assert settlement.estimated_cost(Priced(), meter) == undiscounted


def test_discount_requires_the_caller_to_choose_its_divisor():
    """Prevent a future caller from silently restoring the unconditional 3.2."""
    with pytest.raises(TypeError):
        settlement._discount(320_000)

    assert settlement._discount(320_000, 1.0) == 320_000
    assert settlement._discount(
        320_000, settlement.OUTPUT_TOKEN_UNCERTAINTY
    ) == int(320_000 / settlement.OUTPUT_TOKEN_UNCERTAINTY)


@pytest.mark.django_db
def test_a_settlement_never_exceeds_the_quote_the_creator_consented_to(
    creator_factory, ai_model, settings
):
    """``TranslateWithAiDialog``'s invariant, at the settlement end.

    No 2Z is committed from a screen that has not shown the number. Charging
    *up to* that number for work actually performed keeps the promise; charging
    the metered cost of a runaway generation would break it. Driven with a
    metered cost an order of magnitude over the quote.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    quoted = Decimal(response.quoted_price)
    record = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    )

    meter = settlement.SpendMeter()
    meter.record(input_tokens=1, output_tokens=1)
    assert charges.settle_failure(
        record.pk, code="source_changed", detail="runaway",
        fault=settlement.REQUEST, meter=meter,
        metered_cost=int(quoted) * 10 + 100,
    ) is True

    body = record_for(response)
    assert Decimal(body["billed"]) == quoted
    assert Decimal(body["refunded"]) == 0
    assert balance(creator) == before - quoted


@pytest.mark.django_db
def test_an_attributable_failure_with_no_provider_spend_is_still_free(
    creator_factory, ai_model, settings
):
    """The arithmetic, not the table, is what protects the creator.

    ``min(metered_cost, charged)`` with an empty meter is zero, so a failure
    classified as attributable but reached before any generation is a full
    refund regardless. This is the property that makes a future widening of the
    fault table safe by default.
    """
    settings.ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS = 0
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    record = IdempotencyKey.objects.get(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    )

    # `source_changed` with forgiveness off and 99 priors IS adjudicated
    # `request` -- the strongest case the table can produce -- and it still
    # settles at zero because the meter is empty. A code the table calls ours
    # would prove nothing here.
    fault = settlement.classify(
        "source_changed", prior_mutations=99, requester_caused=True
    )
    assert fault == settlement.REQUEST
    assert charges.settle_failure(
        record.pk, code="source_changed", detail="edited before the call",
        fault=fault, requester_caused=True,
        meter=settlement.SpendMeter(), ai_model=ai_model,
    ) is True

    body = record_for(response)
    assert body["status"] == "refunded"
    assert body["billed"] == "0.000"
    assert body["provider_billed"] is False
    assert balance(creator) == before


# ---------------------------------------------------------------------------
# 5. Never discard work already paid for
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_fragments_already_paid_for_are_not_bought_a_second_time(
    creator_factory, ai_model, monkeypatch
):
    """ item 4.

    A document that fails on a late fragment throws away every earlier
    fragment -- all of them generated, all of them billed to us. The retry then
    pays for them again. Here the first attempt fails after two fragments and
    the second attempt must reach the provider for strictly fewer fragments,
    and still deliver the whole article.
    """
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    client = client_for(creator)

    failing = Provider(fail_after=2)
    monkeypatch.setattr(service, "stream_chat", failing)
    first = buy(client, page)
    run_job(first)
    assert record_for(first)["status"] == "refunded"

    working = Provider()
    monkeypatch.setattr(service, "stream_chat", working)
    second = buy(client, page)
    assert run_job(second) is True

    assert working.distinct < failing.distinct, (
        "the retry re-bought fragments the first attempt had already paid for"
    )
    assert working.distinct > 0, "nothing was translated at all"
    live = ZPageTranslation.objects.get(zpage=page, language="es")
    assert live.content.strip(), "the delivered article must be complete"
    assert record_for(second)["status"] == "delivered"


#A body whose paragraphs are separated by fenced code blocks. Code blocks are
#never sent to the model and they BREAK a merge run, so this plans into one
#fragment per paragraph instead of one merged chunk -- which is what makes a
#multi-step carry-over chain observable at all.
CHAINED_BODY = "\n\n".join(
    f"Paragraph {index} of an article long enough to be worth translating, "
    f"with nothing in it for the safety invariants to object to.\n\n"
    f"```python\ndef untranslated_{index}():\n    return {index}\n```"
    for index in range(6)
)


@pytest.mark.django_db
def test_carry_over_accumulates_across_a_chain_of_failures(
    creator_factory, ai_model, monkeypatch
):
    """Each charge record stores only what its OWN run bought.

    The alternative -- every record storing the whole accumulated document --
    puts a fresh copy of a 100,000-character translation on another row of the
    money table for every retry, and ``reconcile_zpage_variants`` reads those
    blobs in batches. So ``charges.carried_fragments`` unions the recent records
    instead, and the union has to be real: without it the SECOND retry re-buys
    everything the first one paid for, which is the bug this whole item exists
    to stop, one attempt later.
    """
    creator = creator_factory(tuzis=Decimal("2000"))
    page = make_page(creator, content=CHAINED_BODY)
    client = client_for(creator)
    total = len([
        unit for unit in service.plan_document(
            page.title, page.description, page.content
        )
        if unit.kind == service.TRANSLATE
    ])
    assert total >= 6, "this test needs a document that plans into fragments"

    # Attempt 1: two fragments land, the third trips the cap.
    first_provider = Provider(fail_after=2)
    monkeypatch.setattr(service, "stream_chat", first_provider)
    first = buy(client, page)
    run_job(first)
    assert record_for(first)["status"] == "refunded"
    assert first_provider.distinct == 3

    # Attempt 2: the first two are recalled for free, two more land, the third
    # NEW one trips the cap. Four fragments are now paid for.
    second_provider = Provider(fail_after=2)
    monkeypatch.setattr(service, "stream_chat", second_provider)
    second = buy(client, page)
    run_job(second)
    assert record_for(second)["status"] == "refunded"
    assert second_provider.distinct == 3, (
        "attempt 2 re-bought the fragments attempt 1 had already paid for"
    )
    # Its record holds only its OWN two, not the accumulated four.
    assert len(record_for(second)["_fragments"]) == 2

    # Attempt 3: everything paid for across BOTH earlier records is recalled.
    third_provider = Provider()
    monkeypatch.setattr(service, "stream_chat", third_provider)
    third = buy(client, page)
    assert run_job(third) is True
    assert third_provider.distinct == total - 4, (
        "the union across earlier charge records was not applied"
    )
    assert record_for(third)["status"] == "delivered"
    live = ZPageTranslation.objects.get(zpage=page, language="es")
    # Every paragraph is present and every code block survived untranslated --
    # a recalled fragment must reassemble exactly like a fresh one.
    for index in range(6):
        assert f"def untranslated_{index}():" in live.content


@pytest.mark.django_db
def test_a_safety_violation_is_delivered_and_carries_no_fragments(
    creator_factory, ai_model, monkeypatch
):
    """ replaced the refund with delivery, and kept what mattered.

    Before  a document that broke a ``safety`` invariant was refunded,
    and (codex adversarial review of, finding 3) must keep none of its
    output, so the next purchase reached the provider afresh. It is now
    delivered as an unpublished draft with a warning -- and a retry must STILL
    reach the provider for every fragment rather than be handed the same text
    and the same warning at no cost.
    """
    creator = creator_factory(tuzis=Decimal("2000"))
    page = make_page(creator, content=CHAINED_BODY)
    client = client_for(creator)

    def invent_markup(fragment):
        # Markup the source never contained: a warning since.
        return f"[tr] {fragment}\n\n<marquee>not in the source</marquee>"

    first_provider = Provider(transform=invent_markup)
    monkeypatch.setattr(service, "stream_chat", first_provider)
    first = buy(client, page)
    assert run_job(first) is True
    body = record_for(first)
    assert body["status"] == "delivered"
    assert [w["code"] for w in body["warnings"]] == ["markup_not_in_source"]
    assert "_fragments" not in body

    second_provider = Provider(transform=invent_markup)
    monkeypatch.setattr(service, "stream_chat", second_provider)
    second = buy(client, page)
    run_job(second)
    assert second_provider.distinct == first_provider.distinct, (
        "the retry recalled fragments instead of regenerating them"
    )


@pytest.mark.django_db
def test_a_delivery_with_warnings_voids_a_cache_an_earlier_failure_had_filled(
    creator_factory, ai_model, monkeypatch
):
    """The half that refusing-to-store cannot cover (codex finding 3), kept
    true across.

    A truncation stores fragments 1..k-1 without any of them having been
    safety-checked as a document -- the check only runs on the attempt that
    finally assembles them. That attempt used to be REFUSED, and a refusal in
    the history voided the cache. It is now DELIVERED with a warning, so the
    warning has to void the cache too: otherwise the creator re-buying because
    of the warning recalls the same two poisoned fragments, forever.

    NEGATIVE CONTROL: drop the ``DELIVERED`` branch from
    ``charges.carried_fragments`` and attempt 3 recalls two fragments
    (``distinct == total - 2``) and still carries the invented link.
    """
    creator = creator_factory(tuzis=Decimal("2000"))
    page = make_page(creator, content=CHAINED_BODY)
    client = client_for(creator)

    def invent_markup(fragment):
        return f"[tr] {fragment}\n\n<marquee>not in the source</marquee>"

    # Attempt 1: two fragments land (each carrying the bad markup, unnoticed --
    # safety never sees a partial document) and the third trips the cap.
    monkeypatch.setattr(
        service, "stream_chat", Provider(transform=invent_markup, fail_after=2)
    )
    first = buy(client, page)
    run_job(first)
    assert record_for(first)["error"] == "output_truncated"
    assert len(record_for(first)["_fragments"]) == 2, (
        "the truncation must have filled the cache, or this proves nothing"
    )

    # Attempt 2: the document assembles and is delivered with a warning.
    monkeypatch.setattr(
        service, "stream_chat", Provider(transform=invent_markup)
    )
    second = buy(client, page)
    assert run_job(second) is True
    assert [w["code"] for w in record_for(second)["warnings"]] == [
        "markup_not_in_source"
    ]

    # Attempt 3, with a clean provider: NOTHING may be recalled, including the
    # two fragments attempt 1 stored before anyone knew they were poisoned.
    third_provider = Provider()
    monkeypatch.setattr(service, "stream_chat", third_provider)
    third = buy(client, page)
    assert run_job(third) is True
    total = len([
        unit for unit in service.plan_document(
            page.title, page.description, page.content
        )
        if unit.kind == service.TRANSLATE
    ])
    assert third_provider.distinct == total, (
        "a fragment stored before the warned delivery was still recalled"
    )
    live = ZPageTranslation.objects.get(zpage=page, language="es")
    assert "<marquee>" not in live.content
    assert record_for(third)["warnings"] == []


@pytest.mark.django_db
def test_an_over_long_translation_never_carries_its_fragments_forward(
    creator_factory, ai_model, monkeypatch
):
    """codex adversarial review of, round 2.

    A translation that did not fit the 100,000-character column reassembles to
    exactly the same over-long document if its fragments are reused, so the only
    thing the cache can produce is the identical refusal -- the creator pays,
    waits and is refunded, repeatedly, with the provider never given the chance
    to answer shorter. My own reasoning for allowing it ("a repeat failure is
    cheaper for us") weighed our cost and not theirs.
    """
    creator = creator_factory(tuzis=Decimal("5000"))
    # Big enough that an expansion tips the translated document over
    # MAX_CONTENT_CHARS, small enough that `zPage.content` still accepts it.
    body = "\n\n".join(
        f"Paragraph {index} of a very long article. " * 60
        for index in range(28)
    )
    assert len(body) < service.MAX_CONTENT_CHARS
    assert len(body) * 1.8 > service.MAX_CONTENT_CHARS, (
        "the expansion below must actually breach the content ceiling"
    )
    page = make_page(creator, content=body)
    client = client_for(creator)

    # ~1.8x the source: over the content ceiling in aggregate, under the
    # per-fragment output cap so it fails as `output_too_long` and not as a
    # truncation.
    def expand(fragment):
        return fragment + fragment[: int(len(fragment) * 0.8)]

    first_provider = Provider(transform=expand)
    monkeypatch.setattr(service, "stream_chat", first_provider)
    first = buy(client, page)
    run_job(first)
    stored = record_for(first)
    assert stored["error"] == "output_too_long", stored["error_detail"]
    assert stored["status"] == "refunded"
    assert "_fragments" not in stored, (
        "output proven impossible to store must not be kept for reuse"
    )

    second_provider = Provider()
    monkeypatch.setattr(service, "stream_chat", second_provider)
    second = buy(client, page)
    assert run_job(second) is True, (
        "the retry reused output already proven undeliverable"
    )
    assert second_provider.distinct == first_provider.distinct
    assert record_for(second)["status"] == "delivered"


@pytest.mark.django_db
def test_a_request_that_never_reached_the_provider_is_not_billable(
    creator_factory, ai_model, monkeypatch, settings
):
    """codex adversarial review of, finding 2.

    ``stream_chat`` is lazy, so a connection refused surfaces on the first
    iteration of the stream: nothing was sent and nothing was billed. Recording
    the prompt anyway made an outage MANUFACTURE spend -- fictitious 2Z counting
    toward the per-account and platform failure ceilings, so translation sales
    could stay paused after connectivity came back.
    """
    settings.ZPAGE_TRANSLATION_MAX_FAILED_SPEND_PER_USER = 1
    creator = creator_factory(tuzis=Decimal("2000"))
    page = make_page(creator)
    before = balance(creator)
    client = client_for(creator)
    fake = Provider(lazy_error=ConnectionError("connection refused"))
    monkeypatch.setattr(service, "stream_chat", fake)

    response = buy(client, page)
    run_job(response)

    body = record_for(response)
    assert body["error"] == "provider_error"
    assert body["status"] == "refunded"
    assert balance(creator) == before
    assert fake.calls > 0, (
        "the stub must have been asked for a stream, or this proves nothing "
        "about metering"
    )
    assert body["provider_billed"] is False, (
        "a request that never reached the provider is not provider spend"
    )
    assert body["provider_calls"] == 0
    assert body["provider_input_tokens"] == 0
    assert body["metered_cost"] == 0
    #...and therefore the outage did not consume the creator's failure budget.
    assert charges.failed_spend(user=creator) == (0, 0)
    assert buy(client, page).status_code == 202


@pytest.mark.django_db
def test_a_stream_that_legitimately_returned_nothing_IS_billable(
    creator_factory, ai_model, monkeypatch
):
    """The other side of finding 2, so the fix is not "never meter an error".

    A model that consumed the prompt and then produced no text was served, and
    the provider bills the input. The discriminator is whether the stream
    reached its own end, not whether the job succeeded.
    """
    creator = creator_factory(tuzis=Decimal("2000"))
    page = make_page(creator)
    before = balance(creator)
    monkeypatch.setattr(service, "stream_chat", Provider(empty=True))

    response = buy(client_for(creator), page)
    run_job(response)

    body = record_for(response)
    assert body["error"] == "empty_output"
    assert body["provider_billed"] is True
    assert body["provider_input_tokens"] > 0
    assert body["provider_output_tokens"] == 0
    assert body["status"] == "refunded"
    assert balance(creator) == before


@pytest.mark.django_db
def test_carried_fragments_are_never_returned_to_the_client(
    creator_factory, ai_model, monkeypatch
):
    """The carry-over lives on the money row; it is not part of the contract.

    A refunded translation is one the creator did not pay for, so shipping its
    text back on the status endpoint would hand them the thing they were
    refunded for.
    """
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    client = client_for(creator)
    monkeypatch.setattr(service, "stream_chat", Provider(fail_after=2))
    response = buy(client, page)
    run_job(response)

    stored = record_for(response)
    assert stored["_fragments"], "nothing was carried, so nothing is proven"
    public = client.get(translate_url(page)).data
    assert "_fragments" not in public
    assert not any(key.startswith("_") for key in public)


# ---------------------------------------------------------------------------
#  item 2 -- the discount that is now double-counting, and the instrument
#
# Same split as the block in `test_translation_service.py`, for the same reason:
#  landed the prompt-side metering mid-review, so the two DB-backed tests at
# the end of this block are REGRESSION GUARDS for behaviour already on `main`
# (the stored `actual_cost` being a cost, and the over-cost warning being
# selective rather than silent). The two discount tests are this PR's own
# change:  made both metered counts provider-encoded and left
# `OUTPUT_TOKEN_UNCERTAINTY` unconditional at 3.2, so the divisor now discounts a
# count that has nothing left to compensate for.
# ---------------------------------------------------------------------------
#Prose with no link, no price and no markup, so a reply may be in any script
#without ``safety.check_translation`` having anything to say about it -- the
#shipped ``BODY`` above carries a link and a "$5 a month", which a non-English
#reply cannot preserve word for word.
#
#Deliberately BIG. At gpt-4o's seeded prices a 60-word document costs a
#fraction of a cent whichever encoding counts it, and ``get_tuzi_price`` ceils
#to a whole 2Z -- so a small document would make every price below equal 1 and
#the assertions would pass on the rounding rather than on the fix.
PLAIN_BODY = "\n\n".join(
    " ".join(f"word{paragraph}x{index}" for index in range(400)) + "."
    for paragraph in range(4)
) + "\n"

#...and a title and description that carry no brand term either.  added
#``brand_term_not_preserved``, and ``make_page``'s default title is
#*"Free2Z is for creators"* -- a stub reply that does not echo "Free2Z" is
#correctly refused before any of the arithmetic under test runs. Overriding the
#title is the right fix rather than teaching the stubs to preserve the brand:
#these tests are about what a delivery COST, and a document with nothing to
#preserve keeps them about that.
PLAIN_PAGE = {
    "title": "A plain heading for pricing tests",
    "description": "An ordinary summary with no names in it.",
    "content": PLAIN_BODY,
}


class Cl100kOnly:
    """What ``_get_encoding`` hands back when the o200k fetch fails."""

    name = "cl100k_base"

    def encode(self, text):
        return list(text)


class O200k:
    """What it hands back when the fetch worked."""

    name = "o200k_base"

    def encode(self, text):
        return list(text)


def _install_two_tokenizers(monkeypatch, provider_model):
    """Both tiktoken helpers, with PRODUCTION's signatures, offline.

    A word containing a non-ASCII character costs THREE tokens in the default
    encoding and ONE in the provider's own. That is the real relationship stated
    deterministically: measured on parallel prose, ``cl100k``/``o200k`` is 3.17x
    for Hindi, 2.25x for Arabic and 1.00x for English.

    Keeping ``model=`` on both stubs matters -- one that dropped it would let
    every assertion below pass whether or not the fix is present. So does the
    per-message overhead in the second: it is the only thing
    ``count_message_tokens`` adds over ``count_tokens``, and the provider bills
    it too.
    """
    from dj.apps.openai import models as openai_models

    def text_tokens(text, model="gpt-3.5-turbo"):
        words = (text or "").split()
        count = len(words)
        if model != provider_model:
            count += 2 * sum(
                1 for word in words if any(ord(char) > 127 for char in word)
            )
        return count

    def message_tokens(messages, model="gpt-3.5-turbo"):
        total = 2
        for message in messages:
            total += 4
            for value in message.values():
                total += text_tokens(value, model)
        return total

    monkeypatch.setattr(openai_models, "num_tokens_from_text", text_tokens)
    monkeypatch.setattr(
        openai_models, "num_tokens_from_messages", message_tokens
    )


def _inflating_reply(fragment):
    """A reply in a token-inflating script, one word per source word.

    So the PROVIDER meters almost exactly what it metered for the English
    source, while the default encoding reads the same reply as three times that.
    """
    return " ".join("अनुवाद" for _ in fragment.split())


def _expensive_reply(fragment):
    """A reply that genuinely costs more than its quote.

    2.2x the source in words and in ASCII, so BOTH encodings agree about it and
    the over-spend is not an artefact of the unit: the provider really generated
    about twice what the quote estimated at ``OUTPUT_TOKEN_RATIO`` 1.15. Inside
    ``OUTPUT_CEILING_RATIO`` (2.5), so it is a complete translation and not a
    cap hit.
    """
    words = fragment.split()
    return " ".join(f"palabra{index}" for index in range(int(len(words) * 2.2)))


def _capture_result(monkeypatch):
    """Keep the ``TranslationResult`` ``translate_zpage`` priced, for assertions."""
    captured = {}
    real = service.translate_document

    def wrapper(**kwargs):
        captured["result"] = real(**kwargs)
        return captured["result"]

    monkeypatch.setattr(service, "translate_document", wrapper)
    return captured


def test_a_model_counted_in_its_own_encoding_is_not_discounted_twice(
    monkeypatch
):
    """ item 2: two compensating errors, and now neither of them.

    ``OUTPUT_TOKEN_UNCERTAINTY`` exists because our counts were in a different
    tokenizer from the provider's.  put the reply into the provider's own
    encoding and  put the prompt there too, so for a model tiktoken can map
    the divisor was correcting a bias that is no longer there -- understating
    gpt-4o spend by a factor of 3.2. The constant's own docstring said to delete
    it once that happened. It happened for one provider, so the discount became
    conditional rather than deleted.

    Asserted on BOTH sides of the switch, because "the discount was removed" and
    "the discount is conditional" are different changes and only one of them is
    right: Haiku -- the first enabled row in ``DEFAULT_MODEL_PREFERENCE`` --
    must still be discounted in this same test.

    The lightweight models below call the production ``AIModel.get_tuzi_price``
    directly, so this also exercises the exact Decimal pricing shared with the
    translation quote while pinning the conditional divisor.

    NEGATIVE CONTROL: make ``_discount`` ignore its ``divisor`` argument, i.e.
    restore the unconditional 3.2, and the gpt-4o assertions fail while the
    Haiku one keeps passing.
    """
    from dj.apps.openai import models as openai_models

    class Priced:
        input_price = "0.0000025"
        output_price = "0.00001"
        markup = 1.0

        def get_tuzi_price(self, input_tokens, output_tokens):
            return AIModel.get_tuzi_price(self, input_tokens, output_tokens)

    class GptFourO(Priced):
        provider = "openai"
        model = "gpt-4o"

    class Haiku(Priced):
        provider = "anthropic"
        model = "claude-haiku-4-5"

    # The o200k vocabulary LOADED, so gpt-4o really is counted the way gpt-4o
    # bills. Stubbed rather than fetched: `test_tiktoken_vocabularies.py` is the
    # repo's statement that this suite does not depend on a BPE download, and
    # `encoding_name_for_model` -- the half that decides the verdict -- needs no
    # network either way.
    monkeypatch.setattr(
        openai_models, "_get_encoding", lambda model="": O200k()
    )
    service._tokenizer_fidelity.cache_clear()
    try:
        meter = settlement.SpendMeter()
        meter.record(input_tokens=300_000, output_tokens=320_000)

        whole = GptFourO().get_tuzi_price(300_000, 320_000)
        assert settlement.metered_cost(GptFourO(), meter) == whole, (
            "a count already in the provider's encoding must not be discounted"
        )
        assert settlement.metered_cost(
            GptFourO(), meter
        ) == settlement.estimated_cost(GptFourO(), meter), (
            "charge and loss estimate coincide once the count is exact"
        )

        #...and the model production actually selects is UNCHANGED. tiktoken
        # has no mapping for it, so `provider_tokens` still degrades to cl100k
        # and the discount is still the honest treatment of a biased count.
        discounted = settlement.metered_cost(Haiku(), meter)
        assert discounted < whole
        divisor = settlement.OUTPUT_TOKEN_UNCERTAINTY
        assert discounted == Haiku().get_tuzi_price(
            int(300_000 / divisor), int(320_000 / divisor)
        )
    finally:
        service._tokenizer_fidelity.cache_clear()


def test_a_vocabulary_that_would_not_load_keeps_the_discount(monkeypatch):
    """The discount is the DEFAULT and dropping it needs positive evidence.

    ``_get_encoding`` falls back to ``cl100k_base`` behind a bare ``except``, so
    a failed ``o200k_base`` fetch leaves gpt-4o counted in the wrong encoding
    with only a log line to say so. Reading that as "exact" would bill a creator
    on counts we have just been told are inflated, so it has to read as "not
    exact" -- and it has to do so without anyone remembering to check.

    The lightweight model calls the production Decimal pricing method, so this
    pins the divisor against the same exact arithmetic used by the quote.

    NEGATIVE CONTROL: make ``counts_in_provider_encoding`` answer from
    ``encoding_name_for_model`` alone and this fails.
    """
    from dj.apps.openai import models as openai_models

    class GptFourO:
        provider = "openai"
        model = "gpt-4o"
        input_price = "0.0000025"
        output_price = "0.00001"
        markup = 1.0

        def get_tuzi_price(self, input_tokens, output_tokens):
            return AIModel.get_tuzi_price(self, input_tokens, output_tokens)

    monkeypatch.setattr(
        openai_models, "_get_encoding", lambda model="": Cl100kOnly()
    )
    service._tokenizer_fidelity.cache_clear()
    try:
        meter = settlement.SpendMeter()
        meter.record(input_tokens=300_000, output_tokens=320_000)
        divisor = settlement.OUTPUT_TOKEN_UNCERTAINTY
        assert settlement.metered_cost(GptFourO(), meter) == GptFourO(
        ).get_tuzi_price(int(300_000 / divisor), int(320_000 / divisor))
    finally:
        service._tokenizer_fidelity.cache_clear()


@pytest.mark.django_db
def test_the_recorded_cost_of_a_delivery_is_what_the_provider_would_bill(
    creator_factory, monkeypatch, settings, provider, deferred, caplog
):
    """'s first piece of required evidence, end to end.

    ``translate_zpage`` prices ``result.input_tokens``/``result.output_tokens``
    into the ``actual_cost`` stored on the charge record and served by
    ``TranslationStatusSerializer``. Those counts came from ``count_tokens`` and
    ``count_message_tokens`` -- ``cl100k_base`` for every model -- while gpt-4o
    bills in ``o200k_base``, so the stored figure read high by the cl100k/o200k
    spread of the TARGET language: 1.58x for Simplified Chinese, 2.25x Arabic,
    3.17x Hindi on this PR's own measurement of parallel prose.

    Asserted against what the provider would bill for the text actually read
    back, not against a number. The delivered translation is in a
    token-inflating script and there are two possible prices for it; only one of
    them is a cost.

    NEGATIVE CONTROL: put ``used_out += count_tokens(raw)`` back in
    ``translate_unit`` and the stored ``actual_cost`` rises to the phantom
    figure this asserts it is below.
    """
    settings.ZPAGE_TRANSLATION_MODELS = ["openai:gpt-4o"]
    gpt4o = AIModel.objects.get(provider="openai", model="gpt-4o")
    _install_two_tokenizers(monkeypatch, gpt4o.model)
    provider.transform = _inflating_reply
    captured = _capture_result(monkeypatch)

    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator, **PLAIN_PAGE)
    response = buy(client_for(creator), page, language="hi")
    with caplog.at_level(logging.WARNING):
        assert run_job(response) is True

    body = record_for(response)
    assert body["status"] == charges.DELIVERED
    result = captured["result"]

    # What the provider billed for these replies, and what cl100k says instead.
    replies = [_inflating_reply(fragment) for fragment in provider.fragments]
    assert replies, "the provider was never called"
    billed = sum(service.provider_tokens(gpt4o, reply) for reply in replies)
    inflated = sum(service.count_tokens(reply) for reply in replies)
    assert inflated > billed, "the two encodings must disagree about this reply"

    assert result.output_tokens == billed
    assert body["actual_cost"] == service.translation_price(
        gpt4o, result.input_tokens, billed
    )
    phantom = service.translation_price(gpt4o, result.input_tokens, inflated)
    assert body["actual_cost"] < phantom, (
        "the stored cost is still being read in the wrong tokenizer"
    )

    #...and the warning that watches the margin did not fire on a phantom loss.
    assert body["actual_cost"] <= response.quoted_price
    assert phantom > response.quoted_price, (
        "this document was supposed to look over-quoted in cl100k"
    )
    settled_under = [
        record.getMessage() for record in caplog.records
        if "settled under its cost" in record.getMessage()
    ]
    assert settled_under == [], settled_under


@pytest.mark.django_db
def test_the_under_cost_warning_still_fires_on_a_real_loss(
    creator_factory, monkeypatch, settings, provider, deferred, caplog
):
    """The other half of 's required evidence.

    A warning that has never been observed to go off correctly is not evidence
    of anything, and correcting the unit makes this one fire LESS -- so what has
    to be proved is that it still fires when the loss is real. Paired with the
    test above, which proves it does not fire when the loss is a tokenizer
    artefact: selective, not silent.

    NEGATIVE CONTROL: delete the ``if actual_cost > quoted`` branch in
    ``translate_zpage`` and this goes red while the phantom test stays green.
    """
    settings.ZPAGE_TRANSLATION_MODELS = ["openai:gpt-4o"]
    gpt4o = AIModel.objects.get(provider="openai", model="gpt-4o")
    _install_two_tokenizers(monkeypatch, gpt4o.model)
    provider.transform = _expensive_reply

    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator, **PLAIN_PAGE)
    response = buy(client_for(creator), page, language="es")
    with caplog.at_level(logging.WARNING):
        assert run_job(response) is True

    body = record_for(response)
    assert body["status"] == charges.DELIVERED
    assert body["actual_cost"] > response.quoted_price, (
        "this reply was supposed to cost more than its quote"
    )
    settled_under = [
        record.getMessage() for record in caplog.records
        if "settled under its cost" in record.getMessage()
    ]
    assert len(settled_under) == 1, settled_under
    assert f"quoted {response.quoted_price} 2Z" in settled_under[0]
    # The creator is billed the quote and nothing more -- the loss is ours.
    assert Decimal(body["charged"]) == Decimal(response.quoted_price)
