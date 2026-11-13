# ZUULI private wake transport — proposed decision for #384

Status: implementation for review, off by default, private acceptance only.
This does not close #384 or authorize enrollment, provider console changes,
public release activation or messages to existing devices.

## Service, privacy and retention decision

Use direct **APNs HTTP/2 on iOS 18** and **FCM HTTP v1 on Android API 29+**.
Do not add an aggregator, analytics, viewing-key service or account-linked
notification table. Tauri's official notification plugin provides local
notifications, not this remote token/service lifecycle; the dedicated
`tauri-plugin-notify` supplies that lifecycle. FCM is pinned at 26.0.2 from
Google's published source changelog; the platform bridge follows Tauri 2's
installed `PluginHandle::run_mobile_plugin` API. Rust remains 1.97.1.

Opt-in means explicit consent to the UI's token/IP/timing explanation **before**
the OS permission request. A public build has no acceptance configuration and
cannot enroll. No remote provider registration happens on a clean launch.
Declining/revoking permission stops registration and revokes the existing lease.
Desktop and ordinary browsers explicitly report remote push unsupported;
desktop local notifications are a separate feature, not implemented here.

| Observer | Observations and correlation limits |
| --- | --- |
| Notification operator | Registration and request IP/timing, platform, stable provider token, random queue address, token generation, lease expiry and queue/send timing; raw capabilities during request handling (only hashes retained). It can join all operations on that queue and join token rotations. It may correlate traffic with the content operator through IP/timing or collusion. |
| Apple / Google | App/project, stable device token, delivery timing, provider-visible queue envelope, device connection IP/timing and their own device/account associations; Firebase installation identifiers and SDK/device configuration on Android. A token is not assumed anonymous from the provider. |
| Content / account service | No new account binding or notification identifier is sent to it. Shared network observations still permit correlation. |
| Network observer | TLS endpoints, IP/timing/volume, not TLS-protected payloads. No anonymity network is added. |
| Other device apps / lock screen | A generic local “Open ZUULI to review wallet activity” notice if the owner has allowed notifications. No amounts, memos, sender, address or count. OS notification history can outlive the app's queue. |

This **does not satisfy an absolute “server cannot correlate” claim**. It avoids
an account/content identifier in registration; it does not prove unlinkability.
Provider notification timing can correlate with payments when a future trigger
correlates with payments. The provider also sees each random queue identifier in
the signed envelope. Reusing one queue across providers is not supported.

The notification service holds **only memory**, with a hard **24-hour absolute
lease**, at most 1,024 queues and 1,024 one-use anonymous invitations. The client
supplies an absolute expiry bounded by the server; idempotent registration,
rotation and process restart cannot renew that expiry. Token strings are
zeroized on mailbox removal; raw manage/send capabilities are SHA-256 hashed.
There is no token database, return-token endpoint, log, metric, account foreign
key, persistent queue or backup. Restart/disconnect loses server registrations.
A 100 ms worker removes expired registrations; each request also cleans up.
A currently in-flight call may delay cleanup/revocation by at most five seconds.
Operators must disable core dumps, memory snapshots, request/access/body logs and
unencrypted swap; memory zeroization is not a claim against a malicious operator.
APNs/FCM retain their own data under their policies; our TTL cannot erase their
metadata or prove provider deletion.

One pending wake per queue, TTL **60 seconds**, one accepted wake per queue per
minute and 60 globally per minute. A dispatch consumes its queue slot **before**
external I/O; there is no retry on ambiguous responses. Provider expiration/TTL
is 60 seconds. Overflow, replay, invalid capability, duplicate provider token,
unsupported provider and exhausted budget fail before provider I/O. Sixteen
operations may wait for the service mutex. TLS ingress must also bound body,
connection, handshake, header and source request rates, disable logging and
expose only the four POST routes; the daemon binds loopback only. No forwarded-IP
trust or IP retention is built into the application. No listener or sender is
started without `F2Z_NOTIFY_ACCEPTANCE=owned-devices-only`.

## Authority and detection boundary

No registration, envelope, response, metric or log includes a Free2Z auth header,
creator ID, content queue, wallet address, viewing key, seed, amount, memo,
transaction ID or sender. No key is exported. The service **cannot see a shielded
payment**. A contentless wake proves only that the configured service signed a
fresh envelope for this notification queue/generation, never that a payment
happened. No generic wake is presented as “you were paid”.

This implementation has a functional owner-requested test wake; it does not
invent a server-side shielded payment trigger. Production background payment
notices require a separately reviewed trigger/detection design. Periodic generic
broadcasts are not implemented or represented as payment detection. iOS silent
background notifications can be throttled or discarded and are not guaranteed
after force-quit. Android normal-priority data delivery may be delayed by Doze,
offline state, force-stop or missing Play Services. No dead-app wake claim is made.

Callbacks only buffer one bounded, untrusted envelope in native secure storage.
On focus/relaunch, Rust verifies Ed25519 signature (pinned notification-service
public key), queue, monotonic generation/sequence and expiry. The replay watermark
is saved before the WebView receives a boolean wake hint. That hint only refreshes
existing authorized wallet state; it cannot unlock, export a key or spend.

