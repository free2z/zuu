# Current application grant

`GET https://free2z.cash/api/sdk/v1/grant` reads only the grant belonging to
its bearer token's account and application. It accepts an OAuth access token
with audience `f2z-api` and scope `ai:invoke`; first-party sessions and arbitrary
account/application selectors are not accepted. Responses use the standard
[SDK error envelope](errors.md), and successful responses are `Cache-Control:
no-store`. Tokens minted before `ai:invoke` included `f2z-api` need refreshing.

```json
{
  "sub": "3f0c9b7e-6a2d-4b1f-8e5c-2d9a7c4e1b60",
  "client_id": "app_7f3c2e",
  "account_epoch": 4,
  "grant_generation": 2,
  "scopes": ["openid", "ai:invoke"],
  "spend_cap_2z": 500,
  "cap_period": "total",
  "enforced": true,
  "as_of": "2026-09-28T00:00:00Z"
}
```

Every field is required. `spend_cap_2z` is the original consented whole-2Z limit,
not the remaining allowance; explicit `null` means uncapped. `cap_period` is
`day`, `week`, `month`, or `total`. `enforced` says the service currently enforces
the exact returned policy: consent metadata alone, an inactive enforcement
service, or a missing/stale projection cannot establish it. An unavailable proof
must remain false or an error; consumers must never substitute true.

`account_epoch` and `grant_generation` are server revocation stamps. They are
not the native SDK's local session `generation`, and are not cap policy versions:
cap edits need not increment them. This endpoint gives a fresh snapshot, not a
promise that consent cannot change between this read and the next operation.
The ledger independently checks current consent when admitting each call.
A caller needing an immutable per-operation budget must not treat this snapshot
as that guarantee. Existing user-consented limits remain authoritative; no
special testing budget or platform-wide client allowance is introduced here.

Rust exposes `Client::grant()` with `proto::grant::Grant`. The native bridge
exposes `grant()` with decimal-string integers and requires `f2z:allow-grant` on
a trusted local window. The TypeScript facade exposes `client.grant()` with
`bigint` integers through both transports. The SDK refuses mismatched identity
or a response that outlives its local session. Check the configured client,
selected account, `enforced`, period and original limit against the operation's
actual authorization; an estimate's cap remainder does not prove any of these.
