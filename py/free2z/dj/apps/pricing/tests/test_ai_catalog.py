"""The signed AI catalogue, GET /api/ai/catalog/v1.

Three layers of evidence that the gateway's verifier (zuu ``f2z-ai-proto``
``verify_catalog``) accepts what Django serves:

1. **Byte parity with the crate's own fixture.** ``canonical_json`` of the
   vendored ``catalog.json`` is byte-identical to the vendored
   ``catalog.canonical.json`` (what the crate's test pins as the signing
   message), and re-signing it with the RFC 8032 TEST 1 key reproduces the
   vendored signature EXACTLY -- Ed25519 is deterministic, so that single
   equality proves label, canonical bytes and key handling at once.
2. **A Django-produced sample,** ``fixtures/ai_catalog/django_signed_catalog.json``,
   verified here by an independent pure-Python RFC 8032 verifier
   (``ed25519_reference.py``, no shared code with ``cryptography``) and by the
   Rust crate itself (README beside it: how, and the recorded result).
3. **The crate's canonicalization tests, ported** (member order by UTF-16 code
   unit, JCS escaping, integers only within +/-(2**53 - 1)).

Everything else is the endpoint: refusal on every invalid state, ETag/304,
the re-issue window, and the log lines monitoring/ matches.
"""
import contextlib
import datetime
import hashlib
import io
import importlib
import json
import logging
import os
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from django.core.management import call_command
from django.test import override_settings
from rest_framework.test import APIClient

from dj.apps.openai.models import AIModel
from dj.apps.pricing import catalog
from dj.apps.pricing.models import RateCard, RateCardModel
from dj.apps.pricing.tests import ed25519_reference

HERE = Path(__file__).resolve().parent
CRATE = HERE / "fixtures" / "f2z_ai_proto" / "catalog"
SAMPLE = HERE / "fixtures" / "ai_catalog" / "django_signed_catalog.json"
REPO = HERE.parents[5]
URL = "/api/ai/catalog/v1"

# RFC 8032 section 7.1 TEST 1. Public; printed in the RFC.
TEST1_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
TEST1_PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
TEST1_EMPTY_MESSAGE_SIGNATURE_HEX = (
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
)

# git blob ids of the vendored crate files at free2z/zuu 5603cae9 (README).
RECORDED_BLOBS = {
    "catalog.canonical.json": "6912fcde12cb86821cef8bdc6cf1bb047300ec96",
    "catalog.json": "3d0febe0940314e160c8c2100dc763c1befecaf2",
    "signature.json": "058ab30b127da0dfe03a4030d01d416b3d8a7709",
}

# The instant the Django sample was signed at: an arbitrary second INSIDE a
# window, so the sample also pins that issued_at is the window start. In 2096
# on purpose: the revision is max(updated_at, published_at) over rows the
# migrations stamp with the REAL clock (the seeded v1 card, which is
# immutable), and every one of those must be older than this window for the
# sample to be deterministic. Still far below 2**53 in microseconds.
SAMPLE_NOW = 4_000_001_234
SAMPLE_CARD_VERSION = 2227


