# Free2Z livestream message reactions investigation

Issue: [#1420](https://github.com/free2z/zuu/issues/1420) (open; this is
investigation evidence, not issue closure). Meeting-wide reactions are a
separate feature tracked by #1417.

## Current chat owners

The Svelte Free2Z app owns its livestream host and private-room pages. Both
mount the provider's `<rtk-meeting>` custom element:

- `ts/svelte/free2z/src/routes/[username]/dashboard/stream/+page.svelte`
- `ts/svelte/free2z/src/routes/[username]/private/[secret]/+page.svelte`

Initialization is in `ts/svelte/free2z/src/lib/utils/rtk-manager.ts`. The
component is provider-rendered; the app has no message-list renderer or chat
message adapter to extend. The separate `wallet/free2z` app likewise renders
the provider meeting UI from `wallet/free2z/src/features/live/Stage.tsx`.

## Locked provider surface checked

The Svelte lockfile pins `@cloudflare/realtimekit` and
`@cloudflare/realtimekit-ui` to **2.0.3**. After `npm ci --ignore-scripts`, the
installed SDK declaration
`ts/svelte/free2z/node_modules/@cloudflare/realtimekit/dist/index.d.ts`
defines `ChatMessage` with `chatId`, `peerId`, `userId`, `payload`,
`createdAt`, and other chat metadata (around line 1303). This supplies a
provider chat identity; the inspected public message shape has no reaction
collection. The same declaration's `controlBar.elements.reactions` field
(around line 3045) is a meeting control-bar capability, with no association to
`ChatMessage.chatId`.

For row extensibility, the inspected 2.0.3 UI declarations are
`ts/svelte/free2z/node_modules/@cloudflare/realtimekit-ui/dist/components/rtk-chat.d.ts`,
`rtk-chat-messages-ui.d.ts`, `rtk-chat-messages-ui-paginated.d.ts`,
`rtk-chat-message.d.ts`, `rtk-message-view.d.ts`,
`rtk-message-list-view.d.ts`, and `rtk-text-message-view.d.ts`. They describe
the provider chat/message elements; no per-message renderer slot or reaction
callback/configuration was found in these declarations. This is a bounded
statement about the inspected declarations and package exports, not proof
that no undocumented/custom integration is possible.

Reproduce the scoped declaration search from the repository root after
`npm ci --ignore-scripts` in each app:

```sh
rg -n -i 'reaction|sendReaction|addReaction|removeReaction|render.*message|message.*(slot|renderer)|ChatMessage|controlBar' \
  ts/svelte/free2z/node_modules/@cloudflare/realtimekit/dist/{index.d.ts,EncryptionManager.d.ts} \
  ts/svelte/free2z/node_modules/@cloudflare/realtimekit-ui/dist/components/{rtk-chat,rtk-chat-messages-ui,rtk-chat-messages-ui-paginated,rtk-chat-message,rtk-message-view,rtk-message-list-view,rtk-text-message-view}.d.ts
rg -n -i 'reaction|sendReaction|addReaction|removeReaction|render.*message|message.*(slot|renderer)|ChatMessage|controlBar' \
  wallet/free2z/node_modules/@cloudflare/realtimekit/dist/{index.d.ts,EncryptionManager.d.ts} \
  wallet/free2z/node_modules/@cloudflare/realtimekit-react-ui/dist/components/{rtk-chat,rtk-chat-messages-ui,rtk-chat-messages-ui-paginated,rtk-chat-message,rtk-message-view,rtk-message-list-view,rtk-text-message-view}.d.ts
```

The native lockfile pins `@cloudflare/realtimekit` **1.5.1** and
`@cloudflare/realtimekit-react-ui` **1.2.0**. The native declarations in
`wallet/free2z/node_modules/@cloudflare/realtimekit/dist/index.d.ts` and the
chat/message component declarations under
`wallet/free2z/node_modules/@cloudflare/realtimekit-react-ui/dist/components/`
were searched with the same patterns. No message-level API or row extension
hook was found in those inspected surfaces either. This is package-source
inspection only; no live provider room or runtime behavior was tested.

The native Free2Z app's Stage mounts the built-in full meeting/chat UI, as
shown in `wallet/free2z/src/features/live/Stage.tsx`. The declaration search
above did not find a message-scoped reaction API or row extension hook in its
inspected surfaces.

## Why a first-party endpoint alone is not yet safe

The apps obtain provider-authorized room access through `/api/dyte/...` join
tickets. The Django `py/free2z/dj/apps/dyte` code handles room creation and
join authorization, but exposes no durable chat-message mirror or endpoint
that can prove a submitted `chatId` is an actual message in the authorized
room. A client-supplied ID is not proof of message existence or room
membership. Further, a first-party reaction endpoint would not make reactions
visible inside the provider-rendered chat without a supported row extension
point or a replacement chat renderer that consumes an authoritative message
feed.

Implementing local counters, accepting arbitrary client message IDs, or
placing reaction payloads in chat text would not satisfy cross-participant
updates and message association. Any first-party contract must bind each reaction to the provider room and provider-issued chat message identity, authorize the
actor against the room's current participant access, enforce one actor/reaction
per message with idempotent add/remove, and publish authoritative aggregate
updates. Counts need explicit bounds and stale/deleted-message behavior.

## Next integration path

Engineering work remains. The inspected provider surfaces did not reveal a
supported hook, but that finding does not establish that provider/custom
integration is impossible. A first-party renderer and verified message
ingestion are a larger implementation path, not evidence of an external
blocker. End-to-end implementation can proceed by selecting and building one
of these paths:

1. A provider-supported per-message reaction mutation/event and a supported
   per-message UI extension in both locked app SDK generations; or
2. A first-party message ingestion/verification path that observes provider
   messages and their room identity, plus an authoritative room-scoped
   reaction API and realtime update channel, and a supported custom chat
   renderer (or provider UI extension) in the Svelte and native apps.

Then add accessible per-message add/remove controls and focused tests for
correct message association, permissions, idempotence, bounded counts,
realtime updates, and keyboard/screen-reader interaction. Keep these distinct
from the meeting-wide reactions control tracked by #1417.
