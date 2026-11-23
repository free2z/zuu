# Issue #1421: livestream chat images and participant departure

## Scope and outcome

This note records source inspection for [free2z/zuu#1421](https://github.com/free2z/zuu/issues/1421), which reports that a chat image disappears when its sender leaves a stream. The issue screenshot was described as showing initial avatars; it does not identify whether the disappearing item is an avatar or an image message.

No production change is proposed here. There was no live Cloudflare room or two-participant runtime reproduction during this investigation. The observations below describe the checked-in app integration and the exact installed SDK package sources; they do **not** prove that the reported behavior cannot occur.

## Versions and app integration

`wallet/free2z/package-lock.json` locks `@cloudflare/realtimekit` 1.5.1, `@cloudflare/realtimekit-react` 1.5.1, `@cloudflare/realtimekit-react-ui` 1.2.0, and its UI implementation package `@cloudflare/realtimekit-ui` 1.2.0. The app's `wallet/free2z/src/features/live/Stage.tsx` mounts the provider client in `<RtkMeeting mode="fill">`; chat rendering and participant roster behavior are therefore supplied by RealtimeKit's packaged UI and SDK, not by a first-party chat component.

## Inspected message and roster paths

References below are paths inside the installed packages under `wallet/free2z/node_modules`; package versions are pinned by the lockfile above.

- `@cloudflare/realtimekit-ui/dist/esm/rtk-chat-messages-ui.entry.js`, `renderMessages` (around lines 168–184): determines whether a message continues the preceding sender's group using equal `userId` and a time difference under two minutes. It renders `message.displayName`; for image messages it passes `message.link` to `<rtk-image-message-view>`. A continued message is rendered with `is-continued` and omits the separate sender heading/avatar treatment.
- `@cloudflare/realtimekit-ui/dist/esm/rtk-chat-message.entry.js`, `renderAvatar` (around lines 83–94): the component avatar uses `message.displayName` and `senderDisplayPicture`. If `isContinued`, it returns an empty avatar container. This component is not the same rendering path as the paginated chat list above, which explicitly sets `hideAvatar` on `rtk-message-view` and renders its own sender heading.
- `@cloudflare/realtimekit/dist/index.es.js`, chat class `getChatMessages` and `setupEvents` (around lines 13117–13205): message history is formatted into `chat.messages`; room and peer message events append formatted messages; edit replaces a matching message; delete removes a matching message; pin replaces a matching message. These inspected handlers do not visibly consult the participant roster when rendering or update message fields on participant departure.
- In the same SDK bundle, the roster store setup around line 18303 configures its delete event as `participantLeft`. This is a distinct participant-store path. Inspection did not find a `participantLeft` subscription in the chat class's `setupEvents` block above. This is a bounded source observation, not proof that no other SDK code or server event can affect message data.

The SDK's default/fallback avatar rendering is delegated to `rtk-avatar` from the participant-shaped `{ name, picture }` input; this source review did not execute that custom element to establish exact initials, image loading, or error fallback behavior. Likewise, a message retaining a `link` in the inspected model does not prove its remote image remains fetchable after departure or that an already-rendered browser image survives a network/cache failure.

## Reproduction matrix for a real two-participant room

Use participant A as the sender and participant B as the observer. Record the chat DOM and visible content before A leaves, immediately after A leaves, and after B refreshes/rejoins. Keep message/avatar-image URLs and network conditions stable unless a row changes them.

| State | Setup / action | What to record |
|---|---|---|
| Photo avatar + text and image | A joins with a photo avatar, sends a text message and an image message; B observes; A leaves. | Whether text remains; whether the sender photo remains or falls back; whether the image message and its image remain; console/network image errors. |
| Initials fallback | Repeat with A having no photo avatar; send text and image, then leave. | Whether initials are present before and after departure; whether message content changes. |
| Consecutive messages | A sends two text messages within two minutes, then a separate image message; A leaves. | Which messages are grouped/continued, where avatar/name appears, and whether departure changes either message or grouping. |
| Refresh/rejoin | After the preceding messages and departure, B refreshes and rejoins the same room if available. | Whether history is restored and whether avatar/image fields or visible output differ from the pre-refresh observation. |
| Network image failure | Repeat the photo-avatar and image-message cases while blocking or failing the respective image requests, before and after A leaves. | Distinguish avatar fallback from image-message load failure; capture request URL/status and visible placeholder/error state. |

Do not treat the image-message row as an avatar test: the avatar picture and message `link` are separate data/rendering inputs. Record which actual UI element disappears before attributing the report to either path.

## Verification status and limits

This investigation verified the lockfile versions and inspected the packaged source paths listed above. It did not run the browser UI, join a real room, produce a two-client event trace, or verify avatar/image URL availability across departure. Therefore the reported behavior remains unresolved. The matrix is the concrete next reproduction procedure; a runtime result is needed before changing production code or claiming absence of a defect.