def _git_blob_id(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _crate_signature():
    return json.loads((CRATE / "signature.json").read_text())


def _test_key():
    return catalog.SigningKey(
        key_id="fixture-rfc8032-test1",
        private_key=Ed25519PrivateKey.from_private_bytes(bytes.fromhex(TEST1_SEED_HEX)),
        public_key_hex=TEST1_PUBLIC_HEX,
    )


# ---------------------------------------------------------------------------
# 1. Parity with the crate's fixture (no DB)
# ---------------------------------------------------------------------------


def test_vendored_crate_fixtures_match_recorded_blobs():
    assert sorted(p.name for p in CRATE.glob("*.json")) == sorted(RECORDED_BLOBS)
    for name, blob in RECORDED_BLOBS.items():
        assert _git_blob_id((CRATE / name).read_bytes()) == blob, (
            f"{name} changed: re-vendor deliberately (see the fixtures README)"
        )


def test_canonical_json_is_byte_identical_to_the_crate_fixture():
    served = json.loads((CRATE / "catalog.json").read_bytes())
    assert catalog.canonical_json(served) == (CRATE / "catalog.canonical.json").read_bytes()


def test_signing_the_crate_fixture_reproduces_its_signature_exactly():
    meta = _crate_signature()
    assert meta["signing_label"].encode() == catalog.CATALOG_SIGNING_LABEL
    assert meta["public_key_hex"] == TEST1_PUBLIC_HEX == catalog.RFC8032_TEST1_PUBLIC_HEX
    served = json.loads((CRATE / "catalog.json").read_bytes())
    signed = catalog.sign_catalog(served, _test_key())
    assert signed.signature_hex == meta["signature_hex"]
    assert signed.canonical == (CRATE / "catalog.canonical.json").read_bytes()


def test_the_crate_fixture_signature_verifies_under_both_verifiers():
    meta = _crate_signature()
    message = catalog.CATALOG_SIGNING_LABEL + (CRATE / "catalog.canonical.json").read_bytes()
    public = bytes.fromhex(meta["public_key_hex"])
    signature = bytes.fromhex(meta["signature_hex"])
    Ed25519PublicKey.from_public_bytes(public).verify(signature, message)
    assert ed25519_reference.verify(public, message, signature)


def test_reference_verifier_positive_and_negative_controls():
    """RFC 8032 TEST 1 itself (empty message), then one flipped bit each in
    the message, R and s: a verifier that says yes to everything would make
    every other assertion here worthless."""
    public = bytes.fromhex(TEST1_PUBLIC_HEX)
    sig = bytes.fromhex(TEST1_EMPTY_MESSAGE_SIGNATURE_HEX)
    assert ed25519_reference.verify(public, b"", sig)
    assert not ed25519_reference.verify(public, b"\x00", sig)
    assert not ed25519_reference.verify(public, b"", bytes([sig[0] ^ 1]) + sig[1:])
    assert not ed25519_reference.verify(public, b"", sig[:40] + bytes([sig[40] ^ 1]) + sig[41:])


# ---------------------------------------------------------------------------
# 3. canonical.rs's unit tests, ported
# ---------------------------------------------------------------------------


def _canon(text: str) -> str:
    return catalog.canonical_json(json.loads(text)).decode()


def test_sorts_members_and_drops_whitespace():
    assert _canon('{ "b": [1, 2, {"z": null, "a": true}], "a": "x" }') == (
        '{"a":"x","b":[1,2,{"a":true,"z":null}]}'
    )


def test_member_order_is_utf16_not_code_point():
    # U+FF61 sorts AFTER U+1F600 by UTF-16 code unit (0xFF61 > 0xD83D) but
    # BEFORE it by code point -- the case json.dumps(sort_keys=True) gets wrong.
    assert _canon('{"｡":1,"\U0001f600":2}') == '{"\U0001f600":2,"｡":1}'
    assert json.dumps({"｡": 1, "\U0001f600": 2}, sort_keys=True, ensure_ascii=False) != (
        '{"\U0001f600": 2, "｡": 1}'
    ), "negative control: code-point order really does differ here"


def test_escapes_per_jcs():
    assert _canon(r'"a\"b\\c\/d\u0001\né "') == '"a\\"b\\\\c/d\\u0001\\né "'


def test_every_control_character_is_escaped_in_lowercase_and_del_is_not():
    short = {0x08: "\\b", 0x09: "\\t", 0x0A: "\\n", 0x0C: "\\f", 0x0D: "\\r"}
    raw = "".join(chr(c) for c in range(0x20)) + "\x7f"
    expected = '"' + "".join(short.get(c, "\\u%04x" % c) for c in range(0x20)) + '\x7f"'
    assert catalog.canonical_json(raw).decode() == expected
    assert "\\u001a" in expected and "\\u001f" in expected


def test_integers_only_within_the_safe_range():
    assert _canon("[0,-7,9007199254740991]") == "[0,-7,9007199254740991]"
    for bad in (1.5, 1e3, 1.0, -0.0):
        with pytest.raises(catalog.CanonicalError):
            catalog.canonical_json(bad)
    for bad in (9007199254740992, -9007199254740992):
        with pytest.raises(catalog.CanonicalError):
            catalog.canonical_json(bad)


def test_booleans_are_not_integers_and_other_types_are_refused():
    assert catalog.canonical_json([True, False, None]) == b"[true,false,null]"
    for bad in ({1: "x"}, object(), b"bytes", "\ud800"):
        with pytest.raises(catalog.CanonicalError):
            catalog.canonical_json(bad)


# ---------------------------------------------------------------------------
# validate_catalog, on the crate's own fixture (no DB)
# ---------------------------------------------------------------------------


def _crate_catalog():
    return json.loads((CRATE / "catalog.json").read_bytes())


def _publishable_crate_catalog():
    c = _crate_catalog()
    c["models"] = [m for m in c["models"] if m["id"] in ("example-large", "example-mini")]
    # This older f2z-ai-proto fixture predates the additive schema-1 field.
    for model in c["models"]:
        model["idle_timeout_ms"] = 60_000
    # The crate fixture prices example-mini (provider openai) per image, which
    #  forbids for a provider that bills images as input tokens.
    c["models"][1]["prices"]["image_nusd"] = 0
    return c


def test_the_crate_fixture_minus_what_we_refuse_to_publish_validates():
    catalog.validate_catalog(_publishable_crate_catalog())


@pytest.mark.parametrize("mutate, reason", [
    (lambda c: c.update(schema=2), "invalid_catalog"),
    (lambda c: c.update(expires_at=c["issued_at"]), "invalid_catalog"),
    (lambda c: c.update(platform_margin_bps=100_001), "invalid_catalog"),
    (lambda c: c.update(version=-1), "invalid_catalog"),
    (lambda c: c.update(platform_margin_bps=1 << 32), "invalid_catalog"),
    (lambda c: c.update(models=None), "invalid_catalog"),
    (lambda c: c["models"].append(dict(c["models"][0])), "duplicate_model_id"),
    (lambda c: c["models"][0].update(id=""), "invalid_model"),
    (lambda c: c["models"][0].update(provider="example-provider"), "disabled_provider_model"),
    (lambda c: c["models"][0].update(api_style="a_style_this_crate_does_not_know"), "invalid_model"),
    (lambda c: c["models"][0].update(safety_factor_bps=9_999), "invalid_model"),
    (lambda c: c["models"][0].update(min_charge_2z=0), "invalid_model"),
    (lambda c: c["models"][0].update(max_output_tokens=200_001), "invalid_model"),
    (lambda c: c["models"][0].update(idle_timeout_ms=300_001), "invalid_model"),
    (lambda c: c["models"][0].update(enabled=1), "invalid_model"),
    (lambda c: c["models"][0]["prices"].update(dict.fromkeys(c["models"][0]["prices"], 0)),
     "all_zero_prices"),
    (lambda c: c["models"][0]["prices"].update(cache_write_1h_nusd_per_mtok=1), "invalid_model"),
    (lambda c: c["models"][0]["prices"].update(input_nusd_per_mtok=1.5), "invalid_model"),
    (lambda c: c["models"][0]["prices"].update(input_nusd_per_mtok=2**53), "invalid_model"),
    #example-mini is openai, which bills images as input tokens.
    (lambda c: c["models"][1]["prices"].update(image_nusd=1), "image_billed_as_tokens"),
])
def test_validate_refuses(mutate, reason):
    c = _publishable_crate_catalog()
    mutate(c)
    with pytest.raises(catalog.CatalogRefused) as exc:
        catalog.validate_catalog(c)
    assert exc.value.reason == reason


def test_constants_are_the_v1_contract():
    """zuu docs/free2z/ai-gateway: 72 h validity, re-sign at least every 24 h, alert
    under 48 h. A fresh catalogue must always be above the alert line, or the
    alert would fire on every healthy re-issue."""
    assert catalog.VALIDITY_SECONDS == 72 * 3600
    assert catalog.ALERT_REMAINING_SECONDS == 48 * 3600
    assert catalog.REISSUE_SECONDS <= 24 * 3600
    worst_fresh = catalog.VALIDITY_SECONDS - catalog.REISSUE_SECONDS
    assert worst_fresh > catalog.ALERT_REMAINING_SECONDS


def test_the_window_start_is_monotonic_and_aligned():
    assert catalog.REISSUE_SECONDS == 60
    assert SAMPLE_NOW % 60 == 14
    assert catalog.window_start(SAMPLE_NOW) == SAMPLE_NOW - 14
    assert catalog.window_start(SAMPLE_NOW - 15) == SAMPLE_NOW - 14 - 60
    for t in range(SAMPLE_NOW - 7200, SAMPLE_NOW + 7200, 7):
        assert catalog.window_start(t) <= t < catalog.window_start(t) + catalog.REISSUE_SECONDS
        assert catalog.window_start(t + 1) >= catalog.window_start(t)


# ---------------------------------------------------------------------------
# Signing key
# ---------------------------------------------------------------------------


@override_settings(AI_CATALOG_SIGNING_KEY="", AI_CATALOG_KEY_ID="k")
def test_missing_key_is_refused():
    with pytest.raises(catalog.CatalogRefused) as exc:
        catalog.load_signing_key()
    assert exc.value.reason == "signing_key_unconfigured"


@override_settings(AI_CATALOG_SIGNING_KEY=TEST1_SEED_HEX, AI_CATALOG_KEY_ID="")
def test_missing_key_id_is_refused():
    with pytest.raises(catalog.CatalogRefused) as exc:
        catalog.load_signing_key()
    assert exc.value.reason == "signing_key_unconfigured"


@pytest.mark.parametrize("seed", ["zz" * 32, "ab" * 31, "ab" * 33])
def test_malformed_key_is_refused_without_echoing_it(seed):
    with override_settings(AI_CATALOG_SIGNING_KEY=seed, AI_CATALOG_KEY_ID="k"):
        with pytest.raises(catalog.CatalogRefused) as exc:
            catalog.load_signing_key()
    assert exc.value.reason == "signing_key_malformed"
    assert seed not in str(exc.value)


@override_settings(AI_CATALOG_ALLOW_TEST_KEY=False)
def test_the_public_test_key_is_refused_outside_tests():
    with pytest.raises(catalog.CatalogRefused) as exc:
        catalog.load_signing_key()
    assert exc.value.reason == "test_key_not_allowed"


def test_a_real_key_loads_without_the_test_flag():
    seed = bytes(range(32)).hex()
    with override_settings(
        AI_CATALOG_SIGNING_KEY=seed, AI_CATALOG_KEY_ID="prod-1", AI_CATALOG_ALLOW_TEST_KEY=False
    ):
        key = catalog.load_signing_key()
    assert key.key_id == "prod-1"
    assert seed not in repr(key)


def test_deployed_settings_never_allow_the_test_key():
    from dj.free2z import settings as deployed

    assert deployed.AI_CATALOG_ALLOW_TEST_KEY is False
    source = (REPO / "py" / "free2z" / "dj" / "free2z" / "settings.py").read_text()
    assert TEST1_SEED_HEX not in source


# ---------------------------------------------------------------------------
# Building from the database
# ---------------------------------------------------------------------------

PRICES = dict(
    input_nusd_per_mtok=3_000_000_000,
    cached_input_nusd_per_mtok=300_000_000,
    cache_write_5m_nusd_per_mtok=3_750_000_000,
    cache_write_1h_nusd_per_mtok=6_000_000_000,
    output_nusd_per_mtok=15_000_000_000,
    image_nusd=0,
    tool_call_nusd=0,
)

# (provider, model, provider_model_id, api_style, max_tokens, max_response_tokens,
#  ttfb_ms, safety_bps, prices)
SAMPLE_MODELS = [
    ("anthropic", "claude-sonnet-5", "", "", 200_000, 64_000, 60_000, 11_500, PRICES),
    ("openai", "gpt-5.6-luna", "gpt-5.6-luna-2026-08-01", "openai_responses", 400_000,
     128_000, 90_000, 10_000,
     dict(PRICES, input_nusd_per_mtok=1_000_000_000, cached_input_nusd_per_mtok=1_000_000_000,
          cache_write_5m_nusd_per_mtok=1_000_000_000, cache_write_1h_nusd_per_mtok=1_000_000_000,
          output_nusd_per_mtok=6_000_000_000, image_nusd=0, tool_call_nusd=10_000_000)),
    ("xai", "grok-4.5", "", "", 256_000, 32_000, 60_000, 11_500,
     dict(PRICES, input_nusd_per_mtok=1_250_000_000, cached_input_nusd_per_mtok=1_250_000_000,
          cache_write_5m_nusd_per_mtok=1_250_000_000, cache_write_1h_nusd_per_mtok=1_250_000_000,
          output_nusd_per_mtok=2_500_000_000)),
]


def _ai_model(provider, model, provider_model_id="", api_style="", max_tokens=128_000,
              max_response_tokens=16_384, ttfb=60_000, safety=11_500,
              idle_timeout=60_000, **kw):
    return AIModel.objects.create(
        provider=provider, model=model, display_name=model, system_message="s",
        max_tokens=max_tokens, max_output_tokens=8192,
        max_response_tokens=max_response_tokens, provider_model_id=provider_model_id,
        api_style=api_style, ttfb_timeout_ms=ttfb, idle_timeout_ms=idle_timeout,
        safety_factor_bps=safety,
        is_ga=kw.pop("is_ga", True), **kw,
    )


def _usd_per_token(nusd_per_mtok):
    """nano-USD per Mtok -> the AIModel column's USD per token, exactly."""
    from decimal import Decimal

    return Decimal(nusd_per_mtok) / Decimal(10 ** 15)


def _at(unix, micros=0):
    return datetime.datetime.fromtimestamp(unix, tz=datetime.timezone.utc).replace(
        microsecond=micros)


# Content "last changed" a day before SAMPLE_NOW's window, so the sample's
# version is the window start and not the wall clock the test ran at.
SAMPLE_CONTENT_TS = catalog.window_start(SAMPLE_NOW) - 86_400


def _publish(card, at=SAMPLE_CONTENT_TS):
    RateCard.objects.filter(pk=card.pk).update(published_at=_at(at), active=True)
    card.refresh_from_db()
    return card


@pytest.fixture
def sample_dataset(db):
    """A fixed, seed-independent dataset: three GA models on three providers,
    a policy-disabled Kimi row that a stray ``update()`` left enabled, and a
    non-GA row -- neither of the last two may reach the catalogue."""
    AIModel.objects.all().delete()
    card = RateCard.objects.create(version=SAMPLE_CARD_VERSION, platform_margin_bps=2000)
    for provider, model, pmid, style, ctx, out, ttfb, safety, prices in SAMPLE_MODELS:
        # The Django row's recorded cost equals the card row: the signer
        # refuses to sell a card row BELOW it (card_below_model_cost).
        _ai_model(provider, model, pmid, style, ctx, out, ttfb, safety,
                  input_price=_usd_per_token(prices["input_nusd_per_mtok"]),
                  output_price=_usd_per_token(prices["output_nusd_per_mtok"]))
        RateCardModel.objects.create(rate_card=card, model_id=model, **prices)
    kimi = _ai_model("kimi", "kimi-k3")
    AIModel.objects.filter(pk=kimi.pk).update(is_enabled=True)
    RateCardModel.objects.create(rate_card=card, model_id="kimi-k3", **PRICES)
    _ai_model("openai", "gpt-3.5-turbo", is_ga=False)
    AIModel.objects.update(updated_at=_at(SAMPLE_CONTENT_TS))
    return _publish(card)


def test_build_happy_path(sample_dataset):
    AIModel.objects.filter(model="gpt-5.6-luna").update(idle_timeout_ms=240_000)
    c = catalog.build_catalog(SAMPLE_NOW)
    assert c["schema"] == 1
    assert c["issued_at"] == catalog.window_start(SAMPLE_NOW)
    assert c["version"] == c["issued_at"] * catalog.VERSION_UNITS_PER_SECOND
    assert c["expires_at"] == c["issued_at"] + 72 * 3600
    assert c["rate_card_version"] == SAMPLE_CARD_VERSION
    assert c["platform_margin_bps"] == 2000
    assert c["disabled_providers"] == ["kimi"]
    assert [m["id"] for m in c["models"]] == ["claude-sonnet-5", "gpt-5.6-luna", "grok-4.5"]
    by_id = {m["id"]: m for m in c["models"]}
    sonnet = by_id["claude-sonnet-5"]
    assert sonnet["provider_model_id"] == "claude-sonnet-5"
    assert sonnet["api_style"] == "anthropic_messages"
    assert sonnet["context_window"] == 200_000 and sonnet["max_output_tokens"] == 64_000
    assert sonnet["prices"]["cache_write_nusd_per_mtok"] == 3_750_000_000, "the 5m price"
    luna = by_id["gpt-5.6-luna"]
    assert luna["provider_model_id"] == "gpt-5.6-luna-2026-08-01"
    assert luna["api_style"] == "openai_responses"
    assert (luna["safety_factor_bps"], luna["ttfb_timeout_ms"],
            luna["idle_timeout_ms"]) == (10_000, 90_000, 240_000)
    assert by_id["grok-4.5"]["api_style"] == "openai_chat"
    assert all(m["enabled"] is True and m["min_charge_2z"] == 1 for m in c["models"])


def test_the_newest_active_card_wins(sample_dataset):
    newer = RateCard.objects.create(version=SAMPLE_CARD_VERSION + 1, platform_margin_bps=2500)
    for _, model, *_rest, prices in SAMPLE_MODELS:
        RateCardModel.objects.create(rate_card=newer, model_id=model, **prices)
    assert catalog.build_catalog(SAMPLE_NOW)["rate_card_version"] == SAMPLE_CARD_VERSION
    _publish(newer)
    c = catalog.build_catalog(SAMPLE_NOW)
    assert (c["rate_card_version"], c["platform_margin_bps"]) == (SAMPLE_CARD_VERSION + 1, 2500)


def _ids(c):
    return [m["id"] for m in c["models"]]


def _excluded(caplog):
    return {(p["model"], p["reason"]) for _, p in _events(caplog, catalog.AI_CATALOG_MODEL_EXCLUDED_EVENT)}


def test_a_model_without_a_rate_row_is_excluded_not_fatal(sample_dataset, caplog):
    _ai_model("anthropic", "claude-unpriced")
    with caplog.at_level(logging.ERROR, logger="dj.apps.pricing.catalog"):
        c = catalog.build_catalog(SAMPLE_NOW)
    assert _ids(c) == ["claude-sonnet-5", "gpt-5.6-luna", "grok-4.5"]
    assert ("claude-unpriced", "model_without_rate") in _excluded(caplog)


def test_duplicate_model_ids_exclude_every_row_sharing_the_id(sample_dataset, caplog):
    _ai_model("xai", "claude-sonnet-5")  # same public id, another provider
    with caplog.at_level(logging.ERROR, logger="dj.apps.pricing.catalog"):
        c = catalog.build_catalog(SAMPLE_NOW)
    assert _ids(c) == ["gpt-5.6-luna", "grok-4.5"]
    assert ("claude-sonnet-5", "duplicate_model_id") in _excluded(caplog)


def test_disabled_providers_are_excluded_not_published(sample_dataset):
    ids = _ids(catalog.build_catalog(SAMPLE_NOW))
    assert "kimi-k3" not in ids
    # Negative control: the row really is enabled in the column, so it is the
    # policy exclusion (AIModel.objects.enabled()) that keeps it out.
    assert AIModel.objects.get(model="kimi-k3").is_enabled is True


def test_a_disabled_provider_model_reaching_the_list_is_excluded(sample_dataset, monkeypatch, caplog):
    rows = catalog.catalogue_models() + [AIModel.objects.get(model="kimi-k3")]
    monkeypatch.setattr(catalog, "catalogue_models", lambda: rows)
    with caplog.at_level(logging.ERROR, logger="dj.apps.pricing.catalog"):
        c = catalog.build_catalog(SAMPLE_NOW)
    assert "kimi-k3" not in _ids(c)
    assert ("kimi-k3", "disabled_provider_model") in _excluded(caplog)


def test_a_model_whose_ceiling_exceeds_its_window_is_excluded(sample_dataset, caplog):
    AIModel.objects.filter(model="grok-4.5").update(max_response_tokens=300_000)
    with caplog.at_level(logging.ERROR, logger="dj.apps.pricing.catalog"):
        c = catalog.build_catalog(SAMPLE_NOW)
    assert "grok-4.5" not in _ids(c) and len(_ids(c)) == 2
    assert ("grok-4.5", "invalid_model") in _excluded(caplog)


@contextlib.contextmanager
def _image_guard_disabled():
    """The pricing_ratecard trigger refuses to publish this card; bypass just
    that guard to stand in for a provider edit made AFTER publication."""
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE pricing_ratecard DISABLE TRIGGER "
                       "pricing_ratecard_token_image_guard")
    try:
        yield
    finally:
        with connection.cursor() as cursor:
            cursor.execute("ALTER TABLE pricing_ratecard ENABLE TRIGGER "
                           "pricing_ratecard_token_image_guard")


