# Recovery-phrase capture verification

Issue #381 remains open until these protections are exercised on physical
devices. Automated checks prove the software boundary and its fail-closed race
behavior; they cannot prove how a particular OS release, OEM recents UI, screen
recorder, or external display behaves.

## Software-verifiable generated-backup boundary

- Wallet creation returns only the wallet ID and birthday. Its generated
  mnemonic enters the renderer only after an explicit backup action performs a
  fresh native user-presence check.
- An exact native display lease is acquired before that custody read. Releases
  are bound to opaque leases, so delayed cleanup cannot uncover a newer reveal.
- Blur, page hide, visibility loss, explicit Hide, confirmation, and unmount
  synchronously replace renderer mnemonic state with `null`.
- Android holds `FLAG_SECURE` for the full sensitive lease, including while the
  activity is backgrounded; Android uses that flag to block still screenshots,
  recording, and non-secure displays. iOS installs an opaque cover before
  inactive/background snapshots and while recording or mirroring reports the
  screen as captured.
- iOS does not expose an application API that can prevent an ordinary still
  screenshot while the app remains active. The cover cannot retroactively hide
  a screenshot, so active iOS still-screenshot protection is a known residual,
  not a claim of this slice. Desktop still/recording protection is likewise not
  claimed: its display-lease platform hook is intentionally a no-op because the
  supported desktops do not share one enforceable capture API.
- Recovery words are excluded from the accessibility tree. Seed-copy UI was
  removed; ZUULI therefore places no mnemonic on the clipboard.

This slice does not yet protect user-entered restore mnemonics in
`RestoreIdentity.tsx`, Onboarding's `RestorePane`, classic Zuuallet's
`RestoreWallet`, or its Settings re-link field with the native display lease.
Those inputs remain renderer-visible while the user types or pastes them. Issue
#381 therefore remains open for restore-input protection as well as the
physical-device evidence below.

Run the automated contract with:

```sh
npm run test:seed-capture
```

## Physical evidence still required

Test a release-signed build on every supported Android API/OEM family and iOS
major version before closing #381:

1. Reveal after biometric/device-credential authentication; confirm a fresh
   prompt is required for every subsequent reveal.
2. On Android, attempt a still screenshot and native screen recording while the
   words are visible; verify no word appears in the resulting media or transient
   preview. On iOS, record the expected residual that an ordinary active still
   screenshot can contain the words; use only a disposable test wallet and
   never attach that screenshot to the issue.
3. Background from the visible phrase and inspect the app switcher/recents
   snapshot before returning. It must be opaque, and returning must require a
   new reveal.
4. Start recording before reveal, during reveal, and while backgrounding. On
   iOS, verify recording and AirPlay/external mirroring are covered while the
   OS reports capture active; this evidence does not imply still-screenshot
   prevention.
5. Exercise rapid background/foreground, Hide/reveal, and dismissal/reopen
   races. An older dismissal must never disable protection for the newer view.
6. Confirm VoiceOver/TalkBack does not speak or snapshot the mnemonic and that
   the clipboard remains unchanged throughout.

Record device model, OS/build number, build SHA, and the redacted media result
on issue #381. Never attach a real recovery phrase; use a disposable test wallet.
