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

The planned release dependency is `f2z-ai-proto = "0.1"`; it is not available
on crates.io yet. Source verification uses Rust 1.97.1:

```text
cargo +1.97.1 test --locked -p f2z-ai-proto --all-targets
cargo +1.97.1 test --locked -p f2z-ai-proto --doc
```

Repository tests compare fixtures and public prose; they are intentionally
excluded from the reusable library tarball because they require repository
files. See the [release guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/RELEASING.md)
for package ordering and isolated consumer checks.