@pytest.mark.parametrize("provider, model, excluded", [
    ("openai", "gpt-5.6-luna", True),
    ("anthropic", "claude-sonnet-5", True),
    ("xai", "grok-4.5", False),  # not in TOKEN_BILLED_IMAGE_PROVIDERS
])
def test_a_per_image_price_on_a_token_billed_provider_is_excluded(
        sample_dataset, caplog, provider, model, excluded):
    """: OpenAI and Anthropic bill images inside input tokens, so a
    per-image price on their models would double-charge. The model is left
    out; the rest of the catalogue is still signed (review of /)."""
    assert (provider in catalog.TOKEN_BILLED_IMAGE_PROVIDERS) is excluded
    card = RateCard.objects.create(version=SAMPLE_CARD_VERSION + 5, platform_margin_bps=2000)
    for _, mid, *_rest, prices in SAMPLE_MODELS:
        extra = {"image_nusd": 1_000_000} if mid == model else {}
        RateCardModel.objects.create(rate_card=card, model_id=mid, **dict(prices, **extra))
    with _image_guard_disabled() if excluded else contextlib.nullcontext():
        _publish(card)
    with caplog.at_level(logging.ERROR, logger="dj.apps.pricing.catalog"):
        c = catalog.build_catalog(SAMPLE_NOW)
    assert (model in _ids(c)) is not excluded
    assert ((model, "image_billed_as_tokens") in _excluded(caplog)) is excluded
    others = {m for _, m, *_r in SAMPLE_MODELS} - {model}
    assert others <= set(_ids(c))


def test_an_image_priced_row_never_blocks_a_kill_switch(sample_dataset, at_sample_now):
    """Review of: a published card prices grok-4.5 per image (legal --
    xAI bills images separately). An AIModel row that shares the
    (non-unique) model name but is token-billed, disabled and non-GA, and so
    never in the catalogue, must not refuse the whole document: an operator
    must still be able to kill-switch another model."""
    card = RateCard.objects.create(version=SAMPLE_CARD_VERSION + 7, platform_margin_bps=2000)
    for _, mid, *_rest, prices in SAMPLE_MODELS:
        extra = {"image_nusd": 1_000_000} if mid == "grok-4.5" else {}
        RateCardModel.objects.create(rate_card=card, model_id=mid, **dict(prices, **extra))
    RateCard.objects.exclude(pk=card.pk).update(active=False)
    _publish(card)
    _ai_model("openai", "grok-4.5", is_ga=False, is_enabled=False)
    AIModel.objects.filter(model="gpt-5.6-luna").update(is_enabled=False)
    response = APIClient().get(URL)
    assert response.status_code == 200, response.content
    ids = _ids(json.loads(response.content)["catalog"])
    assert "gpt-5.6-luna" not in ids
    assert "grok-4.5" in ids


def test_save_with_empty_update_fields_stays_a_no_op(sample_dataset):
    grok = AIModel.objects.get(model="grok-4.5")
    before = grok.updated_at
    grok.display_name = "not written"
    grok.save(update_fields=[])
    fresh = AIModel.objects.get(pk=grok.pk)
    assert fresh.updated_at == before and fresh.display_name == "grok-4.5"


