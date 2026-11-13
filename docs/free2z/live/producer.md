# Free2Z producer API v1

Refs #784. Device and deployed-provider acceptance remain **OPEN**. This is
Free2Z content hosting (`wallet/free2z`), never ZUULI seed-holder authority.

The web creator dashboard links to `/<username>/dashboard/producer`; the
content app's Live page has **Producer controls**. Both mount
`ts/svelte/free2z/src/lib/producer/panel.ts` and use the same HTTP/state/replay implementation.
This is a source module owned by Free2Z, with no independent package or release.
The existing viewer, PPV admission, private-invite and legacy host surfaces
remain compatible. An outstanding v1 stream blocks legacy public host starts.
The v1 API refuses paid/private/subscriber creation before provider I/O; it
never infers entitlement, pricing, invites, membership or settlement readiness
from a renderer.

## Durable contract

Hosted and CLI MCP catalogs describe producer operations as unsupported for
execution; schema regeneration grants no broadcast authority.

The canonical OpenAPI file is `py/free2z/dj/free2z/openapi/f2z.yaml`.
Authenticated session/CSRF and account-epoch Knox authentication use the same
owner-only API. All responses are `no-store`. No GET writes state. JSON-only
POST bodies reject unknown fields, including counts and provider state.

| Endpoint | Contract |
| --- | --- |
| `GET /api/dyte/producer/v1` | Fresh creator eligibility, configuration and bounded read-only provider reachability; never creates a room |
| `POST /api/dyte/producer/v1` | Create a metadata draft with an actor-scoped idempotency key |
| `GET /api/dyte/producer/v1/history` | Latest 30 owned historical generations, including durable terminal outcomes |
| `GET /api/dyte/producer/v1/{id}` | Owned authoritative state, version and nullable fresh count |
| `POST /api/dyte/producer/v1/{id}` | Update, provision, refresh, publish, heartbeat, interrupt, takeover or end |

Every instruction includes `action`, UUID `idempotency_key`,
`expected_actor_id`, UUID `owner`, `version`, `title`, `description`, `audience`
and `access`. Metadata locks at provisioning. An existing instruction is
fingerprinted after strict typed validation, including its target, actor,
owner, version and complete metadata. Key scope is the actor across all
operations/targets. Reuse with different instructions returns 409
`idempotency_mismatch`; an exact replay does no provider I/O and returns the
original operation status plus the **current** canonical stream snapshot.
Responses are snapshots, not historical success assertions.

The independent stream UUID is the historical generation; a reusable
`CreatorMeeting` is only the legacy public discovery projection. One unresolved
stream per creator is enforced by a PostgreSQL partial unique constraint.
An actor-scoped UUID claim is committed independently of provider I/O. Short
transaction advisory locks coordinate claim/state decisions with legacy host
starts; no session lock or database transaction spans provider calls. Competing
requests return 409 `operation_in_progress`. Every state write verifies the
claim under the creator/claim row locks, so a stale worker cannot finalize or
clear a successor's ownership. Versions reject stale updates. Producer POSTs
opt out of the request-wide transaction middleware: write-ahead create/token
markers commit before each POST and survive process death. Final provision/publish commits
recheck authentication under the account row lock. A revoked account cannot
publish or replay an old host credential.

The claim deadline is at least 120 seconds and renews at fenced checkpoints.
Expiry never admits another create/mint. Only recovery reclaims expired
ownership, terminates its unresolved generation, and reconciles/cleans the
provider outcome before a new generation is allowed. Even a process that died
before creating its stream has a recoverable claim. An empty ambiguous-create
search still cannot authorize recreation. This also works with a transaction
pool having a single backend; no second pinned connection is required.

Account deactivation revokes stored host tickets and claim ownership and marks
unfinished streams for cleanup. Purge scrubs title, description and the content
fingerprint (an open account moderation report instead keeps that content
hidden for staff, following the existing deletion policy). Room/participant/operation UUIDs and content-free results remain
attached to the pseudonymized account for cleanup and historical billing;
pending workers cannot restore scrubbed data after losing their fence.

