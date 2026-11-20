# ZUULI account billing boundary

Refs [#155](https://github.com/free2z/zuu/issues/155),
[#1307](https://github.com/free2z/zuu/issues/1307) and
[#1209](https://github.com/free2z/zuu/issues/1209). This implements the supported
account-site consumer, not a new wallet-to-settlement protocol, and does not
close the remaining native/device acceptance in #155.

ZUULI's real Buy surface opens `/buy-2z` on the configured account origin in the
system browser. It renders no hosted payment content in the seed-holding
WebView. Production defaults to `https://free2z.cash`; development follows the
staging API proxy (`VITE_F2Z_PROXY`), and an explicit `VITE_F2Z_API` selects that
account realm. Configuration must be an HTTPS origin (or an HTTP IP loopback
origin for local development), with no credentials, path, query or fragment.
An invalid origin refuses the handoff rather than silently selecting another
account service.

Unlike SDK consumers of `Client::billing_url()`, this app authenticates using
Knox and has no registered SDK client ID. It must not invent one or copy an
untrusted `client_id` from a return URL. No Knox token, amount, memo, payment
identity or callback is included in the outbound link. The account site's
`/buy-2z` supports SDK `client_id` links independently. Browser authentication
is separate: the native UI names the intended username and warns that the
browser might be signed in to a different account.

The [account billing page](../../ts/svelte/free2z/src/routes/[username]/dashboard/billing/+page.svelte)
owns Zcash-first/card-second availability, current funding limits, shielded
address, exact recipient memo, estimated amount and stale-price refusal.
Under [the active `zec-funding-v3` method](../../py/free2z/dj/apps/economy/contracts.py),
pre-send amounts do not reserve credit or lock a conversion rate. The
[settlement implementation](../../py/free2z/dj/apps/economy/live_zec.py)
uses actual received shielded ZEC, the confirmation floor and a fresh processing
price. Repeated note processing is resolved against the original captured note
and receipt. Historical intent deadlines do not become new client-side send
deadlines. ZUULI neither creates nor replaces a pending payment instruction.
If a payment is uncertain, preserve the original transaction/receipt references;
checking a balance or reopening billing never authorizes another spend.

Returning to ZUULI (focus/visibility) or pressing **Refresh account balance**
performs only a no-cache authenticated `GET /api/auth/user/`. Restart uses the
existing account bootstrap read. A balance read reports current account credit,
not confirmation or attribution of a particular payment. Browser success
parameters, opener success, timers, broadcast acknowledgements and unconfirmed
receipts do not add credit. Balance reads are serialized within the mounted
surface, have a 15-second deadline and fence publication against token generation,
username changes and cancellation. Failed/invalid reads preserve the previous
balance. The adapter validates the server's decimal balance and preserves
milli-2Z across refresh and restart, including the header balance chip. It does not debit or infer the separate
ZEC wallet balance; the wallet's own synchronization remains authoritative.

The timer/local balance demo stays restricted to explicit `VITE_MOCK=1` browser
development. Production and real browser development use the account-site surface.
A Tauri or production build accidentally configured with mock data disables live
billing and balance verification; it cannot present mock data as funding proof. The legacy card checkout APIs and their compatibility
return handling remain intact; this change adds no new card contract.

## Local regression checks

From `wallet/zuuli` after `npm ci`:

```sh
./node_modules/.bin/vitest run src/lib/account-billing.test.ts src/features/wallet/funding src/lib/api/donation.test.ts src/lib/format.test.ts src/store/session-balance.test.ts
npm run typecheck
npm run typecheck:tests
npm run build
ZUULI_PW_PORT=15372 npm run test:e2e -- --project=account-billing
```

The normal Playwright run includes both the demo and account-billing projects.
The account-billing project uses the real API adapter with intercepted synthetic
responses and an intercepted native opener. It exercises the rendered narrow
viewport, login destination, exact external URL, double activation, opener and
read failures, retry, unchanged balance on return, subsequent authoritative
credit and restart. Its API audit rejects any quote/purchase/settlement call:
no stale or expired quote is consumed by this client. Unit tests also exercise
invalid balances, fractional precision, identity changes and late timeout
responses against the actual HTTP/account adapter. These are local contract
proofs, not real chain or device payment evidence.

## Remaining acceptance for #155

A controlled native-device run still needs to establish that the OS browser
opens the matching deployed account site, preserves the required shielded
address/memo/amount through the chosen wallet, and returns to a usable app.
Record the original transaction and authoritative receipt, delayed confirmation,
stale-price deferral, duplicate backend observation, connectivity failure and
restart behavior without making a second payment. Verify that only confirmed
server issuance changes the account credit and that wallet synchronization
independently reports ZEC. No live funds or provider charges are used by the
local tests above. No new native automatic-send path should be enabled merely
because those tests pass.

Store-specific eligibility for external purchase links remains subject to the
existing [store compliance policy](../free2z/sdk/STORE-COMPLIANCE.md); local UI
coverage does not establish approval for distribution through a store.