def test_a_bad_model_never_blocks_a_kill_switch_on_another(sample_dataset, at_sample_now):
    """Review of: one GA model with no rate row blocked an emergency
    kill switch for up to 72 h. Now the bad model is omitted and the kill
    switch is published."""
    client = APIClient()
    _ai_model("anthropic", "claude-unpriced")
    before = json.loads(client.get(URL).content)["catalog"]
    assert "grok-4.5" in _ids(before)
    grok = AIModel.objects.get(model="grok-4.5")
    grok.is_enabled = False
    grok.save(update_fields=["is_enabled"])
    AIModel.objects.filter(pk=grok.pk).update(updated_at=_at(SAMPLE_NOW - 2))
    response = client.get(URL)
    assert response.status_code == 200
    after = json.loads(response.content)["catalog"]
    assert "grok-4.5" not in _ids(after)
    assert "claude-unpriced" not in _ids(after)
    assert after["version"] > before["version"]


def test_no_active_card_is_refused(sample_dataset):
    RateCard.objects.update(active=False)
    with pytest.raises(catalog.CatalogRefused) as exc:
        catalog.build_catalog(SAMPLE_NOW)
    assert exc.value.reason == "no_active_rate_card"


def test_every_model_off_publishes_an_empty_signed_catalogue(sample_dataset, at_sample_now):
    """Turning every model off must REACH the gateway: an empty catalogue is
    valid (the crate accepts it) and replaces the one with models enabled.
    Refusing it would leave those models callable for up to 72 h (codex)."""
    AIModel.objects.update(is_ga=False)
    c = catalog.build_catalog(SAMPLE_NOW)
    assert c["models"] == []
    response = APIClient().get(URL)
    assert response.status_code == 200
    assert json.loads(response.content)["catalog"]["models"] == []


def test_the_seeded_lineup_publishes_on_the_seeded_card(db):
    """The prod shape: seed_ai_models' LINEUP against the newest seed
    migration's card. Every GA, policy-enabled model has a rate row, so the
    endpoint does not refuse on day one."""
    from django.apps import apps

    frozen = importlib.import_module("dj.apps.pricing.migrations.0003_seed_rate_card_v1")
    frozen.seed(apps, None)
    call_command("seed_ai_models", stdout=open(os.devnull, "w"))
    c = catalog.build_catalog(SAMPLE_NOW)
    assert c["rate_card_version"] == RateCard.objects.filter(active=True).order_by("-version")[0].version
    ids = {m["id"] for m in c["models"]}
    expected = set(
        AIModel.objects.enabled().filter(is_ga=True).values_list("model", flat=True)
    )
    assert ids == expected and ids
    assert not any(m["provider"] == "kimi" for m in c["models"])


# ---------------------------------------------------------------------------
# 2. The Django-produced sample
# ---------------------------------------------------------------------------


def test_django_sample_is_reproduced_byte_for_byte(sample_dataset):
    """Regenerate with ``AI_CATALOG_WRITE_SAMPLE=1 pytest -k reproduced``."""
    signed = catalog.sign_catalog(catalog.build_catalog(SAMPLE_NOW), _test_key())
    if os.environ.get("AI_CATALOG_WRITE_SAMPLE") == "1":
        SAMPLE.parent.mkdir(parents=True, exist_ok=True)
        SAMPLE.write_bytes(signed.body)
    assert SAMPLE.read_bytes() == signed.body


def test_django_sample_verifies_under_an_independent_ed25519():
    body = SAMPLE.read_bytes()
    doc = json.loads(body)
    assert set(doc) == {"catalog", "signature"}
    assert doc["signature"]["key_id"] == "fixture-rfc8032-test1"
    # The served catalogue member IS its canonical form.
    canonical = catalog.canonical_json(doc["catalog"])
    assert canonical in body
    message = catalog.CATALOG_SIGNING_LABEL + canonical
    public = bytes.fromhex(TEST1_PUBLIC_HEX)
    signature = bytes.fromhex(doc["signature"]["signature_hex"])
    assert len(doc["signature"]["signature_hex"]) == 128
    assert doc["signature"]["signature_hex"] == doc["signature"]["signature_hex"].lower()
    assert ed25519_reference.verify(public, message, signature)
    Ed25519PublicKey.from_public_bytes(public).verify(signature, message)
    # Negative control: the same signature over a one-token price change.
    tampered = json.loads(json.dumps(doc["catalog"]))
    tampered["models"][0]["prices"]["output_nusd_per_mtok"] -= 1
    assert not ed25519_reference.verify(
        public, catalog.CATALOG_SIGNING_LABEL + catalog.canonical_json(tampered), signature)
    #...and without the label (domain separation is really in the message).
    assert not ed25519_reference.verify(public, canonical, signature)
    catalog.validate_catalog(doc["catalog"])
    assert doc["catalog"]["expires_at"] - SAMPLE_NOW > catalog.ALERT_REMAINING_SECONDS


# ---------------------------------------------------------------------------
# The endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def at_sample_now(monkeypatch):
    monkeypatch.setattr(catalog, "now_unix", lambda: SAMPLE_NOW)
    catalog._served_hours.clear()
    yield
    catalog._served_hours.clear()


def test_get_serves_the_signed_document(sample_dataset, at_sample_now):
    response = APIClient().get(URL)
    assert response.status_code == 200
    assert response["Content-Type"] == "application/json"
    assert response["Cache-Control"] == "no-cache"
    assert response.content == SAMPLE.read_bytes()
    assert response["ETag"] == '"' + hashlib.sha256(response.content).hexdigest() + '"'


def test_get_is_public_and_read_only(sample_dataset, at_sample_now):
    client = APIClient()
    assert client.get(URL).status_code == 200  # no credentials at all
    assert client.post(URL, {}).status_code == 405
    assert client.get(URL + "/").status_code == 404


@pytest.mark.parametrize("header, expected", [
    ("{etag}", 304),
    ("W/{etag}", 304),
    ('"other", {etag}', 304),
    ("*", 304),
    ('"other"', 200),
    ("", 200),
])
def test_if_none_match(sample_dataset, at_sample_now, header, expected):
    client = APIClient()
    etag = client.get(URL)["ETag"]
    kwargs = {"HTTP_IF_NONE_MATCH": header.format(etag=etag)} if header else {}
    response = client.get(URL, **kwargs)
    assert response.status_code == expected
    assert response["ETag"] == etag
    if expected == 304:
        assert response.content == b""


def test_the_etag_moves_with_the_window_and_the_content(sample_dataset, monkeypatch):
    client = APIClient()
    monkeypatch.setattr(catalog, "now_unix", lambda: SAMPLE_NOW)
    first = client.get(URL)
    monkeypatch.setattr(catalog, "now_unix", lambda: SAMPLE_NOW + 3)
    assert client.get(URL)["ETag"] == first["ETag"], "same window, same bytes"
    monkeypatch.setattr(catalog, "now_unix", lambda: catalog.window_start(SAMPLE_NOW) + 3600)
    later = client.get(URL, HTTP_IF_NONE_MATCH=first["ETag"])
    assert later.status_code == 200, "a new window is a new catalogue"
    assert json.loads(later.content)["catalog"]["version"] == (
        json.loads(first.content)["catalog"]["version"] + 3600 * catalog.VERSION_UNITS_PER_SECOND)
    AIModel.objects.filter(model="grok-4.5").update(ttfb_timeout_ms=30_000)
    assert client.get(URL)["ETag"] != later["ETag"], "content change, new bytes"


def test_the_kill_switch_gets_a_new_version_inside_the_window(sample_dataset, at_sample_now):
    """Codex review of: the gateway ignores an equal version, so turning
    a model off mid-window must MOVE the version, not wait for the hour."""
    client = APIClient()
    before = json.loads(client.get(URL).content)["catalog"]
    assert before["version"] == catalog.window_start(SAMPLE_NOW) * catalog.VERSION_UNITS_PER_SECOND
    grok = AIModel.objects.get(model="grok-4.5")
    grok.is_enabled = False
    grok.save()  # the admin's path; auto_now stamps updated_at
    # Pin the stamp to a moment inside the window (the real clock is later).
    AIModel.objects.filter(pk=grok.pk).update(updated_at=_at(SAMPLE_NOW - 10, 250))
    after = json.loads(client.get(URL).content)["catalog"]
    assert after["version"] == (SAMPLE_NOW - 10) * catalog.VERSION_UNITS_PER_SECOND + 250 > before["version"]
    assert after["issued_at"] == SAMPLE_NOW - 10
    assert after["expires_at"] == after["issued_at"] + catalog.VALIDITY_SECONDS
    assert "grok-4.5" not in [m["id"] for m in after["models"]]
    # And save() really does stamp it (the premise the pin stands in for).
    grok.save()
    assert AIModel.objects.get(pk=grok.pk).updated_at != _at(SAMPLE_NOW - 10, 250)


def test_the_version_moves_forward_across_windows(sample_dataset, monkeypatch):
    AIModel.objects.filter(model="grok-4.5").update(updated_at=_at(SAMPLE_NOW - 10))
    versions = []
    for t in (SAMPLE_NOW, SAMPLE_NOW + 1000, catalog.window_start(SAMPLE_NOW) + 3600):
        monkeypatch.setattr(catalog, "now_unix", lambda t=t: t)
        versions.append(catalog.build_catalog(catalog.now_unix())["version"])
    assert versions == sorted(versions) and versions[0] == (SAMPLE_NOW - 10) * catalog.VERSION_UNITS_PER_SECOND


