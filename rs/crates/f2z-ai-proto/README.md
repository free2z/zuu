# f2z-ai-proto

The shared Free2Z AI wire contract: chat requests/responses, SSE events,
settlement states, signed model catalogues, error codes, balances, and exact
integer pricing. MIT licensed; `no_std` plus `alloc`, with no transport/runtime.

**Pre-release source preview; not published.** `publish = false` remains in
force. This library is shared by the gateway and Rust SDK so their units,
settlement rules and pricing arithmetic agree. The normative public contract is
[docs/free2z/sdk](https://github.com/free2z/zuu/tree/main/docs/free2z/sdk).

`Milli2z` represents one thousandth of a platform credit. `Whole2z` represents
whole credits. `Nusd` is internal provider cost in nano-USD. All use unsigned
integers; balance and charge fields are never floating point. Full u64 values
can exceed JavaScript's exact Number range: native adapters use decimal-string
DTOs, while browser clients need lossless parsing before conversion to BigInt.

`Usage::tool_calls` is only for provider-billed **server-side** tool
invocations that the catalogue prices per call. Client function-tool
definitions, prior calls and results are ordinary input; generated call names
and arguments are ordinary output. They are not charged again per call. The
public `Usage` type does not expose a separate function-call count.

```rust
use f2z_ai_proto::{Bps, Milli2z, Nusd, Whole2z, price_nusd};

let charge = price_nusd(Nusd::new(21_000_000), Bps(0), Bps(0), Whole2z::new(1))?;
assert_eq!(charge.total_2z(), Whole2z::new(3));
assert_eq!(charge.provider_milli, Milli2z::new(2_100));
# Ok::<(), f2z_ai_proto::pricing::PricingError>(())
```

Use the settlement outcome checks before treating a reported amount as final.
A pending or unknown settlement is not a zero charge. This crate does not
perform authorization, reserve balances, settle ledger entries, or certify
that a service endpoint is deployed.

The current release is `0.2.0`, Git tag `sdk-v0.2.0`; it is not available
on crates.io yet, so pin the tag. Source verification uses Rust 1.97.1:

```text
cargo +1.97.1 test --locked -p f2z-ai-proto --all-targets
cargo +1.97.1 test --locked -p f2z-ai-proto --doc
```

Repository tests compare fixtures and public prose; they are intentionally
excluded from the reusable library tarball because they require repository
files. See the [release guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/RELEASING.md)
for package ordering and isolated consumer checks.

`catalog_v2` provides an opt-in signed schema-2 reader and context-tier pricing
primitives. The gateway still uses `catalog::verify_catalog` (schema 1); these
primitives do not enable models or change HTTP/SDK model lists. The existing
reader rejects a `long_context_pricing` field even when its value is `null`.

A schema-2 model keeps the base `prices` and may add
`long_context_pricing: { input_tokens_gt, prices }`. Above the threshold,
the complete second table applies to all usage, including output. Tier input
is the checked sum of exclusive ordinary, cache-read and cache-write tokens;
reasoning is already included in output. Each tier rate must be no lower than
its base rate; individual zero-price dimensions remain valid. The existing
signature envelope label stays `free2z/ai-catalog/v1` because schema and tier
rules are inside its signed payload.

Adoption requires authoritative immutable ledger terms and a versioned, typed
model-list API. Legacy `/v1/models` must omit tier-priced models; adding an
extra field to its flat price map is not safe for older SDKs. Consumers must
preserve publication anti-replay state across schema changes and retain the
original terms for admitted calls and replays. Token reservation helpers need
certified input/output upper bounds, including provider framing and hidden
input; use the entire model context when no tighter input bound is proven.
They do not establish context admission or authorize paid images/tools.
