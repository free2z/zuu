# Livestream troubleshooting report investigation (#1414)

## Finding

The screenshot does not establish a stuck report. The Audio, Video, Screenshare, “Network & Media,” and “Generating report…” strings belong to Cloudflare RealtimeKit UI, not Free2Z-owned Svelte markup. Free2Z mounts the SDK meeting custom element in `src/lib/components/stream/InlineRtkMeeting.svelte` and passes the SDK translator through `t={translator}`. The “report” is a local presentation of producer score stats, not a separate report request: the UI listens for `mediaScoreUpdate` events and formats the latest score object.

The project declares and lockfiles `@cloudflare/realtimekit` and `@cloudflare/realtimekit-ui` at **2.0.3** (`package.json`, `package-lock.json`). `npm ci` completed successfully from `ts/svelte/free2z` and installed the integrity-locked package. Inspection of the packaged `dist/esm/rtk-debugger-audio_4.entry.js` shows event-driven behavior with no report HTTP request, polling timer, timeout, failure state, or retry action. No live room credentials or provider session were available, so the actual custom element and provider score event stream could not be exercised in a browser. I cannot claim a runtime reproduction or a fix.

## Source and reproduction boundary

- `src/lib/components/stream/InlineRtkMeeting.svelte`: embeds `<rtk-meeting>` and passes `meeting` plus the translated `t` function; it does not implement the troubleshooting dialog or report lifecycle.
- `src/lib/locales/rtk/en.json` and sibling locale files: include SDK keys such as `debugger.audio.messages.generating_report`, `debugger.video.messages.generating_report`, `debugger.screenshare.messages.generating_report`, and corresponding `sections.network_media` entries. This is localization input, not report-generation logic.
- `package.json` / `package-lock.json`: SDK and UI package versions are 2.0.3.
- `src/routes/[username]/dashboard/stream/+page.svelte`: owns the host room setup, but mounts the same packaged meeting UI rather than the debugger implementation.
- Installed package symbols (`@cloudflare/realtimekit-ui@2.0.3`, `dist/esm/rtk-debugger-audio_4.entry.js`): `RtkDebuggerAudio.mediaScoreUpdateListener` assigns `scoreStats` for `kind === 'audio' && !isScreenshare`; `audioProducerScoreStatsChanged` clears the displayed stats on null and formats bitrate, packet loss, and jitter otherwise. `connectedCallback`/`meetingChanged` subscribe to `mediaScoreUpdate`, `audioUpdate`, and `deviceListUpdate`; `disconnectedCallback` unregisters them. `render` selects “Generating report…” whenever the stats array is empty while `meeting.self.audioEnabled` remains true. There is no timer or terminal error/retry path in this component.
- The same entry bundle's `RtkDebuggerVideo` listens for non-screenshare video score events and displays CPU/bandwidth limitations, bitrate, packet loss, and jitter. `RtkDebuggerScreenShare` separately listens for `mediaScoreUpdate` where `isScreenshare` is true and `screenShareUpdate`; null screen-share scores clear the displayed rows. Audio and video tabs therefore show event-derived stats, while Screenshare renders video score rows (and also formats screen-share audio score data in a second property path).

## Reproduction matrix for a provider-backed session

Use a disposable host room in a supported browser, open the in-room troubleshooting control, and capture browser version, operating system, room role, SDK package versions, media permission state, console logs, and observed `mediaScoreUpdate` events with tokens redacted. The UI does not make an identifiable report request, so DevTools request blocking/network throttling alone does not deterministically delay this local rendering; reproduce slow/missing stats by delaying or suppressing the SDK score event in an actual provider test harness, if that SDK exposes one.

| Case | Action | Record |
|---|---|---|
| Audio | Open Audio troubleshooting with microphone enabled; wait beyond the displayed “few seconds” | Whether report content replaces progress; visible fields and completion time |
| Video | Repeat with camera enabled | Same, plus whether report reflects the active camera track |
| Screenshare | Start screen sharing, open its troubleshooting view | Same, plus behavior after stopping the share |
| No media | Open each relevant view with its source disabled | Whether SDK gives a clear enable-media state or leaves progress visible |
| Slow | Delay the provider's `mediaScoreUpdate` delivery in a supported SDK test harness | Time to first score event, whether progress remains visible, any SDK timeout/error affordance |
| Missing event | With source media enabled, suppress the relevant `mediaScoreUpdate` event | Confirm current package behavior: “Generating report…” remains because no deadline/error transition is present in the inspected component |
| Recovery | Resume score event delivery after the missing-event case | Whether the listener updates rows without rejoining; verify separately for audio, camera video, and screen share |
| Media disabled | Disable the corresponding source | Whether the component shows its localized enable-media message; confirm stale stats clear on audio/video disable or screen-share stop |

The installed package exposes bundled component code, not a documented test fixture API. No deterministic fixture or actual SDK component browser test was run. Do not replace the `<rtk-meeting>` element with a local imitation: that would test Free2Z markup and not the provider score event lifecycle.

## Tested states and limits

- Confirmed by repository search and installed SDK bundle inspection: user-visible labels/messages are supplied by RealtimeKit locale keys; no report request exists in the debugger path. Stats appear only after `mediaScoreUpdate` populates component state; empty stats plus enabled media render the progress string, with no timeout/error/retry transition found in the inspected package component.
- Confirmed from lockfile install: `npm ci` exited successfully and installed RealtimeKit UI 2.0.3 from the integrity-locked dependency tree.
- Confirmed by source inspection: Free2Z passes its meeting client and translator into the SDK web component.
- Not tested: browser rendering of the packaged custom element, actual audio/video/screenshare score events, provider latency/failure behavior, or recovery. A provider-backed room is inaccessible. The missing-event behavior above is a source-derived consequence, not a runtime reproduction.

## Next actionable step

Run the matrix against a disposable RealtimeKit room with package 2.0.3 and capture timestamped SDK score events plus the rendered component state. The source inspection establishes a concrete UX risk: enabled media with no score event has no bounded transition out of “Generating report…”. Whether real rooms can enter that state and for how long remains unresolved. If reproduced, attach redacted event/console evidence and timing to #1414; determine whether the provider failed to emit stats or the SDK should add an explicit stale/error state before proposing a Free2Z patch. This PR records an investigation and does not claim a production fix.