def test_a_partial_save_kill_switch_moves_the_version(sample_dataset, at_sample_now, monkeypatch):
    """Codex round 4: save(update_fields=["is_enabled"]) -- the shape
    test_model_availability.py uses -- skipped auto_now's updated_at, so the
    disable went out under the OLD version and a running gateway ignored it."""
    before = catalog.build_catalog(SAMPLE_NOW)["version"]
    grok = AIModel.objects.get(model="grok-4.5")
    grok.is_enabled = False
    # auto_now reads django.utils.timezone.now(); put the save inside the window.
    from django.utils import timezone as dj_timezone

    monkeypatch.setattr(dj_timezone, "now", lambda: _at(SAMPLE_NOW - 3))
    grok.save(update_fields=["is_enabled"])
    stamped = AIModel.objects.get(pk=grok.pk).updated_at
    assert stamped == _at(SAMPLE_NOW - 3), "the partial save must stamp updated_at"
    after = catalog.build_catalog(SAMPLE_NOW)
    assert after["version"] > before
    assert "grok-4.5" not in [m["id"] for m in after["models"]]


def test_rolling_back_the_newest_card_does_not_lower_the_version(sample_dataset, at_sample_now):
    """Codex round 5: the version followed the SERVED card's published_at, so
    deactivating the newest card (a rollback) lowered it, and the gateway
    refused the rollback as a replay."""
    newer = RateCard.objects.create(version=SAMPLE_CARD_VERSION + 1, platform_margin_bps=2500)
    for _, model, *_rest, prices in SAMPLE_MODELS:
        RateCardModel.objects.create(rate_card=newer, model_id=model, **prices)
    _publish(newer, at=SAMPLE_NOW - 7)
    on_new = catalog.build_catalog(SAMPLE_NOW)
    assert on_new["rate_card_version"] == SAMPLE_CARD_VERSION + 1
    RateCard.objects.filter(pk=newer.pk).update(active=False)
    rolled_back = catalog.build_catalog(SAMPLE_NOW)
    assert rolled_back["rate_card_version"] == SAMPLE_CARD_VERSION
    assert rolled_back["version"] >= on_new["version"]
    #...and it reaches a running gateway within one window: the next minute
    # mints a strictly higher version.
    next_window = catalog.build_catalog(catalog.window_start(SAMPLE_NOW) + catalog.REISSUE_SECONDS)
    assert next_window["version"] > on_new["version"]
    assert next_window["rate_card_version"] == SAMPLE_CARD_VERSION


def test_a_future_revision_is_refused_not_signed(sample_dataset):
    """Codex round 6: a stamp from tomorrow would pin a version the gateway
    keeps (ignoring every correction as Unchanged) until the clock catches up."""
    tolerance = catalog.FUTURE_REVISION_TOLERANCE_SECONDS
    grok = AIModel.objects.filter(model="grok-4.5")
    grok.update(updated_at=_at(SAMPLE_NOW + tolerance))
    assert catalog.build_catalog(SAMPLE_NOW)["version"] == (SAMPLE_NOW + tolerance) * (
        catalog.VERSION_UNITS_PER_SECOND)  # writer clock skew inside the tolerance
    grok.update(updated_at=_at(SAMPLE_NOW + tolerance + 1))
    with pytest.raises(catalog.CatalogRefused) as exc:
        catalog.build_catalog(SAMPLE_NOW)
    assert exc.value.reason == "future_revision"


def test_deleting_the_newest_model_lowers_the_version_only_within_the_bound(
        sample_dataset, at_sample_now):
    """Review of: the version is NOT strictly monotone. Deleting the
    model with the newest updated_at drops the maximum -- but never below the
    window start, so the regression is bounded, and the next window
    overtakes it."""
    grok = AIModel.objects.filter(model="grok-4.5")
    grok.update(updated_at=_at(SAMPLE_NOW - 3))
    high = catalog.build_catalog(SAMPLE_NOW)["version"]
    grok.delete()
    low = catalog.build_catalog(SAMPLE_NOW)["version"]
    U = catalog.VERSION_UNITS_PER_SECOND
    assert low < high, "documented: this CAN go down"
    assert high - low <= catalog.VERSION_REGRESSION_BOUND_SECONDS * U
    assert low == catalog.window_start(SAMPLE_NOW) * U
    nxt = catalog.build_catalog(catalog.window_start(SAMPLE_NOW) + catalog.REISSUE_SECONDS)
    assert nxt["version"] > high


def test_the_regression_bound_covers_its_parts():
    assert catalog.VERSION_REGRESSION_BOUND_SECONDS >= (
        catalog.REISSUE_SECONDS + catalog.FUTURE_REVISION_TOLERANCE_SECONDS)


def test_two_edits_in_one_second_get_two_versions(sample_dataset, at_sample_now):
    """Codex round 3: second resolution collapsed them, and the gateway
    ignores the second as Unchanged."""
    grok = AIModel.objects.filter(model="grok-4.5")
    grok.update(updated_at=_at(SAMPLE_NOW - 10, 1))
    first = catalog.build_catalog(SAMPLE_NOW)["version"]
    grok.update(updated_at=_at(SAMPLE_NOW - 10, 2), is_ga=False)
    second = catalog.build_catalog(SAMPLE_NOW)
    assert second["version"] == first + 1
    assert first // catalog.VERSION_UNITS_PER_SECOND == second["issued_at"]


def test_the_revision_is_read_before_the_content(sample_dataset, monkeypatch):
    """Codex round 3: a disable committing between the two reads must never
    put the OLD model list under the NEW revision. Simulated by committing
    the disable from inside the content read."""
    original = catalog.catalogue_models
    order = []

    def revision_then(card):
        order.append("revision")
        return real_revision(card)

    def content_with_a_concurrent_disable():
        order.append("content")
        AIModel.objects.filter(model="grok-4.5").update(
            is_enabled=False, updated_at=_at(SAMPLE_NOW - 5))
        return original()

    real_revision = catalog.content_revision
    monkeypatch.setattr(catalog, "content_revision", revision_then)
    monkeypatch.setattr(catalog, "catalogue_models", content_with_a_concurrent_disable)
    racing = catalog.build_catalog(SAMPLE_NOW)
    assert order == ["revision", "content"]
    disable_version = (SAMPLE_NOW - 5) * catalog.VERSION_UNITS_PER_SECOND
    # Fresh content under the OLD revision -- never stale content under the new.
    assert racing["version"] < disable_version
    assert "grok-4.5" not in [m["id"] for m in racing["models"]]
    monkeypatch.setattr(catalog, "catalogue_models", original)
    assert catalog.build_catalog(SAMPLE_NOW)["version"] == disable_version


def test_version_units_stay_inside_the_canonical_range():
    year_2255 = 9_000_000_000
    assert year_2255 * catalog.VERSION_UNITS_PER_SECOND < catalog.MAX_SAFE_INTEGER


def _events(caplog, event):
    found = []
    for record in caplog.records:
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if payload.get("event") == event:
            found.append((record, payload))
    return found


@pytest.mark.parametrize("setup, reason", [
    (lambda: RateCard.objects.update(active=False), "no_active_rate_card"),
    (lambda: AIModel.objects.filter(model="grok-4.5").update(
        updated_at=_at(SAMPLE_NOW + 3600)), "future_revision"),
])
def test_a_whole_document_refusal_is_409_with_an_alert_line(
        sample_dataset, at_sample_now, caplog, setup, reason):
    setup()
    with caplog.at_level(logging.ERROR, logger="dj.apps.pricing.catalog"):
        response = APIClient().get(URL)
    assert response.status_code == 409
    assert json.loads(response.content) == {"code": "catalog_refused", "reason": reason}
    assert response["Cache-Control"] == "no-store"
    assert "ETag" not in response
    [(record, payload)] = _events(caplog, catalog.AI_CATALOG_REFUSED_EVENT)
    assert record.levelno == logging.ERROR
    assert payload["reason"] == reason and payload["severity"] == "ERROR"


@pytest.mark.parametrize("key, key_id", [("", "k"), (TEST1_SEED_HEX, "")])
def test_an_unprovisioned_key_is_404_logged_not_alerted(
        sample_dataset, at_sample_now, caplog, key, key_id):
    with override_settings(AI_CATALOG_SIGNING_KEY=key, AI_CATALOG_KEY_ID=key_id):
        with caplog.at_level(logging.INFO, logger="dj.apps.pricing.catalog"):
            response = APIClient().get(URL)
    assert response.status_code == 404
    assert json.loads(response.content) == {"code": "catalog_not_provisioned"}
    assert _events(caplog, catalog.AI_CATALOG_NOT_PROVISIONED_EVENT)
    assert not _events(caplog, catalog.AI_CATALOG_REFUSED_EVENT), "must not page"


@pytest.mark.parametrize("settings_kw", [
    {"AI_CATALOG_SIGNING_KEY": "zz" * 32},
    {"AI_CATALOG_ALLOW_TEST_KEY": False},
])
def test_a_bad_key_is_409(sample_dataset, at_sample_now, settings_kw):
    with override_settings(**settings_kw):
        response = APIClient().get(URL)
    assert response.status_code == 409
    assert json.loads(response.content)["code"] == "catalog_refused"


REFUSAL_SETUPS = {
    "key_missing": lambda: override_settings(AI_CATALOG_SIGNING_KEY=""),
    "key_id_missing": lambda: override_settings(AI_CATALOG_KEY_ID=""),
    "key_malformed": lambda: override_settings(AI_CATALOG_SIGNING_KEY="ab"),
    "test_key": lambda: override_settings(AI_CATALOG_ALLOW_TEST_KEY=False),
}


