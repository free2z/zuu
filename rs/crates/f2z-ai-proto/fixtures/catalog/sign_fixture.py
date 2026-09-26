"""Regenerate fixtures/catalog/ with an independent (Python) signer.

The Rust verifier in f2z_ai_proto::catalog must accept what this produces, so
the platform's signer and the gateway can be tested against the same bytes.

The key is RFC 8032 section 7.1 TEST 1. It is public; it signs fixtures only.

    python3 sign_fixture.py   # needs `cryptography`
"""
import json
import pathlib

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

HERE = pathlib.Path(__file__).parent
LABEL = b"free2z/ai-catalog/v1"
SECRET = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")

# Deliberately NOT in canonical member order, and pretty-printed, so the
# verifier is proved to canonicalize rather than to hash the served bytes.
catalog = {
    "version": 7,
    "schema": 1,
    "issued_at": 1790000000,
    "expires_at": 1790604800,
    "rate_card_version": 3,
    "platform_margin_bps": 5000,
    "disabled_providers": ["example-provider"],
    "note": "fixture — not a real price list; members a verifier ignores are still signed",
    "models": [
        {
            "id": "example-large",
            "provider": "anthropic",
            "provider_model_id": "example-large-2026-01-01",
            "api_style": "anthropic_messages",
            "prices": {
                "input_nusd_per_mtok": 3000000000,
                "cached_input_nusd_per_mtok": 300000000,
                "cache_write_nusd_per_mtok": 3750000000,
                "output_nusd_per_mtok": 15000000000,
                "image_nusd": 0,
                "tool_call_nusd": 0,
            },
            "min_charge_2z": 1,
            "safety_factor_bps": 11500,
            "context_window": 200000,
            "max_output_tokens": 64000,
            "ttfb_timeout_ms": 30000,
            "enabled": True,
        },
        {
            "id": "example-mini",
            "provider": "openai",
            "provider_model_id": "example-mini-2026-01-01",
            "api_style": "openai_responses",
            "prices": {
                "input_nusd_per_mtok": 150000000,
                "cached_input_nusd_per_mtok": 37500000,
                "cache_write_nusd_per_mtok": 0,
                "output_nusd_per_mtok": 600000000,
                "image_nusd": 1000000,
                "tool_call_nusd": 10000000,
            },
            "min_charge_2z": 1,
            "safety_factor_bps": 10000,
            "context_window": 128000,
            "max_output_tokens": 16384,
            "ttfb_timeout_ms": 15000,
            "enabled": True,
        },
        {
            "id": "example-future-style",
            "provider": "openai",
            "provider_model_id": "future-1",
            "api_style": "a_style_this_crate_does_not_know",
            "prices": {
                "input_nusd_per_mtok": 1000000000,
                "cached_input_nusd_per_mtok": 0,
                "cache_write_nusd_per_mtok": 0,
                "output_nusd_per_mtok": 1000000000,
                "image_nusd": 0,
                "tool_call_nusd": 0,
            },
            "min_charge_2z": 1,
            "safety_factor_bps": 10000,
            "context_window": 8000,
            "max_output_tokens": 1000,
            "ttfb_timeout_ms": 15000,
            "enabled": True,
        },
        {
            "id": "example-disabled-provider",
            "provider": "example-provider",
            "provider_model_id": "k-1",
            "api_style": "openai_chat",
            "prices": {
                "input_nusd_per_mtok": 1,
                "cached_input_nusd_per_mtok": 1,
                "cache_write_nusd_per_mtok": 1,
                "output_nusd_per_mtok": 1,
                "image_nusd": 0,
                "tool_call_nusd": 0,
            },
            "min_charge_2z": 1,
            "safety_factor_bps": 10000,
            "context_window": 8000,
            "max_output_tokens": 1000,
            "ttfb_timeout_ms": 15000,
            "enabled": True,
        },
    ],
}

# CAVEAT for anyone porting this signer: `sort_keys=True` sorts member names
# by Unicode CODE POINT, while RFC 8785 (and f2z_ai_proto::canonical) sorts by
# UTF-16 CODE UNIT. The two orders agree for every name inside the Basic
# Multilingual Plane, which includes every name this schema uses (all ASCII);
# they differ only when a name contains a character above U+FFFF compared
# against one in U+E000..U+FFFF. A signer that could ever emit such a name must
# sort by `name.encode("utf-16-be")` instead.
served = json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"
canonical = json.dumps(catalog, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
key = Ed25519PrivateKey.from_private_bytes(SECRET)
sig = key.sign(LABEL + canonical)
pub = key.public_key().public_bytes_raw()

(HERE / "catalog.json").write_text(served, encoding="utf-8")
(HERE / "catalog.canonical.json").write_bytes(canonical)
(HERE / "signature.json").write_text(
    json.dumps(
        {
            "key_id": "fixture-rfc8032-test1",
            "public_key_hex": pub.hex(),
            "signature_hex": sig.hex(),
            "signing_label": LABEL.decode(),
            "note": "RFC 8032 TEST 1 key. Public. Fixtures only; never a production key.",
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
print(pub.hex(), sig.hex())