The wallet's existing sync remains the transaction authority. A **Rust-only**
listener uses events only as scheduling hints, re-reads actual native sync status
and account-0 history under the wallet transition lock, and asks for a generic
local activity notice only after an established in-process baseline advances to
a new mined incoming payment. No historical baseline/import, duplicate height,
reorg rediscovery or wallet switch generates a notice. It deliberately does not
start another sync or unlock the wallet. Observation is limited to the latest
500 account-0 entries and the current app process; notifications are best effort.
Native local-notice copy uses the OS language (en/es/fr), while consent uses the
ZUULI locale. The native callback is not used as evidence of a payment.

## Registration, rotation, disable and reset

`f2z-notify-proto` is the shared MIT protocol boundary. The AGPL `f2z-notify`
server is not linked into any app. Only ZUULI links the MIT native plugin;
Free2Z and e2e2z acquire no notification or wallet capability.

An owned acceptance device receives a private, one-use random 256-bit invitation,
not an account assertion. The device independently generates random 256-bit
queue, manage and send capabilities using the OS CSPRNG. Only their hashes are
kept by the service (the non-secret queue address is plaintext). Registration
contains the device provider token and absolute expiry, never an account key.
The invitation is bounded admission, not a paid credential or content identity.
It is consumed once. Registration retries are idempotent only for the same
capabilities, token, provider and absolute lease. A different device/token cannot
claim that queue. Future public admission needs a separate review; no public
credential distributor or billing integration is added here.

The manage capability authorizes token replacement and revocation. The distinct
send capability authorizes only a contentless wake for that one queue. Monotonic
sequence/generation values allow gaps after ambiguous failures but reject stale
requests. Rotation preserves rate limits, expiry and send sequence, and cancels
pending wakes for the old token. A global mutex is held across the bounded send:
revocation/rotation may await an in-flight send, then no later call uses the old
token. A provider may already have accepted a wake before revocation returns;
we cannot recall it. APNs 410 and FCM 404 invalidate the current registration.

Native state is device-only Keychain on iOS and Android Keystore AES-GCM in
`noBackupFilesDir`. No queue secret or token crosses the JS bridge. Permission,
status and a verified-wake boolean do. Native token callbacks update local state and signal a bounded Rust reconciliation channel;
registration completes automatically when a delayed first token arrives. Foreground
reconciliation also registers/rotates it with the service. Explicit consent, queue
capabilities and absolute expiry are saved before the OS request; an unacknowledged
bootstrap retains its original token until an identical registration succeeds,
then rotates to the current token. Permission
registration is asynchronous; UI reports waiting-token rather than success.

Disable first stops native receipt/token auto-init, removes the active local activity notice and clears the pending wake,
and atomically saves off state, a new cancellation revision and the disabled
serialized lease in that same secure-record write before calling the service.
Native save/clear and asynchronous permission/token completions compare the
cancellation revision; an old lease alone never implies consent. Clear preserves
the revision across restarts. Offline
revocation keeps that tombstone until a subsequent foreground status/reconcile or
explicit disable succeeds, or absolute expiry passes. New wakes cannot be sent
from that disabled lease. Logout starts native disable and account logout independently and awaits both;
active wallet deletion invokes a host-owned native disconnect hook before the
wallet's destructive transition. Wallet switches disconnect when native
observation establishes the changed wallet. No account identifier is passed to
the hook. App data reset/uninstall can erase the ability to revoke remotely;
server expiry is the final bound. iOS Keychain can survive reinstall: private
acceptance requires explicit disable/revocation before reinstall, and an expired
lease cannot re-enable without fresh provisioning. Expired native state remains encrypted until the app next runs; it is never
used to resume provider registration or accept callbacks after expiry, and is
stopped/cleared during reconciliation. No backup restores these capabilities
onto another device. There is no account database deletion policy
to register because no account relation is created.

## #305 reuse and the app split

The #305 owner decisions (D4/D5/D6 and subsequent revisions), ADRs 0009/0011,
`WIRE.md` §16 and `CLIENT-CONTRACT.md`'s unresolved-push boundary remain in force.
The useful contract is **an independent notification queue**, not reuse of a
content receive address, account device ID, credential or seed-derived key.
Notification signing keys are service keys, unrelated to messaging/KT/wallet keys.

The existing relay's WebSocket pushes are not mobile OS pushes. Its WIRE v1 has
no notification binding verb. This work does **not** change it, enroll e2e2z,
attach a notification address to directory entries or make a private backend
call. A future relay adapter must receive an explicitly delegated per-queue send
capability without leaking the content identity into registration and review the
resulting relay/operator correlation. Messaging launch remains gated separately.

## API and operations