@pytest.mark.parametrize("refusal", [
    "key_missing", "key_id_missing", "key_malformed", "test_key", "no_active_card",
    "future_revision", "unpriced_model", "duplicate", "all_zero", "bad_limits",
    "image_rule", "no_models",
])
def test_no_refusal_path_returns_5xx(sample_dataset, at_sample_now, monkeypatch, refusal):
    """Review of: a public route must not 5xx on a refusal -- it feeds
    the page-tier LB alerts. Every refusal and exclusion path, one by one."""
    import contextlib

    ctx = REFUSAL_SETUPS.get(refusal, contextlib.nullcontext)()
    grok = AIModel.objects.filter(model="grok-4.5")
    if refusal == "no_active_card":
        RateCard.objects.update(active=False)
    elif refusal == "future_revision":
        grok.update(updated_at=_at(SAMPLE_NOW + 3600))
    elif refusal == "unpriced_model":
        _ai_model("anthropic", "claude-unpriced")
    elif refusal == "duplicate":
        _ai_model("xai", "claude-sonnet-5")
    elif refusal == "bad_limits":
        grok.update(max_response_tokens=10_000_000)
    elif refusal == "no_models":
        AIModel.objects.update(is_ga=False)
    elif refusal in ("all_zero", "image_rule"):
        # The DB CHECK forbids all-zero rows, so feed the builder directly.
        real = catalog.validate_model

        def poisoned(model, disabled=()):
            if model["id"] == "grok-4.5":
                model = json.loads(json.dumps(model))
                if refusal == "all_zero":
                    model["prices"] = dict.fromkeys(model["prices"], 0)
                else:
                    model["provider"], model["prices"]["image_nusd"] = "openai", 5
            return real(model, disabled)

        monkeypatch.setattr(catalog, "validate_model", poisoned)
    with ctx:
        response = APIClient().get(URL)
    assert response.status_code < 500, (refusal, response.status_code, response.content)
    assert response.status_code in (200, 404, 409)
    if refusal == "image_rule":
        # Review of: the image rule EXCLUDES the model; it must never
        # refuse the whole document (that would freeze every kill switch).
        assert response.status_code == 200
        assert "grok-4.5" not in _ids(json.loads(response.content)["catalog"])


def test_served_is_logged_once_per_version_per_process(sample_dataset, monkeypatch, caplog):
    catalog._served_hours.clear()
    client = APIClient()
    with caplog.at_level(logging.INFO, logger="dj.apps.pricing.catalog"):
        monkeypatch.setattr(catalog, "now_unix", lambda: SAMPLE_NOW)
        etag = client.get(URL)["ETag"]
        client.get(URL, HTTP_IF_NONE_MATCH=etag)
        client.get(URL)
        monkeypatch.setattr(catalog, "now_unix", lambda: SAMPLE_NOW + 3600)
        client.get(URL)
    served = _events(caplog, catalog.AI_CATALOG_SERVED_EVENT)
    assert [p["version"] for _, p in served] == [
        catalog.window_start(SAMPLE_NOW) * catalog.VERSION_UNITS_PER_SECOND,
        (catalog.window_start(SAMPLE_NOW) + 3600) * catalog.VERSION_UNITS_PER_SECOND]
    assert all(p["remaining_seconds"] > catalog.ALERT_REMAINING_SECONDS for _, p in served)
    catalog._served_hours.clear()


GATEWAY_USER_AGENT = "f2z-ai/0.1.0"


@pytest.mark.parametrize("user_agent, expected", [
    ("f2z-ai/0.1.0", catalog.SERVED_CLIENT_GATEWAY),
    ("f2z-ai/0.1.0 (linux; x86_64) reqwest", catalog.SERVED_CLIENT_GATEWAY),
    ("  f2z-ai/1  ", catalog.SERVED_CLIENT_GATEWAY),
    (None, catalog.SERVED_CLIENT_OTHER),
    ("", catalog.SERVED_CLIENT_OTHER),
    ("curl/8.7.1", catalog.SERVED_CLIENT_OTHER),
    ("f2z-ai", catalog.SERVED_CLIENT_OTHER),
    ("f2z-ai/", catalog.SERVED_CLIENT_OTHER),
    ("F2Z-AI/0.1.0", catalog.SERVED_CLIENT_OTHER),
    ("f2z-ai-scanner/1.0", catalog.SERVED_CLIENT_OTHER),
    ("Mozilla/5.0 f2z-ai/0.1.0", catalog.SERVED_CLIENT_OTHER),
    ("f2z-sdk/0.3.0", catalog.SERVED_CLIENT_OTHER),
])
def test_only_the_gateway_user_agent_counts_as_the_gateway(user_agent, expected):
    assert catalog.served_client(user_agent) == expected








# ---------------------------------------------------------------------------
# Monitoring: the declared filters match what the code emits
# ---------------------------------------------------------------------------






# ---------------------------------------------------------------------------
# manage.py ai_catalog
# ---------------------------------------------------------------------------


def test_command_prints_the_served_body(sample_dataset):
    import io

    out = io.StringIO()
    call_command("ai_catalog", "--now", str(SAMPLE_NOW), stdout=out)
    assert out.getvalue().rstrip("\n").encode() == SAMPLE.read_bytes()


def test_command_prints_the_public_key():
    import io

    out = io.StringIO()
    call_command("ai_catalog", "--public-key", stdout=out)
    assert out.getvalue().split() == ["fixture-rfc8032-test1", TEST1_PUBLIC_HEX]


@override_settings(AI_CATALOG_SIGNING_KEY="")
def test_command_fails_loudly_when_the_endpoint_would_refuse():
    from django.core.management.base import CommandError

    with pytest.raises(CommandError, match="signing_key_unconfigured"):
        call_command("ai_catalog", "--public-key")


@pytest.mark.parametrize("capabilities", [None, [], True, "tools", {"tools": 1},
    {"tools": "true"}, {"vision": None}, {"tool": True},
    {"structured_output": None}, {"structured_output": "true"}, {"structured_output": 1},
    {"structuredOutput": True},
    {"strict_tools": None}, {"strict_tools": "true"}, {"strict_tools": 0},
    {"strictTools": True}, {"strict": True},
    {"reasoning_effort": None}, {"reasoning_effort": "low"}, {"reasoning_effort": 1},
    {"reasoningEffort": True}, {"effort": True}])
def test_capabilities_refuse_non_boolean_or_unknown_policy(capabilities):
    model = json.loads((CRATE / "catalog.json").read_text())["models"][0]
    model["capabilities"] = capabilities
    with pytest.raises(catalog.CatalogRefused, match="invalid capabilities"):
        catalog.validate_model(model)


@pytest.mark.parametrize("capabilities", [{}, {"tools": False}, {"tools": True},
    {"vision": False, "tools": True, "reasoning": True},
    {"structured_output": True}, {"structured_output": False},
    {"vision": False, "tools": False, "reasoning": False, "structured_output": True},
    {"strict_tools": True}, {"strict_tools": False},
    {"vision": False, "tools": True, "reasoning": False, "structured_output": True,
     "strict_tools": True},
    {"reasoning_effort": True}, {"reasoning_effort": False},
    {"reasoning": True, "reasoning_effort": True}])
def test_optional_capability_members_follow_the_public_boolean_contract(capabilities):
    model = json.loads((CRATE / "catalog.json").read_text())["models"][0]
    catalog.validate_model(model)  # absent remains compatible
    model["capabilities"] = capabilities
    catalog.validate_model(model)



ALL_FALSE = {"vision": False, "tools": False, "reasoning": False, "structured_output": False,
             "strict_tools": False, "reasoning_effort": False}


def test_default_capabilities_do_not_guess_from_model_names(sample_dataset):
    """Every model carries every member, explicitly -- including the OpenAI
    Chat model ``gpt-4o``-shaped rows: the builder never infers support from a
    provider or a name; only the column says so."""
    document = catalog.build_catalog(SAMPLE_NOW)
    assert document["schema"] == 1
    assert [m["capabilities"] for m in document["models"]] == [ALL_FALSE] * 3
    assert catalog.sign_catalog(document, _test_key()).body == SAMPLE.read_bytes()


def test_structured_output_is_always_signed_explicitly(sample_dataset):
    """An ABSENT ``structured_output`` is not false at the gateway (zuu#1128):
    it applies an interim ``provider == "openai"`` rule. So a declared false
    must be on the wire, for every model, or the refusal is not signed."""
    AIModel.objects.filter(model="gpt-5.6-luna").update(supports_structured_output=True)
    by_id = {m["id"]: m for m in catalog.build_catalog(SAMPLE_NOW)["models"]}
    assert by_id["gpt-5.6-luna"]["capabilities"] == {**ALL_FALSE, "structured_output": True}
    # grok is OpenAI-compatible Chat: the interim rule would refuse it anyway,
    # but the declaration is signed regardless of what a gateway would infer.
    assert by_id["grok-4.5"]["capabilities"]["structured_output"] is False
    assert by_id["claude-sonnet-5"]["capabilities"]["structured_output"] is False
    for doc in by_id.values():
        assert "structured_output" in doc["capabilities"], doc["id"]


def test_strict_tools_is_always_signed_explicitly(sample_dataset):
    """Same tri-state as ``structured_output`` (zuu#1142): an ABSENT
    ``strict_tools`` makes the gateway apply ``provider == "openai"``, so a
    declared false must be on the wire for every model -- including the
    OpenAI row with tools on and strict off, which the interim rule would
    otherwise turn on."""
    AIModel.objects.filter(model="gpt-5.6-luna").update(supports_tools=True)
    by_id = {m["id"]: m for m in catalog.build_catalog(SAMPLE_NOW)["models"]}
    assert by_id["gpt-5.6-luna"]["capabilities"] == {**ALL_FALSE, "tools": True}
    AIModel.objects.filter(model="gpt-5.6-luna").update(supports_strict_tools=True)
    by_id = {m["id"]: m for m in catalog.build_catalog(SAMPLE_NOW)["models"]}
    assert by_id["gpt-5.6-luna"]["capabilities"] == {
        **ALL_FALSE, "tools": True, "strict_tools": True}
    for doc in by_id.values():
        assert type(doc["capabilities"]["strict_tools"]) is bool, doc["id"]
    assert by_id["grok-4.5"]["capabilities"]["strict_tools"] is False