| State | Allowed next states |
| --- | --- |
| draft | provisioning, ended |
| provisioning | ready, ending, failed |
| ready | live, interrupted, ending |
| live | interrupted, ending |
| interrupted | live, ending |
| ending | ended, failed |
| ended | cleaned_up |
| failed | ending, cleaned_up |
| cleaned_up | none |

Provision creates exactly one room with an immutable UUID-derived title and
disables automatic recording/livestream output. It does not announce live.
Before replacing an inactive legacy broadcast room, it persists an immutable
retirement receipt and requires INACTIVE confirmation for that room. An
ambiguous retirement never authorizes creating the replacement. Recovery
finishes the retirement, and delayed viewer fees/uploads still resolve to the
original broadcast owner through the retained generation or receipt.
Refresh mints the host participant separately, using a reserved identity bound
to its durable operation and room. Public viewer admission cannot use that
namespace. Signed host departures therefore do not debit the creator as their
own viewer, including delayed departures after rename or room rotation. Free
broadcast provisioning honors the existing backend economic policy fence. The host explicitly confirms
publishing; the backend independently probes the provider's active session
and count plus the current host participant identity/join/leave record before
changing discovery. A viewer-only session cannot prove an active host. A renderer cannot assert either fact.
Counts expire after 60 seconds without confirmation. Recording and settlement
availability are not inferred from room existence or state.
Read-only tabs refresh the owning host's state without sending ownership
heartbeats. Displayed presence also expires locally after a minute without a
successful snapshot, and is unavailable offline; a stale snapshot cannot keep
an old count or live confirmation visible indefinitely.

The client stores only actor-scoped ownership and an outstanding instruction
in session storage **before** sending it. Lost replies/reloads retain the exact
key; unavailable storage refuses POSTs. SDK tokens are memory-only in clients.
The server retains the latest delivery token encrypted using a domain-derived
key from Django's deployment secret, for at most ten minutes of replay delivery.
A refresh retires the previous participant before minting another. A token-mint
ambiguity requires room deactivation, never a blind mint retry. After takeover,
old versions/owners and old token replays cannot regain authority.

## Interruption and cleanup

Clients heartbeat every 15 seconds. Browser unload, SDK departure, offline and
background are interruptions, never clean end. Camera capture is released;
foreground recovery is explicit. The existing live-meeting periodic sweep
recovers producer streams too: after 60 seconds without heartbeat it records
interruption and hides discovery; after 120 seconds of interruption it requests
server-side room deactivation. Latency includes the existing sweep cadence,
queue delay and bounded provider timeouts. A stalled worker is an operational
failure, not a guarantee that the provider has stopped. End remains pending
until the provider confirms; the client never asserts success for it.

The shared panel invalidates a synchronous media generation on offline, hidden,
pagehide, disposal and account change. Each pending capture, SDK initialization,
join, device replacement or media-enable continuation retains that generation.
Stale capture results stop every returned track and cannot restore preview.
Stale SDK completions leave their captured instance again even if interruption
already cleared the active instance. Network/visibility return never resumes
media automatically; preparation, reconnect or capture must be explicit.

Cleanup searches an ambiguous create by its exact durable title. An empty or
ambiguous search never authorizes another create. Known rooms are set INACTIVE.
Cleanup is repeatable, has capped exponential backoff and at most 20 attempts;
`cleanup_manual_review` preserves the unresolved generation and blocks new
provisioning. Each sweep examines at most 20 due records and has a five-second
admission budget, plus the final provider cleanup sequence and its individual
connect/read timeouts. Database
state/history exposes pending/failed/manual-review outcomes without secrets.
No public configuration or operator infrastructure details belong in evidence.

## Provider semantics and deployment seam

