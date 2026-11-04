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
  "enforcement_reason": "ok",
  "as_of": "2026-09-28T00:00:00Z"
}
```

Every field is required except `enforcement_reason`, which servers predating
that field omit. `spend_cap_2z` is the original consented whole-2Z limit,
not the remaining allowance; explicit `null` means uncapped. `cap_period` is
`day`, `week`, `month`, or `total`. `enforced` says the service currently enforces
the exact returned policy: consent metadata alone, an inactive enforcement
service, or a missing/stale projection cannot establish it. An unavailable proof
must remain false or an error; consumers must never substitute true.

`enforcement_reason` is a coarse, non-sensitive diagnostic for `enforced`, never
a substitute for it. It is `ok` exactly when `enforced` is true; otherwise the
server reports the first unmet prerequisite, in this order:

| code | meaning | who can act |
| --- | --- | --- |
| `platform_disabled` | The deployment has not activated grant enforcement | Nobody in the app; wait for Free2Z |
| `ledger_cutover_pending` | The ledger rollout that enforcement needs is incomplete | Nobody in the app; wait for Free2Z |
| `ledger_cap_pending` | This app/user grant has no current exact ledger projection yet | Re-read later; if it persists, report it with the grant's `client_id` |
| `ok` | Enforced | — |

It deliberately never says which policy field mismatched or exposes any
configuration value. New codes may be added: the SDKs decode an unrecognised
code as `unknown` (Rust `EnforcementReason::Unknown`), which is never enforced.
A reason that contradicts `enforced` is a protocol error.

**Contract for every future code:** a new `enforcement_reason` must describe a
**non-enforced** state. `enforced: true` is only ever paired with `ok`. Clients
treat any other pairing, including an unrecognised code with `enforced: true`,
as a protocol error and fail closed. A server that sent a new code alongside
`enforced: true` would therefore make every deployed SDK refuse the grant.

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