def test_explicit_capability_policy_is_signed_and_partial_saves_advance_revision(
        sample_dataset, at_sample_now, monkeypatch):
    from django.utils import timezone as dj_timezone

    before = catalog.build_catalog(SAMPLE_NOW)
    model = AIModel.objects.get(model="grok-4.5")
    model.supports_tools = True
    model.supports_reasoning = True
    monkeypatch.setattr(dj_timezone, "now", lambda: _at(SAMPLE_NOW - 3))
    model.save(update_fields=["supports_tools", "supports_reasoning"])
    after = catalog.build_catalog(SAMPLE_NOW)
    assert after["version"] > before["version"]
    assert after["schema"] == before["schema"] == 1
    projected = next(m for m in after["models"] if m["id"] == model.model)
    assert projected["capabilities"] == {**ALL_FALSE, "tools": True, "reasoning": True}
    assert all(m["capabilities"] == ALL_FALSE for m in after["models"] if m["id"] != model.model)
    signed = catalog.sign_catalog(after, _test_key())
    signature = bytes.fromhex(signed.signature_hex)
    public = bytes.fromhex(TEST1_PUBLIC_HEX)
    assert ed25519_reference.verify(public, catalog.signing_message(after), signature)
    # A valid Boolean edit is still a signature change, not unsigned metadata.
    projected["capabilities"]["tools"] = False
    assert not ed25519_reference.verify(public, catalog.signing_message(after), signature)
    # Disabling the policy also moves the version and restores all-false.
    monkeypatch.setattr(dj_timezone, "now", lambda: _at(SAMPLE_NOW - 2))
    model.supports_tools = model.supports_reasoning = False
    model.save(update_fields=["supports_tools", "supports_reasoning"])
    disabled = catalog.build_catalog(SAMPLE_NOW)
    assert disabled["version"] > after["version"]
    assert all(m["capabilities"] == ALL_FALSE for m in disabled["models"])



def test_catalogue_response_schema_preserves_optional_capability_policy():
    from rest_framework.fields import empty

    from dj.apps.pricing.serializers import CatalogModelSerializer

    model = json.loads((CRATE / "catalog.json").read_text())["models"][0]
    model["idle_timeout_ms"] = 60_000
    assert CatalogModelSerializer(model).data["idle_timeout_ms"] == 60_000
    assert "capabilities" not in CatalogModelSerializer(model).data
    model["capabilities"] = {"tools": True}
    # reasoning_effort is NOT tri-state at the gateway (absent = false), so
    # the schema's default is false like vision/tools/reasoning.
    assert CatalogModelSerializer(model).data["capabilities"] == {
        "tools": True, "vision": False, "reasoning": False, "reasoning_effort": False,
    }
    field = CatalogModelSerializer().fields["capabilities"]
    assert not field.required and not field.allow_null
    members = dict(field.fields)
    for name in ("structured_output", "strict_tools"):
        undeclared = members.pop(name)
        # Tri-state at the gateway: absent must stay absent, never become false.
        assert not undeclared.required and undeclared.default is empty, name
        assert name not in CatalogModelSerializer(model).data["capabilities"]
    assert all(not member.required and member.default is False for member in members.values())
    model["capabilities"] = {"structured_output": False, "strict_tools": False}
    data = CatalogModelSerializer(model).data["capabilities"]
    assert data["structured_output"] is False and data["strict_tools"] is False


# ------------------------------------------------ reasoning_effort (zuu#1170)


def test_reasoning_effort_and_its_levels_are_signed_per_model(sample_dataset):
    """``capabilities.reasoning_effort`` is signed explicitly on every model;
    ``controls.effort_levels`` only where the capability is on AND a list is
    recorded, so a model without it signs exactly as before (no ``controls``
    member at all)."""
    AIModel.objects.filter(model="gpt-5.6-luna").update(
        supports_reasoning_effort=True,
        reasoning_effort_levels=["low", "medium", "high", "xhigh"])
    by_id = {m["id"]: m for m in catalog.build_catalog(SAMPLE_NOW)["models"]}
    luna = by_id["gpt-5.6-luna"]
    assert luna["capabilities"] == {**ALL_FALSE, "reasoning_effort": True}
    assert luna["controls"] == {"effort_levels": ["low", "medium", "high", "xhigh"]}
    for other in ("grok-4.5", "claude-sonnet-5"):
        assert by_id[other]["capabilities"]["reasoning_effort"] is False
        assert "controls" not in by_id[other]
    # Declared with no list: signed, not narrowed (the gateway forwards).
    AIModel.objects.filter(model="gpt-5.6-luna").update(reasoning_effort_levels=[])
    luna = {m["id"]: m for m in catalog.build_catalog(SAMPLE_NOW)["models"]}["gpt-5.6-luna"]
    assert luna["capabilities"]["reasoning_effort"] is True and "controls" not in luna


def test_a_level_list_left_on_a_disabled_row_is_not_signed_and_never_excludes(
        sample_dataset):
    """An operator who turns the capability off in the admin must not take
    the model off the shelf: the stale list is simply not signed."""
    AIModel.objects.filter(model="grok-4.5").update(
        supports_reasoning_effort=False, reasoning_effort_levels=["low", "high"])
    by_id = {m["id"]: m for m in catalog.build_catalog(SAMPLE_NOW)["models"]}
    assert "grok-4.5" in by_id
    assert by_id["grok-4.5"]["capabilities"]["reasoning_effort"] is False
    assert "controls" not in by_id["grok-4.5"]


@pytest.mark.parametrize("stored", [1, True, 0, {}, {"low": True}, "low", ["low", "low"],
                                    ["ultra"], [1.5]])
def test_a_malformed_stored_level_list_excludes_only_that_model(sample_dataset, caplog, stored):
    """``QuerySet.update()`` bypasses the field validator. Whatever is stored,
    the build must not crash (it would stop every catalogue, kill switches
    included) or reshape it: the one model is excluded with an alerted line
    and every other model still ships."""
    AIModel.objects.filter(model="grok-4.5").update(
        supports_reasoning_effort=True, reasoning_effort_levels=stored)
    with caplog.at_level(logging.WARNING):
        document = catalog.build_catalog(SAMPLE_NOW)
    assert [m["id"] for m in document["models"]] == ["claude-sonnet-5", "gpt-5.6-luna"]
    assert catalog.AI_CATALOG_MODEL_EXCLUDED_EVENT in caplog.text
    # Negative control: a well-formed list on the same row ships.
    AIModel.objects.filter(model="grok-4.5").update(reasoning_effort_levels=["low"])
    assert "grok-4.5" in [m["id"] for m in catalog.build_catalog(SAMPLE_NOW)["models"]]


def test_signed_levels_change_the_signature(sample_dataset, at_sample_now, monkeypatch):
    from django.utils import timezone as dj_timezone

    before = catalog.build_catalog(SAMPLE_NOW)
    model = AIModel.objects.get(model="grok-4.5")
    model.supports_reasoning_effort = True
    model.reasoning_effort_levels = ["low", "medium", "high"]
    monkeypatch.setattr(dj_timezone, "now", lambda: _at(SAMPLE_NOW - 3))
    model.save(update_fields=["supports_reasoning_effort", "reasoning_effort_levels"])
    after = catalog.build_catalog(SAMPLE_NOW)
    assert after["version"] > before["version"]
    signed = catalog.sign_catalog(after, _test_key())
    signature = bytes.fromhex(signed.signature_hex)
    public = bytes.fromhex(TEST1_PUBLIC_HEX)
    assert ed25519_reference.verify(public, catalog.signing_message(after), signature)
    grok = next(m for m in after["models"] if m["id"] == "grok-4.5")
    grok["controls"]["effort_levels"].append("xhigh")
    assert not ed25519_reference.verify(public, catalog.signing_message(after), signature)


def _effort_model(controls, reasoning_effort=True):
    model = json.loads((CRATE / "catalog.json").read_text())["models"][0]
    model["capabilities"] = {"reasoning_effort": reasoning_effort}
    model["controls"] = controls
    return model


@pytest.mark.parametrize("controls", [
    None, [], "low", {"effort_levels": None}, {"effort_levels": []},
    {"effort_levels": "low"}, {"effort_levels": ["low", "low"]},
    {"effort_levels": ["High"]}, {"effort_levels": ["ultra"]}, {"effort_levels": [1]},
    {"effort_levels": ["low"], "effort_budgets": {}}, {"effortLevels": ["low"]},
])
def test_controls_refuse_anything_but_a_distinct_known_level_list(controls):
    with pytest.raises(catalog.CatalogRefused, match="invalid controls"):
        catalog.validate_model(_effort_model(controls))


@pytest.mark.parametrize("controls", [
    {}, {"effort_levels": ["low"]}, {"effort_levels": ["minimal", "low", "medium", "high"]},
    # Levels the gateway's wire cannot express are inert there (crate
    # ``ModelControls``), so a model page's full list may be signed.
    {"effort_levels": ["none", "low", "medium", "high", "xhigh", "max"]},
])
def test_controls_accept_known_levels(controls):
    catalog.validate_model(_effort_model(controls))


