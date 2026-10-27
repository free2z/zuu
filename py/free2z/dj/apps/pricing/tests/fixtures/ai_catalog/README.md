# Django-produced signed catalogue sample

`django_signed_catalog.json` is the exact body `GET /api/ai/catalog/v1` serves
for the fixed dataset in `test_ai_catalog.py::sample_dataset`, signed at
`SAMPLE_NOW = 4000001234` with the **public RFC 8032 section 7.1 TEST 1 key**
(the same key zuu's `f2z-ai-proto` catalogue fixtures use; never a production
key):

| | |
| --- | --- |
| `key_id` | `fixture-rfc8032-test1` |
| public key (hex) | `d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a` |
| signing message | `b"free2z/ai-catalog/v1" \|\| canonical_json(body["catalog"])` |

What the Python suite checks against it:

- `test_django_sample_is_reproduced_byte_for_byte` -- the endpoint's builder
  and signer still produce exactly these bytes (and
  `test_get_serves_the_signed_document` -- the view serves them).
- `test_django_sample_verifies_under_an_independent_ed25519` -- the signature
  verifies under `../../ed25519_reference.py` (RFC 8032's own reference
  verifier, no code shared with `cryptography`) and under `cryptography`, and a
  one-unit price change or a missing label does not.

Regenerate (only when the builder's output legitimately changes; the diff is
the review):

```sh
cd py && AI_CATALOG_WRITE_SAMPLE=1 pytest dj/apps/pricing/tests/test_ai_catalog.py -k reproduced
```

## Verifying it with the Rust crate

CI here has no Rust toolchain, so the crate check is run by hand and its result
recorded below. A scratch workspace with two members:

- `proto/` -- `rs/crates/f2z-ai-proto/src/*.rs` from free2z/zuu at the commit
  below, with the dependencies zuu's workspace gives it
  (`serde` 1 `derive,alloc`; `serde_json` 1 `alloc`; `ed25519-dalek` 3
  `zeroize`), `edition = "2024"`;
- `verify/` -- depends on `proto` and `serde_json` (`std`, `raw_value`), and
  hands the **exact served bytes** of the `catalog` member to `verify_catalog`:

```rust
use f2z_ai_proto::catalog::{DetachedSignature, TrustedKey, verify_catalog};
use serde_json::value::RawValue;

#[derive(serde::Deserialize)]
struct Envelope<'a> { #[serde(borrow)] catalog: &'a RawValue, signature: Sig }
#[derive(serde::Deserialize)]
struct Sig { key_id: String, signature_hex: String }

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let body = std::fs::read(&a[1]).unwrap();
    let env: Envelope = serde_json::from_slice(&body).unwrap();
    let key = TrustedKey::from_hex(env.signature.key_id.clone(), &a[2]).unwrap();
    let sig = DetachedSignature::from_hex(env.signature.key_id, &env.signature.signature_hex).unwrap();
    let c = verify_catalog(env.catalog.get().as_bytes(), &sig, &[key], a[3].parse().unwrap()).unwrap();
    println!("OK version={} rate_card_version={} models={}", c.version, c.rate_card_version, c.models.len());
}
```

```sh
cargo +1.97.1 run --release -p verify-django-catalog -- \
  django_signed_catalog.json d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a 4000001234
```

The recorded Rust verification below predates the additive `idle_timeout_ms`
member. It covers the prior sample after the the application contract image fix (gpt-5.6-luna
`image_nusd` 0); it does not establish that an older `f2z-ai-proto` build
accepts the new field. Re-run it with the matching gateway/proto update before
deploying the new signed payload. The prior run used zuu
`5603cae90c9a9b374cb0f81a02079d3ac7c07519`, rustc 1.97.1, and had two negative
controls: a one-unit price change and `now = expires_at`.

```
OK verify_catalog: version=4000001220000000 rate_card_version=2227 margin_bps=2000 models=3 expires_at=4000260420 callable=["claude-sonnet-5", "gpt-5.6-luna", "grok-4.5"]
negative control (tampered price) refused: catalogue signature does not verify
negative control (now = expires_at) refused: catalogue has expired
```

## Follow-up verification — 2026-10-04

Re-ran the exact `django_signed_catalog.json` fixture from this PR after adding
`idle_timeout_ms: 60000` to all three models. The fixture was verified at time
`4000001234` using `verify_catalog` from `free2z/zuu` source commit
`e95becd6517bada55ca933e4072ebf13bbbb3bff`, with Rust 1.97.1 in the pinned
`rust:1.97.1-slim` image (`sha256:8e8cf8f7fd54a2d23d5a743b3a03f56e26b6c774276c33fa0595111704ebb15c`).

The isolated scratch crate used the repository's actual dependency feature
settings (`serde` 1 with `derive,alloc`, `serde_json` 1 with `alloc`, and
`ed25519-dalek` 3 with `zeroize`), the copied `f2z-ai-proto` source, and the
verifier code shown above. It did not build the full gateway workspace.

