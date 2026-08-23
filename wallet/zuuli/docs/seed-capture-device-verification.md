# Recovery-phrase capture verification

Issue #381 remains open until these protections are exercised on physical
devices. Automated checks prove the software boundary and its fail-closed race
behavior; they cannot prove how a particular OS release, OEM recents UI, screen
recorder, or external display behaves.

## Software-verifiable boundary

- Wallet creation returns only the wallet ID and birthday. A mnemonic enters
  the renderer only after an explicit backup action performs a fresh native
  user-presence check.
- Native capture protection is acquired before that custody read. Releases are
  bound to opaque leases, so delayed cleanup cannot uncover a newer reveal.
- Blur, page hide, visibility loss, explicit Hide, confirmation, and unmount
  synchronously replace renderer mnemonic state with `null`.
- Android holds `FLAG_SECURE` for the full sensitive lease, including while the
  activity is backgrounded. iOS installs an opaque cover before inactive/
  background snapshots and while screen capture is active.
- Recovery words are excluded from the accessibility tree. Seed-copy UI was
  removed; ZUULI therefore places no mnemonic on the clipboard.

Run the automated contract with:

```sh
npm run test:seed-capture
```

## Physical evidence still required

Test a release-signed build on every supported Android API/OEM family and iOS
major version before closing #381:

1. Reveal after biometric/device-credential authentication; confirm a fresh
   prompt is required for every subsequent reveal.
2. Attempt a screenshot and native screen recording while the words are
   visible. Verify no word appears in the resulting media or transient preview.
3. Background from the visible phrase and inspect the app switcher/recents
   snapshot before returning. It must be opaque, and returning must require a
   new reveal.
4. Start recording before reveal, during reveal, and while backgrounding. On
   iOS, also exercise AirPlay/external capture.
5. Exercise rapid background/foreground, Hide/reveal, and dismissal/reopen
   races. An older dismissal must never disable protection for the newer view.
6. Confirm VoiceOver/TalkBack does not speak or snapshot the mnemonic and that
   the clipboard remains unchanged throughout.

Record device model, OS/build number, build SHA, and the redacted media result
on issue #381. Never attach a real recovery phrase; use a disposable test wallet.