The independent service OpenAPI is
[`openapi.json`](../../../rs/crates/f2z-notify/api/openapi.json); the native client
uses the exact Rust request structs. All bodies deny unknown fields, are bounded
to 8 KiB, and contain no caller payload/URL. Responses are empty 204 or fixed
bounded errors; 204 means queued/registered, never provider/device acceptance.
[The unsupported manifest](../../../rs/crates/f2z-notify/api/unsupported.json)
explicitly leaves every operation out of MCP. No MCP tool/schema or Free2Z
account SDK endpoint grants push authority. Native URL writes accept only the
four fixed routes at one privately compiled HTTPS origin, no redirects, cookies,
proxy or account middleware. Providers use fixed Apple/Google hosts, project and
topic; request input cannot choose an external URL, opener, topic or project.

The server requires private environment paths for `F2Z_NOTIFY_SIGNING_FILE`
(32-byte Ed25519 seed as 64 lowercase hex characters) and
`F2Z_NOTIFY_INVITATIONS_FILE` (one random hex invitation per line, at most 1,024). Startup consumes and
removes that whole file and fsyncs its directory **before** listening. Every
restart requires a fresh admission batch; unused invitations from the previous
process are lost. It cannot reload a spent invitation after a crash/revocation.
Keep the input file private and out of backups; it is provisioning input,
not a durable invitation database.
`F2Z_NOTIFY_APNS_CREDENTIAL` and `F2Z_NOTIFY_FCM_CREDENTIAL` name broker-maintained
private files containing `{ "bearer": "<short-lived credential>", "expires": <unix> }`.
They are bounded to 8 KiB, credential expiry to one hour, and are read per send.
An external private credential broker mints APNs ES256 JWTs for the selected
team/topic and Google OAuth tokens with only `firebase.messaging` scope and
`cloudmessaging.messages.create` authority on the selected project. The sender
does not hold signing/service-account keys. APNs sandbox requires
`F2Z_NOTIFY_APNS_SANDBOX=1`; topic and project are fixed by
`F2Z_NOTIFY_APNS_TOPIC` / `F2Z_NOTIFY_FCM_PROJECT`. Missing provider configuration
rejects registration. Expired/malformed credentials fail delivery without
logging their contents. Run one process; no replicas sharing a queue are supported.

The private native build requires the same acceptance flag plus
`F2Z_NOTIFY_ORIGIN` (an HTTPS origin only), `F2Z_NOTIFY_PUBLIC_KEY` (service public
key hex) and `F2Z_NOTIFY_INVITATION` (one owned device invitation). Treat that
artifact as private provisioning, never distribute it as a public release. iOS
acceptance signing must add the correct `aps-environment` entitlement privately;
the checked-in public entitlements do not enable APNs. Android acceptance must
supply Firebase project resources privately; analytics and FCM auto-init remain off in the plugin manifest and at runtime.
Only explicit consent or a previously opted-in, privately configured relaunch
requests a token. Loading a public/unconfigured build disables stale local state. No console enrollment or certificate
upload is part of this implementation. Public activation needs separate owner
approval after the physical acceptance below; no deployment manifest enables it.

## Official sources checked before implementation

- [Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/)
  and [local notification plugin](https://v2.tauri.app/plugin/notification/).
- [Apple token registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns),
  [background limits](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app),
  [HTTP/2 requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
  [provider JWTs](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
- [FCM Android setup, permissions and auto-init](https://firebase.google.com/docs/cloud-messaging/android/get-started),
  [receive callbacks](https://firebase.google.com/docs/cloud-messaging/android/receive-messages),
  [token lifecycle](https://firebase.google.com/docs/cloud-messaging/manage-tokens),
  [HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api),
  [Google SDK changelog](https://github.com/firebase/firebase-android-sdk/blob/main/firebase-messaging/CHANGELOG.md).

## Acceptance still OPEN — do not close #384

- Physical signed iPhone, iOS 18+, backgrounded delivery and callback evidence.
- Physical signed Android, API 29+, Play Services, backgrounded delivery evidence.
- Permission decline/revoke, token rotation, offline disable/revoke, app relaunch,
  force-stop/force-quit, foreground/background/cold-start behavior on each OS.
- Actual provider credential/entitlement/topic/project acceptance, expired/stale
  credential/token handling, private ingress limits and no-log deployment audit.
- Mobile-target Rust checks and native Swift/Kotlin compilation against actual
  SDKs; a controlled Rust seam or browser fixture is not that evidence. The full
  shipping-wallet Linux build
  passed on Ubuntu 24.04.4 with Rust 1.97.1; see [VALIDATION.md](./VALIDATION.md).
- Verify native local activity notices from wallet sync on an owned fixture,
  without transferring real funds; confirm reset/logout race behavior on-device.
- Privacy owner review: specifically accept residual token/IP/timing correlation.
- A separately reviewed payment wake trigger/detection design; no server oracle.

Record device evidence **privately**: signed artifact SHA-256, OS/API and device,
provider environment, runtime/library versions, opt-in state, start/background/
callback/open times, observed signature validation, negative controls and result.
Do not publish tokens, accounts, credentials, raw device logs or precise user
activity. An emulator, fixture or provider HTTP 2xx is not physical acceptance.
Refs #384. These open acceptance requirements leave the issue unresolved.
