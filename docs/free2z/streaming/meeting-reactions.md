# Free2Z meeting reactions

Free2Z's Svelte web livestream and native wallet livestream surfaces render a
small first-party reaction picker alongside the provider meeting UI. Reactions
use the authenticated joined meeting client's generic RealtimeKit
`participants.broadcastMessage` transport. The protocol type is
`free2z:meeting-reaction:v1`; its only payload field is an emoji from the
fixed five-item allowlist. There is no sender field and no participant names
or counts are displayed.

Each client enforces a one-second local send cooldown, accepts at most 12
reaction events per five-second global window, displays at most eight at a
time, and expires each display after three seconds. Invalid event type,
payload shape, and emoji values are ignored. Provider send failures are
reported to the local user. Buttons are keyboard-operable and named, incoming
events use a polite live region, and motion is disabled for users who prefer
reduced motion. Reaction listeners and timers are removed when the meeting
surface unmounts.

The SDK callback shape is `{ type, payload, timestamp }` and does not include a
provider-supplied sender identity. This feature intentionally treats reactions
as anonymous room events. The payload timestamp is not used as identity or
trusted for rate enforcement; client receipt time drives the global cap. The
SDK's generic broadcast API is room-scoped for joined clients, but these local
tests do not verify provider delivery, moderation, or cross-client behavior in
a live production room. No billing, ticket, public/private access, or room
role issuance behavior is changed.