```
OK version=4000001220000000 rate_card_version=2227 models=3
```

This verifies the signed PR fixture against that pinned Rust verifier source,
including deserialization of the new field. It does not establish which
gateway version is deployed or whether a deployed gateway consumes
`idle_timeout_ms`.

## Follow-up verification — 2026-10-04 (`structured_output`, zuu#1128)

The sample now carries `capabilities` on every model, with an explicit
`"structured_output": false` (the signer always emits it: the gateway reads an
ABSENT member as "catalogue silent" and applies an interim rule). Verified with
the verifier above (rustc 1.97.1, `f2z-ai-proto/src` copied from each commit,
the workspace dependency features as listed, each commit's own `Cargo.lock`)
at time `4000001234`, against both an OLD and a NEW gateway source:

- free2z/zuu `origin/main` `70b74edd903aa4c2c9168d68585ac25a862ae117` (no
  `structured_output` field -- the older gateway):
  `OK version=4000001220000000 rate_card_version=2227 models=3`; the unknown
  member is ignored (`ModelCapabilities` is `#[serde(default)]`, not
  `deny_unknown_fields`).
- free2z/zuu PR the application contract head `51968db0c63d0555d9266eaca577da869e033a89`
  (`feat/response-format-json-schema`): `OK ... models=3`, each model
  `structured_output: Some(false)`.

A variant of the same document re-signed with `gpt-5.6-luna` declared `true`
also verified on both (`Some(true)` on the PR head; ignored on main), and that
variant with the flag flipped back to `false`, or set to `null`, without
re-signing was refused: `catalogue signature does not verify`.

To verify a LIVE catalogue the same way, save the body of
`GET /api/ai/catalog/v1` and pass the deployment's public key (printed by
`manage.py ai_catalog --public-key`) and the current Unix time.

## Follow-up verification — 2026-10-05 (`strict_tools`, zuu#1142)

The sample now carries `"strict_tools": false` on every model as well (the
signer always emits it: like `structured_output`, the gateway reads an ABSENT
member as "catalogue silent" and applies an interim `provider == "openai"`
rule). Verified with the verifier above (rustc 1.93.1, `f2z-ai-proto/src`
copied from each commit, the workspace dependency features as listed, each
commit's own `Cargo.lock`) at time `4000001234`, against both an OLD and a NEW
gateway source:

- free2z/zuu `3d94f54d754a917d47b0c66e21df1afe73972dc9` (the gateway pinned
  in prod before this change, no `strict_tools` field):
  `OK version=4000001220000000 rate_card_version=2227 models=3`; the unknown
  member is ignored.
- free2z/zuu PR the application contract head `eea37272cb658dbeacec742671dc0a7b688958bb`
  (`feat/ai-tools-openai`): `OK ... models=3`, each model
  `strict_tools: Some(false)`, `structured_output: Some(false)`.

A variant re-signed with `gpt-5.6-luna` declaring `tools` and `strict_tools`
`true` verified on both (`tools=true strict_tools=Some(true)` on the PR head;
`tools=true`, the member ignored, on the old one). The sample with
`strict_tools` flipped to `true`, or set to `null`, without re-signing was
refused: `catalogue signature does not verify`; at `now = expires_at`:
`catalogue has expired`.

## Follow-up verification — 2026-10-05 (`reasoning_effort` + `controls`, zuu#1170)

The sample now carries `"reasoning_effort": false` on every model. The signer
always emits it, even though the gateway reads an absent member as false.
No sample model declares it, so the sample has no `controls` object.

Verified with the verifier above (rustc 1.97.1, `f2z-ai-proto` used as a path
dependency of each checkout) at time `4000001234`, against both an OLD and a
NEW gateway source:

- free2z/zuu `d26c9397d0b1b1c2806972a826b308902a339a80`, the gateway pinned
  in prod before zuu#1170. It has no `reasoning_effort` and no `controls`.
  Result: `OK version=4000001220000000 rate_card_version=2227 models=3`. The
  unknown member is ignored.
- free2z/zuu PR the application contract head `2afa018db611884e11a8d48801b2c28ff4a7abfe`.
  Result: `OK ... models=3`, with every model at `reasoning_effort: false`
  and `ModelControls { effort_levels: None }`.

I re-signed a variant of the same document with:

- `gpt-5.6-luna`: `reasoning: true`, `reasoning_effort: true`,
  `controls.effort_levels` `["low","medium","high","xhigh"]`;
- `grok-4.5`: `reasoning_effort: true`, `["low","medium","high"]`.

The variant verified on both checkouts. The new one read the levels
(`Some([...])`). The old one ignored `controls` and the new member, and read
`reasoning: true`.

Each of these changes to the variant, made without re-signing, was refused
on both checkouts with `catalogue signature does not verify`:

- appending `minimal` to grok-4.5's list;
- flipping grok-4.5's `reasoning_effort` to `false`.