def test_effort_levels_without_the_capability_are_refused():
    """A list never grants at the gateway, but it reads like a grant."""
    for declared in (False, None):
        model = _effort_model({"effort_levels": ["low"]}, reasoning_effort=declared)
        if declared is None:
            model["capabilities"] = {}
        with pytest.raises(catalog.CatalogRefused, match="without reasoning_effort"):
            catalog.validate_model(model)
    # Negative control: the same document with the capability on passes.
    catalog.validate_model(_effort_model({"effort_levels": ["low"]}))


def test_effort_level_vocabulary_matches_the_model_validator():
    from dj.apps.openai.models import REASONING_EFFORT_LEVELS

    assert set(REASONING_EFFORT_LEVELS) == catalog.EFFORT_LEVELS


# ---------------------------------------------------------------------------
# discovered ∩ priced ∩ enabled ( follow-up): the gate, the cost floor
# and the long-context cap, each with its negative control
# ---------------------------------------------------------------------------


def _listed(provider, model_id, missing=False):
    from dj.apps.openai.models import ProviderModel

    now = datetime.datetime.now(tz=datetime.timezone.utc)
    return ProviderModel.objects.create(
        provider=provider, provider_model_id=model_id, first_seen_at=now,
        last_seen_at=now, availability_changed_at=now,
        missing_since=now if missing else None)


def test_without_a_snapshot_the_catalogue_is_not_gated(sample_dataset):
    assert _ids(catalog.build_catalog(SAMPLE_NOW)) == ["claude-sonnet-5", "gpt-5.6-luna", "grok-4.5"]


def test_a_model_its_provider_does_not_list_is_excluded_not_sold(sample_dataset, caplog):
    _listed("openai", "gpt-4o")  # a snapshot exists for openai; luna's upstream id is not in it
    with caplog.at_level(logging.WARNING, logger="dj.apps.pricing.catalog"):
        c = catalog.build_catalog(SAMPLE_NOW)
    assert _ids(c) == ["claude-sonnet-5", "grok-4.5"], "anthropic/xai have no snapshot: still open"
    # A WARNING on its own event, not the paging exclusion event: a model the
    # key cannot reach is a steady state for a human, not a page.
    assert _excluded(caplog) == set()
    [(record, payload)] = _events(caplog, catalog.AI_CATALOG_MODEL_NOT_DISCOVERED_EVENT)
    assert record.levelno == logging.WARNING
    assert (payload["model"], payload["upstream_model_id"]) == ("gpt-5.6-luna", "gpt-5.6-luna-2026-08-01")
    # Negative control: list the UPSTREAM id (a pinned snapshot) and it is back.
    _listed("openai", "gpt-5.6-luna-2026-08-01")
    assert "gpt-5.6-luna" in _ids(catalog.build_catalog(SAMPLE_NOW))
    #...and a model the provider withdrew leaves again.
    from dj.apps.openai.models import ProviderModel

    ProviderModel.objects.filter(provider_model_id="gpt-5.6-luna-2026-08-01").update(
        missing_since=_at(SAMPLE_CONTENT_TS))
    assert "gpt-5.6-luna" not in _ids(catalog.build_catalog(SAMPLE_NOW))


def test_a_discovery_change_moves_the_version(sample_dataset):
    base = catalog.build_catalog(SAMPLE_NOW)["version"]
    assert base == catalog.window_start(SAMPLE_NOW) * catalog.VERSION_UNITS_PER_SECOND
    later = catalog.window_start(SAMPLE_NOW) + 5
    from dj.apps.openai.models import ProviderModel

    ProviderModel.objects.create(
        provider="xai", provider_model_id="grok-4.5", first_seen_at=_at(later),
        last_seen_at=_at(later), availability_changed_at=_at(later))
    assert catalog.build_catalog(SAMPLE_NOW)["version"] == later * catalog.VERSION_UNITS_PER_SECOND
    # last_seen_at alone (every run) does NOT mint a version.
    ProviderModel.objects.update(last_seen_at=_at(later + 30))
    assert catalog.build_catalog(SAMPLE_NOW)["version"] == later * catalog.VERSION_UNITS_PER_SECOND
    # Going missing, and coming back, each do (availability_changed_at).
    ProviderModel.objects.update(missing_since=_at(later + 40), availability_changed_at=_at(later + 40))
    assert catalog.build_catalog(SAMPLE_NOW)["version"] == (later + 40) * catalog.VERSION_UNITS_PER_SECOND
    ProviderModel.objects.update(missing_since=None, availability_changed_at=_at(later + 50))
    assert catalog.build_catalog(SAMPLE_NOW)["version"] == (later + 50) * catalog.VERSION_UNITS_PER_SECOND


def test_a_card_row_below_the_models_recorded_cost_is_excluded(sample_dataset, caplog):
    """ item 3, as a control: v2 sold grok-4.5 at $1.25 / $2.50 while the
    Django row said $2 / $6. The signer refuses to sell that row."""
    AIModel.objects.filter(model="grok-4.5").update(
        input_price="0.000002", output_price="0.000006")  # xAI's price; card row is 1.25 / 2.50
    with caplog.at_level(logging.ERROR, logger="dj.apps.pricing.catalog"):
        c = catalog.build_catalog(SAMPLE_NOW)
    assert "grok-4.5" not in _ids(c)
    assert ("grok-4.5", "card_below_model_cost") in _excluded(caplog)
    assert "claude-sonnet-5" in _ids(c), "per-model, never document-wide"
    # Negative control: a recorded cost AT the card row (or below) sells. The
    # published card itself is immutable (0002's trigger), so the cost side
    # is the one that moves here -- in prod it is a NEW card that moves.
    AIModel.objects.filter(model="grok-4.5").update(
        input_price="0.00000125", output_price="0.0000025")
    assert "grok-4.5" in _ids(catalog.build_catalog(SAMPLE_NOW))
    # Only one side below is still below.
    AIModel.objects.filter(model="grok-4.5").update(output_price="0.000002501")
    assert "grok-4.5" not in _ids(catalog.build_catalog(SAMPLE_NOW))


def test_the_seeded_lineup_passes_the_cost_floor_and_the_caps(db):
    """Every permitted lineup row has a price at the Django cost floor and
    every tiered window is below its threshold. Historical prices for retired
    models stay on the immutable card without admitting new calls."""
    from django.core.management import call_command

    from dj.apps.openai.management.commands import seed_ai_models
    from dj.apps.openai.models import ProviderModel

    ProviderModel.objects.all().delete()
    call_command("seed_ai_models", stdout=io.StringIO())
    card = catalog.active_rate_card()
    assert card.version == rate_card_seeds_newest_version()
    c = catalog.build_catalog(SAMPLE_NOW + 1)
    retired = {"gpt-4.1-nano", "o1", "o3-mini", "o4-mini"}
    assert retired <= set(card.model_rows.values_list("model_id", flat=True))
    expected = sorted(m for p, m, *_ in seed_ai_models.LINEUP if p != "kimi" and m not in retired)
    assert sorted(_ids(c)) == expected  # the builder orders by DB collation
    by_id = {m["id"]: m for m in c["models"]}
    for model in ("gpt-5.4",):
        assert by_id[model]["context_window"] == 236_000
        assert by_id[model]["max_output_tokens"] == 128_000
        assert by_id[model]["capabilities"] == {
            "tools": True, "vision": False, "reasoning": True, "structured_output": True,
            "strict_tools": True, "reasoning_effort": True}
        assert by_id[model]["controls"] == {"effort_levels": ["low", "medium", "high", "xhigh"]}
    # OpenAI documents no Chat Completions tool calling for these at the
    # gateway's default reasoning effort (migration 0027).
    for model in ("gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
                  "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"):
        assert by_id[model]["context_window"] == 236_000
        assert by_id[model]["max_output_tokens"] == 128_000
        assert by_id[model]["capabilities"] == {
            "tools": False, "vision": False, "reasoning": True, "structured_output": True,
            "strict_tools": False, "reasoning_effort": True}
        assert by_id[model]["controls"]["effort_levels"][-1] == "xhigh"
    for model in ("grok-4.5", "claude-sonnet-5"):
        assert by_id[model]["capabilities"]["tools"] is False
        assert by_id[model]["capabilities"]["strict_tools"] is False
    assert by_id["grok-4.5"]["context_window"] == by_id["grok-4.3"]["context_window"] == 172_000
    # reasoning_effort (migration 0028): per-model levels, never inferred.
    assert by_id["o3"]["controls"] == {"effort_levels": ["low", "medium", "high"]}
    assert by_id["gpt-5-nano"]["controls"] == {
        "effort_levels": ["minimal", "low", "medium", "high"]}
    assert by_id["gpt-5.1"]["controls"] == {"effort_levels": ["low", "medium", "high"]}
    assert by_id["grok-4.5"]["capabilities"]["reasoning_effort"] is True
    assert by_id["grok-4.5"]["controls"] == {"effort_levels": ["low", "medium", "high"]}
    for model in ("gpt-4o", "gpt-4o-mini", "gpt-4.1", "grok-4.3", "claude-sonnet-5"):
        assert by_id[model]["capabilities"]["reasoning_effort"] is False, model
        assert "controls" not in by_id[model], model
    assert by_id["gpt-4o"]["context_window"] == 128_000
    assert by_id["gpt-4o"]["prices"]["input_nusd_per_mtok"] == 2_500_000_000
    assert by_id["gpt-5.6-luna"]["prices"]["input_nusd_per_mtok"] == 200_000_000
    assert by_id["gpt-5.6-sol"]["prices"]["cache_write_nusd_per_mtok"] == 6_250_000_000


def rate_card_seeds_newest_version():
    from dj.apps.pricing import rate_card_seeds

    return rate_card_seeds.newest_seed()[0]
