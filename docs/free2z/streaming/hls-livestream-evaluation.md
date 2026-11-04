# HLS livestream evaluation (#1382)

**Status:** research only; no production switch or implementation decision.
**Scope:** Free2Z watch-only public broadcasts, subscriber streams, and PPV
streams. Private and interactive rooms remain outside this evaluation.
**Evidence checked:** repository at `upstream/main` (`3a74cd6e`) and Cloudflare
official documentation on 2026-11-03.

## Evaluation

**Feasible for public broadcasts; conditionally feasible for paid tiers.**
Cloudflare recommends Stream Live when a small presenter group serves a large
watch-only audience. RealtimeKit's meeting-livestream API starts an HLS output
and returns a playback URL; the Stream docs support HLS/DASH delivery. This
fits the public broadcast use case and can remove watch-only users from the
WebRTC meeting. [Realtime overview](https://developers.cloudflare.com/realtime/)
· [Start livestreaming a meeting](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/livestreams/methods/start_livestreaming_a_meeting/)
· [Stream Live](https://developers.cloudflare.com/stream/stream-live/)

Subscriber and PPV playback is only viable if the playback URL is protected
before it reaches viewers. RealtimeKit's start-livestream API documents a
playback URL, but its request parameters do not document `requireSignedURLs`
or viewer authorization. Cloudflare Stream supports signed playback tokens
for private videos, and live-input settings include `requireSignedURLs`, but
the docs do not establish that a RealtimeKit-created input can be secured this
way without breaking its lifecycle or how its token endpoint behaves for this
input. Treat this as a blocker to paid-tier rollout until tested. A raw HLS
URL should be assumed shareable by anyone who obtains it. [RealtimeKit start
API](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/livestreams/methods/start_livestreaming_a_meeting/)
· [Secure Stream](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/)
· [Stream live-input API](https://developers.cloudflare.com/api/resources/stream/subresources/live_inputs/)

## What the repository does today

- `py/free2z/dj/apps/dyte/client.py` issues host preset `webinar1` and viewer
  preset `webinar-participant`. `ts/svelte/free2z/src/lib/components/stream/LiveStreamViewer.svelte`
  joins the meeting as a viewer; the creator's dashboard starts the host
  session.
- `py/free2z/dj/apps/dyte/views.py` authorizes subscriber viewers against the
  creator subscription and gates PPV joins on login, balance/reserve and
  admission. PPV participant join/leave events feed time-based charges and
  delivery settlement. These admission and settlement rules are not replaced
  by merely hiding the HLS player.
- Public broadcasts allow anonymous viewers. A playback URL returned to a
  browser is effectively public. Subscriber/PPV HLS needs a server-side
  entitlement check and short-lived access material; PPV also needs a reliable
  viewer-time signal that preserves its current economic semantics.
- The dashboard currently surfaces participant counts. A Cloudflare Stream
  `/views` endpoint reports current live viewers for third-party players;
  RealtimeKit analytics reports aggregate `viewer_seconds` and ingest time.
  Neither documented metric identifies a paying Free2Z account. [Stream viewer
  count](https://developers.cloudflare.com/stream/getting-analytics/live-viewer-count/)
  · [RealtimeKit analytics API](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/livestreams/methods/get_livestream_analytics_complete/)

## Latency and playback

Standard HLS latency is a tradeoff, not a documented fixed promise. Cloudflare
recommends a 4–8 second GOP for standard HLS; shorter GOP can reduce latency
but costs encoding efficiency and can increase ingest bandwidth. Cloudflare's
Low-Latency HLS path is Beta, has player compatibility constraints, and uses
2–4 second GOP recommendations. The docs say a newly connected live input can
take about 30 seconds before playback is available. Measure glass-to-glass
latency and time-to-first-frame on our actual browsers/devices; do not promise
a latency target from these recommendations. [Live input setup and
requirements](https://developers.cloudflare.com/stream/stream-live/start-stream-live/)
· [HLS player and LL-HLS](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/)
· [Live troubleshooting](https://developers.cloudflare.com/stream/stream-live/troubleshooting/)

HLS viewers become media-only consumers; host/presenter tracks can remain in
RealtimeKit. Existing in-room chat, moderation, reactions and recording
behavior must be checked separately: HLS itself does not carry those meeting
interactions. Keep host and any interactive co-presenters on the meeting.

## Cost model

Cloudflare lists Stream delivery at **$1 per 1,000 minutes delivered** and
storage at **$5 per 1,000 minutes stored**; ingress and encoding are free.
Delivery is summed across viewers and rounded to media segment boundaries. A
one-hour live watch by one viewer is roughly $0.06 delivery; 1,000 such
viewer-hours are roughly $60, before any applicable included usage or other
RealtimeKit charge. RealtimeKit's current pricing lists **10,000 audio/video
participant minutes and 100 export minutes included per month**, then $0.002
per A/V participant minute and $0.010 per minute for recording/RTMP/HLS export.
The presenter still uses participant minutes; an HLS broadcast may incur export
minutes. Do not assume the RealtimeKit export charge replaces Stream delivery
or recording storage: the current documentation presents both price schedules,
but does not clearly reconcile how RealtimeKit-managed HLS maps onto Stream
billing for this account. Confirm invoices / billing telemetry in a controlled
spike. [Stream pricing](https://developers.cloudflare.com/stream/pricing/)
· [RealtimeKit pricing](https://developers.cloudflare.com/realtime/realtimekit/platform/pricing/)
· [RealtimeKit billing FAQ](https://developers.cloudflare.com/realtime/realtimekit/faq/)

Cost comparison should use measured simultaneous viewers and minutes watched.
The current RealtimeKit viewer path incurs active participant minutes per
viewer (at the listed post-included A/V rate); HLS moves viewers to Stream
delivery minutes, plus any RealtimeKit export charge. This may lower cost at
scale, but no break-even claim is supportable until we confirm export billing
and real viewer patterns.

## Authorization by audience

| Audience | Current policy | HLS feasibility and required control |
| --- | --- | --- |
| Public broadcast | Anonymous viewers are allowed. | Direct playback URL is a reasonable fit. Verify that playback is only enabled while the stream is live and that any recording follows existing visibility rules. |
| Subscribers | Authenticated, active subscription required by backend. | Viable only if backend checks the same entitlement before issuing short-lived signed playback access. Test revocation/expiry and prevent a cached or copied long-lived URL from bypassing membership. |
| PPV | Authenticated join, economic admission/reserve, then participant time drives viewer charges and settlement. | Highest risk. Must bind access to a valid admission, meter delivered/watched time with defined reconnect and multi-tab behavior, and prove failure/retry/settlement semantics. A shared bearer manifest alone cannot identify or meter individual viewers. |

Cloudflare's signed URLs are bearer tokens (not per-account media sessions),
and origin restrictions are defense-in-depth rather than an entitlement
system. For PPV, use the existing server authority to mint narrowly scoped,
short-lived tokens only after admission; decide how token refresh and watcher
disconnects interact with charges. If the RealtimeKit-created live input
cannot be protected, keep subscribers and PPV on WebRTC and limit HLS to
public broadcast. [Secure Stream](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/)

## Viewer metrics

For live HLS, Stream's `/views` endpoint can expose a current `liveViewers`
count. RealtimeKit's livestream analytics provides `total_viewer_seconds` and
per-session `viewer_seconds`, plus ingest duration. These are suitable for
aggregate reach and delivery diagnostics, not per-user billing, entitlement,
unique viewers, or auditable PPV receipts. Continue recording authoritative
Free2Z admission and payment events independently. Reconcile platform counts
against our own HLS player session telemetry during the spike. [Stream live
viewer counts](https://developers.cloudflare.com/stream/getting-analytics/live-viewer-count/)
· [RealtimeKit livestream analytics](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/livestreams/methods/get_livestream_analytics_complete/)

## Migration and measurement plan

1. **Prototype only public broadcast behind a server-side feature flag.** Keep
   the current WebRTC path as fallback. Start a RealtimeKit meeting livestream
   for a dedicated test broadcast; do not expose ingest credentials to the
   browser. Confirm lifecycle start/stop, failure states, browser playback,
   recording visibility, CSP and mobile Safari/Android support.
2. **Measure latency and quality** against the current webinar baseline using
   synchronized host/viewer clocks or a visible timestamp slate. Record
   p50/p95 time-to-first-frame, glass-to-glass latency, stalls/rebuffer time,
   failed joins, resolution changes and host uplink. Test standard HLS and
   LL-HLS separately where supported; include slow and mobile networks.
3. **Measure audience scale and cost:** at controlled 1/10/100+ viewers, capture
   participant minutes, RealtimeKit export minutes, Stream delivery/storage,
   stream startup and concurrent viewers. Reconcile provider invoices/usage
   after billing data settles; include no-viewer and recording-on/off cases if
   controllable.
4. **Prove paid access before expanding:** test live-input signing with the
   actual RealtimeKit-created input; unauthorized and expired tokens; token
   sharing; subscription expiry; PPV admission, viewer-time accounting,
   reconnects, multiple tabs, disconnects, provider/webhook retries and
   settlement/reversal. Compare PPV billed time with observed player watch
   time. If individual watch-time accounting cannot be made authoritative,
   do not migrate PPV.
5. **Only after results:** decide separately for public, subscribers, and PPV.
   If approved later, change the viewer response/UI to use an authorized HLS
   manifest/player while preserving current backend admission and economic
   records; retain WebRTC for host participation and interactive rooms.

## Explicit unknowns

- Can the RealtimeKit-created Stream input have signed playback enabled and
  keep it enabled across livestream restarts? Is a signed token accepted for
  its live manifest and segments, and how does expiry behave during playback?
- What exactly is charged for RealtimeKit-managed HLS: export minutes, Stream
  delivered minutes, storage for recordings, and what monthly allowances apply
  to this account? What does Cloudflare's billing dashboard actually report?
- What latency, startup time, stall rate, rendition/ABR behavior and platform
  support do our current player matrix achieve? The docs do not provide a
  universal HLS glass-to-glass figure.
- Which RealtimeKit LIVESTREAM SDK/browser APIs are stable in our locked
  `@cloudflare/realtimekit@2.0.3` version, how does it change meeting modes, and
  can the current app keep host controls/recording without admitting viewers
  as participants?
- How should PPV charge for seconds when HLS prefetches/buffers segments, when
  playback continues in a background tab, or when a bearer token is copied?
  Provider aggregate viewer-seconds cannot settle individual accounts.
- Can HLS coexist with current chat/moderation and existing recording access
  tiers without leaking subscriber/PPV recordings?
