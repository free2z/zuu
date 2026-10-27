# Vendored f2z-ai-proto pricing fixtures

These files are **byte-for-byte copies** of the shared pricing contract in the
zuu repository. They are the oracle that `dj.apps.pricing.ai` (and, from
ledger L2, the SQL `ledger.price`) must agree with, case for case — see
`docs/tuzis/ledger-v2.md` §9.

| File here | Source in free2z/zuu | git blob |
| --- | --- | --- |
| `pricing/worked_examples.json` | `rs/crates/f2z-ai-proto/fixtures/pricing/worked_examples.json` | `806947d6f2e8088dfe762171645ab0317d05614b` |
| `pricing/from_usage.json` | `rs/crates/f2z-ai-proto/fixtures/pricing/from_usage.json` | `c02a9357d8a9ac65ea92baf6c196ac86bd063a35` |
| `catalog/catalog.json` | `rs/crates/f2z-ai-proto/fixtures/catalog/catalog.json` | `3d0febe0940314e160c8c2100dc763c1befecaf2` |
| `catalog/catalog.canonical.json` | `rs/crates/f2z-ai-proto/fixtures/catalog/catalog.canonical.json` | `6912fcde12cb86821cef8bdc6cf1bb047300ec96` |
| `catalog/signature.json` | `rs/crates/f2z-ai-proto/fixtures/catalog/signature.json` | `058ab30b127da0dfe03a4030d01d416b3d8a7709` |

The `catalog/` files (vendored for the application contract, same source commit) are the signed
catalogue's oracle: `test_ai_catalog.py` asserts Django's `canonical_json`
reproduces `catalog.canonical.json` byte for byte, and that re-signing it with
the RFC 8032 TEST 1 key reproduces `signature.json`'s signature exactly
(Ed25519 is deterministic). Its own blob test is
`test_vendored_crate_fixtures_match_recorded_blobs`; re-vendor them the same
way with `D=rs/crates/f2z-ai-proto/fixtures/catalog`.

- **Source commit:** free2z/zuu `5603cae90c9a9b374cb0f81a02079d3ac7c07519`
  (`main`, 2026-09-27). The files were last changed upstream by
  `e9960033d13910e4423b633f48db001f9e91b4f6` (zuu#1050).
- **Cases:** 12 + 5 = 17. The parity test runs every case in every file here,
  not a hand-picked subset.
- The expected values were computed upstream by an independent exact-rational
  derivation (`fixtures/pricing/reference.py` in zuu), not by the Rust code.

## Re-vendoring is deliberate

`test_ai_pricing_parity.py::test_vendored_fixtures_match_recorded_blobs`
recomputes each file's git blob id and fails if it differs from the table
above. That is on purpose: a changed fixture is a changed pricing contract, and
it must arrive as a reviewed PR that updates the files, this table and the
test's recorded ids together — never as a silent edit.

To re-vendor:

```sh
cd <zuu checkout> && git fetch origin
Z=origin/main; D=rs/crates/f2z-ai-proto/fixtures/pricing
for f in worked_examples from_usage; do
  git show "$Z:$D/$f.json" > <tuzi>/py/free2z/dj/apps/pricing/tests/fixtures/f2z_ai_proto/pricing/$f.json
done
git rev-parse "$Z" ; git ls-tree "$Z" "$D/"     # new commit + blob ids for this README and the test
```

A new fixture file upstream is vendored the same way; the parity test picks up
every `*.json` in `pricing/`, and the blob test fails until the new file is
recorded.

**zuu#1059** (5-minute vs 1-hour cache-write prices) will bump the catalogue
schema and change these fixtures' `prices`/`usage` shape. `ModelPrices.from_crate`
refuses unknown members exactly like the crate's `deny_unknown_fields`, so a
re-vendor after the application contract fails loudly until the Python decoder learns the new
member — it cannot silently price a 1-hour write at zero.
