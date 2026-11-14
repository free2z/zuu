# Free2Z Android digital-purchase availability — #1326

Status as of **2026-11-12**: **unavailable pending release-owner review**.
This is a proposed conservative default and an enforcement change, not an
approved billing integration, exemption, legal opinion, or permission to submit.
The owner decision is explicitly unset in
[`android-purchase-decision.json`](../../../../wallet/free2z/android-purchase-decision.json).
Public Android distribution stays blocked by `scripts/store-identity.mjs
--require=android`, independently of whether the Play listing/upload identity is
completed. Both the release workflow's `prepare` job and the operator script
already require that preflight. No store submission or console write is part of
this change. iOS, desktop and public web retain their purchase availability.

## Official policy evidence, fetched 2026-11-12

These are the current official pages read for this implementation. The owner
must re-check them against the exact release artifact and intended territories.

- [Google Play Payments policy, sections 2–4, 8–9](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en): digital goods, functionality, virtual currency and subscriptions generally require Play billing. The policy covers WebViews, links, messaging and signup flows that lead to other payment methods. Listed exceptions and eligible-region programs have conditions; locale, IP address, currency or use of cryptocurrency alone establishes none of them.
- [Understanding the Payments policy](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en), questions “Can I offer a consumption-only (reader) app”, “Do direct tips or contributions from user to creator require Play’s billing system?” and the AI/agentic question: consumption of previously purchased content is distinguishable from a purchase. The tipping explanation requires the entire contribution to reach the creator and no digital access or benefits. AI-mediated purchase implementations remain covered. Applying those conditions to a particular flow requires owner review; this implementation claims no exemption.
- [Alternative Billing Systems](https://support.google.com/googleplay/android-developer/topic/16471708) and [Programs for external content](https://support.google.com/googleplay/android-developer/topic/16470499): official indexes for the applicable regional programs. No enrollment, eligibility, contractual acceptance, regional exception or account state has been established for this app.

**Engineering interpretation:** until that review, do not initiate digital
purchases or paid 2Z operations on Android, including spending an existing 2Z
balance. Keep safe reads and cancellation. Do not turn ZEC tipping into payment
for memberships, credits, AI or live access. This is intentionally more
conservative than claiming that any particular credit-spending operation is
exempt or that the app has qualified as a reader app.

## Entrypoint inventory (owning app: `wallet/free2z`)

Paths below are relative to that app. `src/lib/purchases/policy.json` is compiled
into both the frontend and native HTTP boundary. New purchase routes must extend
this inventory and the independent tests, including alternate URL encodings.

| Product / surface | Production seams and Android result |
| --- | --- |
| 2Z credit top-up | `/fund`, sidebar/mobile navigation, TopBar balance chip and account menu. `/fund` was already unavailable; Android now says so explicitly without directing users elsewhere. `tuzi.buyCheckout` → `POST /api/stripe/create-checkout-session/`, `pricing.quote` → `GET /api/pricing/quote/`, and `validateStripeCheckoutUrl` refuse before construction/transport. The existing exact-host validator still applies on other platforms. No new checkout opener, payment SDK or WebView is added. |
| Membership/follow and renewal | Creator `SubscribeButton`, `tuzi.subscribe`, `tuzi.subscribeConfirmed` → `POST /api/tuzis/subscribe[-confirmed]/{username}` unavailable. This also conservatively withholds initiating free follows through that shared endpoint. Existing memberships, `subscriptionStatus`, `mySubscriptions`, `POST subscribe-recovery/{creator_id}` reconciliation/abandonment (cannot initiate a debit), and `DELETE subscribe/{username}` cancellation remain readable/usable; renewal cannot be resumed. Subscriber posts and an existing membership's live entitlement remain consumable. |
| Paid live | `live.start`, `live.join`, `live.refreshParticipant`, Room/JoinPanel → `POST /api/dyte/{username}/ppv` unavailable, even for an apparent host or replayed ticket. `refreshParticipant` is another join, so an old ticket cannot authorize a new admission. Broadcast/private join and subscriber-only checks remain; joining subscriber-only does not buy a membership. Creation/purchase of a membership from JoinPanel is withheld. |
| AI | `/ai`, legacy `ai.prompt` → `POST /api/openai/prompt`, conversation create and `sendMessage` → `/api/ai/conversations/.../promptresponses/` unavailable. Model reads are not purchase authority. The app contains no linked `tauri-plugin-f2z` SDK or native purchase command; the separate SDK's billing integration is not enabled here. |
| Platform 2Z tips/boosts | Article `TipDialog`, creator `TipButton` 2Z tab → `tuzi.donate`, `donateIdempotent`, `/api/tuzis/donate[-idempotent]/{username}` unavailable. Article promotion through weighted comments/replies and votes → `comments.create/createReply/vote`, `POST /api/comments/{type}/{uuid}/`, `{uuid}/replies/`, `{uuid}/vote/` unavailable; existing comments remain readable. No separate article-boost purchase API is mounted in this app. |
| Paid encrypted-chat request | `StartChatButton`, `e2ee.chatRequestPrice/startChatRequest` → `GET /api/e2ee/chat-requests/price/`, `POST .../{username}/` unavailable. Opening an already-known E2E2Z contact is distinct; no new messaging authority is added. |
| Unmounted API alternatives / raw bridge bypasses | Native HTTP and the common request transport also refuse legacy `/api/zpage/fund/` and page votes; AI image/storytime/metered prompt and creator quote routes; AI translation single/batch quote and purchase routes under `/api/zpage/...`; `/api/sdk/v1/purchases` creation and SDK grants; `/api/economy/usage-purchase-quote/` and usage-purchase writes (already unavailable server-side); the AI gateway `/v1/chat` and `/v1/chat/estimate`; and POST `/api/mcp`, whose tool envelope could otherwise hide purchase calls. None is enabled as a UI integration here. SDK purchase detail and AI `/v1/calls/{id}` GET, translation-job/variant reads, manual article publishing/variant PUT/PATCH, creator USD earnings/payment reads and existing authenticated outcomes remain distinct. Server authentication/authorization still applies. |
| Login continuation | `preservePaidIntent`, `consumePaidIntent`, `usePaidIntent`, shared `paidActionGate/runPaidAction`. Android neither stores nor consumes a paid draft; stale records are destroyed on consumption. Login destination alone never executes a purchase. A real login/session refresh cannot switch the policy. |
| Checkout return / deep link | `native-return.ts` parses only `cash.free2z.free2z://checkout/return?code=...`; rejects wrong schemes, duplicate/extra fields and malformed codes. `checkoutReturnMode` remains `web`, because the backend's native wire mode targets ZUULI, not this app. `listenForCheckoutReturns` remains **unmounted**; no new automatic claim listener. `/fund?success=true&session_id=...` is inert. Existing `recoverCheckoutReturn`, authenticated `/api/stripe/native-return/claim/` and `/status/`, receipt transactions and session refresh remain available: only server-verified ledger status can report credit. Cancel/processing/credited recovery never calls checkout or a spend API. Successful deliveries are deduplicated; transient failures remain retryable, and server claim verification remains authoritative. |
| Wallet-mediated peer-to-peer ZEC | Creator ZEC tab → `dispatchZecTip` / `appLinkIntentTransport` → exact `https://free2z.com/bridge/zuuli/#req=...`. Distinct from all 2Z spending: no credits/access purchased, no wallet keys or commands here, and ZUULI owns confirmation/signing. Existing protocol, amount, destination, receipt and replay checks remain. No exemption is inferred from that engineering separation; signed-device and owner acceptance are still required. |

## Enforcement and boundaries

Android target binding is the Tauri build's `TAURI_ENV_PLATFORM=android` bundled
constant plus an immutable native initialization flag; a user agent or remote
configuration cannot enable purchases. UI boundaries use the same availability
function as exported API helpers and the common request transport. Mock helpers
also refuse before changing balances. Spanish, French and English ship the
unavailable copy; balance navigation no longer advertises a purchase.

`src-tauri/src/purchase_bridge.rs` wraps the existing HTTP and opener plugins
without registering a new command or broadening capabilities. Android direct
`plugin:http|fetch` calls consult the compiled purchase inventory before the
real plugin. Routes are matched on component boundaries after one UTF-8 decode; ambiguous/double encodings and dot/separator tricks are refused. Safe Unicode receipt/entitlement paths are retained. Requests must disable
redirects and cannot supply a proxy/dangerous client configuration. Claim/status,
ledger and cancellation are preserved. Existing native URL scope checks still
run after the policy. Non-Android HTTP retains its prior redirect behavior.

`components/common/Markdown.tsx` sends external links through `openExternal`
to that native opener (and keeps `window.open` for the public browser). Native
social OAuth remains unavailable; `App.MobileOAuthRecovery` only restores an
account and cannot authorize a purchase.

Android opener refuses Stripe and first-party external website pages (including
billing through login/account links); the two existing exact ZUULI and E2E2Z
bridge paths remain distinct. Remote documents cannot replace the packaged
Android WebView. This is a restriction, not permission for arbitrary native URLs.
Generic third-party user-authored external links remain under existing opener
permissions; this does not certify their content or future redirect destinations.
A hostile renderer's stolen Knox token or independently modified client is not a
server security boundary: backend authentication/ledger enforcement is unchanged.
The owner must include rendered UGC and external navigation in signed-device
review. No claim of universal remote-content policy compliance follows here.

An idempotency key alone is not evidence that a debit already happened, so new
or uncertain paid POST retries remain blocked. This change does not delete
ledger rows, purchase receipts, stored chat outcomes or ZEC bridge receipts.
Checkout recovery uses its authenticated receipt/status endpoints; uncertain
non-checkout debits require server ledger reconciliation rather than permission
to initiate another charge.

## Release-owner decision and external acceptance

- [ ] Owner reviews the exact candidate AAB/APK identity, SHA-256, source revision/diff, declared territories and policies above.
- [ ] Owner records an explicit supported selection: approved integration, demonstrably applicable exception/program, or intentionally unavailable. The proposed default here is **not** that decision.
- [ ] For any integration/exception: separately authorize and document eligibility/enrollment, terms and implementation; this issue supplies no such approval.
- [ ] Signed-device acceptance records signing certificate, artifact hash/version, Android/WebView/device version, tester/date, screenshots/results for all routes, login transitions, direct native bridge refusals, checkout/cancel/processing/credited returns, replay, existing entitlements and ZEC tip separation. No console identity, login or account details in public evidence.
- [ ] Public-distribution gate remains blocked until the above acceptance is recorded and reviewed in a subsequent change. Do not equate an internal/unsigned frontend test with a store release.

## Local validation evidence

See [`evidence/android-purchases-1326.md`](evidence/android-purchases-1326.md).
`store-identity.json` still reports a missing Play listing/upload certificate;
`PLAY-STORE-SETUP.md` is a historical 2026-09-07 console observation that reports
a draft listing. This conflict is unresolved, not fresh console evidence. No
connected Play Console/Android Publisher tool is available in this session's
tool inventory. No console query, signing-key access, upload or release occurred.
