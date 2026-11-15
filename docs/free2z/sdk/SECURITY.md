# SDK security and operations (D4)

Use the [integration guide](./INTEGRATION.md) for registration and the
[reference](./REFERENCE.md) for the shipping API. The
[hello-ai consumer](../../../wallet/examples/free2z/hello-ai/README.md) is a
package-consuming frontend; its local tests are not live acceptance evidence.

## Credential and execution boundaries

Browser `FetchTransport` holds tokens only in its instance's memory. Do not
copy them to local/session storage, IndexedDB, URLs, telemetry or logs. The
registered callback handles an authorization code through
`completeBrowserSignIn()`, scrubs its URL and forwards it only to the expected
opener. Use exact HTTPS redirects and a retained popup/opener relationship.
Prevent callback logging at your hosting/proxy layer; no analytics on that page.
One transport owns one login session. Discovery/PKCE/state/nonce and verified
ID-token claims establish identity; a login hint never does.

In Tauri, use `NativeTransport(nativeBridge)` (`TauriTransport` in unreleased
source). The Rust builder owns endpoints and registration; OS credential
storage owns refresh credentials. JavaScript sees session metadata, decimal
DTOs and results, never bearer tokens. Expose only needed plugin commands to
local trusted content. No arbitrary authenticated HTTP, token getter, callback
injection or fallback to web auth. No remote frames in a privileged window.
Treat model text/tool arguments as untrusted: render text, validate structured
results and explicitly authorize tool side effects. Keep the native runtime
alive through cancellation-independent revocation/storage cleanup.

Session `generation` is a local fence; account `subject` is the identity key.
Account epoch and grant generation are separate server revocation stamps.
Partition journals/caches by public client ID and subject, clear visible output
when identity changes, and discard late promises from old UI generations.
Pass `sessionGeneration` for a paid operation planned under a particular login.
Never move an old user's request into another user's session. Grant generation
is not a cap-policy version: re-read `grant()` and require `enforced` explicitly.

## Paid operations and settlement

Save the original request, operation ID, idempotency key, timestamp and account
**before** opening chat. A journal write failure must prevent sending. Journal
contents can contain sensitive prompts: choose retention, storage and encryption
for your app. Do not log them. The hello-ai sessionStorage journal demonstrates
same-tab reload recovery, not durable encrypted storage or a child-safe history.
It deliberately contains no credentials.

Cancellation stops delivery. A network error, lost IPC response or truncated
stream does not prove zero charge. Keep partial output and the original key;
save `stream.callId` / `SdkError.callId` as soon as available. Read `call()` or
`waitForCall()` when the ID is known. Polling deadlines may return pending.
A terminal error event can still carry a charged receipt. Show unknown as
unknown, and priced whole-2Z separately from milli-2Z collected/shortfall.
Re-read the ledger balance rather than subtracting event hints locally.

Without a call ID, explicit recovery may resubmit the identical body and key,
under the same user/app, inside the 24-hour idempotency window. An old key can
become a new paid operation after expiry: never automatically replay it.
hello-ai uses a conservative 23-hour limit. A recovered record contains no
answer text. Generating another answer requires an explicit new operation;
never create fresh keys in a retry loop, including after provider failures or
step-up. `retryable` does not override these rules. Honor bounded Retry-After
for eligible reads. Browser token-expiry replay uses the original body/key;
refresh rotation recovery is not a new paid request.

## Billing and release operations

New apps request the default sign-in/balance/AI scopes, not `purchase:create`.
Users obtain 2Z on their own Free2Z `/buy-2z` page (Zcash first, card second),
opened through `openBilling()` only in eligible builds. A budget refusal goes
to purchase-free Manage; adding balance does not raise a budget. Store builds
must follow [STORE-COMPLIANCE.md](./STORE-COMPLIANCE.md) and omit forbidden
billing links **and native permissions**. Never trust navigation/foregrounding
as evidence of credit: read balance again. Legacy API migration/removal is
specified in [REFERENCE.md](./REFERENCE.md#legacy-purchase-compatibility-and-removal).

Package build/types, signed mock issuer tests and local tarball installation
prove only their bounded contracts. Before release, separately record registry
metadata and an ordinary consumer install without overrides; registered-client
sign-in/out, account switching and revocation; real-browser CORS (Authorization
and Idempotency-Key preflight, readable X-F2Z-Call-Id, Retry-After, ETag and
catalogue/version headers); and live model/chat/cancel/settlement/replay. Native
acceptance also needs system-browser, credential-store and callback tests on
each claimed desktop/mobile platform. Never claim those from a frontend build
or mock. Follow [RELEASING.md](./RELEASING.md) for the operator-authorized
publication sequence; implementation checks publish nothing.