Implementation uses the current documented Cloudflare account/app REST API,
with the already-installed RealtimeKit SDK versions in each client. Sources
consulted for this implementation:

- [Create meeting](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/meetings/methods/create/)
- [Find meetings by title](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/meetings/methods/get/)
- [Host participant/session identity](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/sessions/methods/get_session_participant_details/)
- [Active session truth](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/active-session/methods/get_active_session/)
- [End versus disable](https://developers.cloudflare.com/realtime/realtimekit/humans/core/end-a-session/)
- [Local media, devices and preview](https://developers.cloudflare.com/realtime/realtimekit/humans/core/local-participant/)

Cloudflare documents that INACTIVE removes active participants and prevents
re-entry. Kick-all alone permits new sessions, so it is insufficient for durable
end. This is **not** proof about final invoices, refunds, recording delivery,
external RTMP outputs or production broadcast acceptance.

Producer configuration is absent by default and comes from the deployment
owner, outside Git. The producer app and existing compatibility viewer app must
be the same; missing configuration or failed provider reachability reports
unready. Host preset permissions, token revocation, INACTIVE propagation and
billing cessation need provider-backed acceptance before rollout. No live
provisioning, purchases or financial transfers were used in local validation.

The macOS content bundle now declares camera/microphone usage and only the
camera/audio-input resource entitlements needed by its existing hardened
runtime. This follows [Tauri's bundle guidance](https://v2.tauri.app/distribute/macos-application-bundle/)
and [Apple's media authorization requirements](https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos)
with [hardened runtime resource access](https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime).
No wallet capability or runtime exception is added. These source declarations
are not signed macOS capture evidence.

## Evidence and open acceptance

Local automated evidence covers the real PostgreSQL model and HTTP/CSRF/session
path, typed replay contracts, races, cancellation, revoked auth, unknown creates,
partial token creation, takeover, grace expiry, provider failure and end/history/
discovery. `test_controlled_browser_real_django_flow` launches Chromium with
synthetic capture and the actual shared panel against Django and PostgreSQL;
only the provider and SDK are controlled fixtures. It **does not** establish
real SDK broadcast acceptance. Run it after installing web frontend dependencies.
The framework Playwright suites separately cover the mounted entry points,
unsupported modes, recovered authoritative state, focus and touch geometry.
Delayed-promise browser cases exercise the actual shared panel with real
synthetic browser tracks and controlled SDK/HTTP boundaries. The content app's
dialog-unmount case verifies late capture disposal. The Django browser flow
also interrupts a pending join, verifies durable interruption, and requires an
explicit reconnect before publication. These are controlled lifecycle proofs,
not signed-device or deployed SDK acceptance.
Pool transport tests opt into `LEDGER_TEST_POOLER_PORT`, verify transaction mode
and the single-backend limit, and use independent clients and real process
exits after controlled provider acceptance. They cover committed create/token
markers, overlap/refusal, stale-worker fencing, crash reconciliation and replay.
The local transport fixture used PgBouncer 1.22.0; CI's owned fixture is pinned
to 1.25.2. Neither is deployed-provider acceptance.

OPEN external acceptance before calling the feature ready:

- Signed iOS and Android host/join runs with actual supported native media
  permissions, devices, background/interruption/termination, reconnect and
  cross-device takeover; retain build/device identities and results privately.
- macOS and other capable desktop SDK host/join/device-switch runs. Browser
  feature detection does not establish physical/native platform support.
- Deployed provider configuration and same-app/preset permissions; actual
  token retirement and room-disable behavior; production sweep operation and
  provider billing/recording/settlement boundaries. Verify the session participant
  `user_id` mapping to the minted participant, joined/left presence and update
  latency; missing or contradictory fields refuse publication.
- Paid/private producer capability requires a separately authoritative contract;
  those v1 paths remain refused. Existing consumer admission behavior is retained.

Do not close #784 or claim signed-device readiness from these fixtures.
