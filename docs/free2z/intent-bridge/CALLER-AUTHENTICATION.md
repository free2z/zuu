# Who is calling, and who is answering

The two hard questions of
[#905](https://github.com/free2z/zuu/issues/905), answered per platform, with
the parts that are **not** answered marked as such.

> **The one-paragraph version.** A deep link does not authenticate its sender.
> The native confirmation is the primary control and it holds: a hostile caller
> cannot forge the user's approval. But the confirmation's strength varies
> sharply by intent family, and it is **weakest exactly where the request is
> least auditable** — a user can judge a payment and cannot judge a challenge.
> Caller identity is genuine defence in depth on Android and **absent** on iOS.
> We ship the registry and the Android attestation surface; we ship no iOS
> attestation, because there is none to ship.

---

## 1. What a link can and cannot tell you

| Mechanism | Establishes | Does not establish |
|---|---|---|
| Custom scheme (`zuuli://…`) | nothing | anything. Any app registers any scheme |
| Verified App Link / Universal Link | that **this app** is the one the domain authorised to *receive* | who *sent* it |
| Android `getCallingPackage()` on an activity started for result | the sender's package name, from the OS | that the package is the build we published — until the signing certificate is checked too |
| iOS | — | — |

The middle row is the one people get wrong, and
[#905](https://github.com/free2z/zuu/issues/905) states it exactly: "even a
verified App Link tells you the *link* was verified, not who opened it."
Domain verification is about the **receiving** end. It is the answer to
[§4](#4-response-authenticity) and it is not an answer to this section.

## 2. The primary control, and where it is thin

The design puts the weight on the native confirmation: the user approves inside
ZUULI, seeing ZUULI's own rendering, of ZUULI's own re-derivation. A hostile
caller can therefore cause a *request*; it cannot cause an *approval*. That
much is sound and it is what makes the bridge safe to design before caller
identity is settled.

**It is not uniformly sound across the three intents, and the difference
matters more than the framing suggests.**

| Intent | What the user is actually judging | Strength |
|---|---|---|
| `execute-payment` | a recipient address, an amount, a memo, a fee — all semantic, all re-derived by the wallet from its own state | **Strong.** A hostile request looks wrong |
| `issue-device-credential` | a handle and a validity window, plus two opaque public keys | **Medium.** The handle is meaningful; the keys are not auditable by a human |
| `sign-challenge` | 32 opaque bytes, plus `purpose` and the caller's name | **Weak** |

For `sign-challenge` the only human-meaningful content in the entire request is
*who is asking* and *what for* — and on iOS **both of those are attacker-chosen
strings**. `purpose` comes from the request. The caller's identity is a claim.
So the concrete attack is:

1. A hostile app registers the same link and receives the user's tap, or simply
   originates a request of its own.
2. It sends `sign-challenge` with `caller: cash.free2z.free2z` and
   `purpose: "Sign in to free2z"`.
3. ZUULI renders a confirmation that is, from the user's side, indistinguishable
   from the honest one — because it *is* the honest one, with a different
   sender.
4. The user approves. The signature is a login attestation. The attacker
   replays it and is now signed in as the user.

The native confirmation did not fail here. It was never able to tell the
difference. That is a real limit of the "confirmation is the primary control"
argument, and it is why this document does not stop at that argument.

Two things narrow it, and neither closes it:

- **The registry** ([§3](#3-android)) means the hostile app has to *claim* a
  registered identifier. That is free on iOS — it is a string in a message — so
  the registry's value there is only that it bounds the set of names the
  confirmation will ever render.
- **ZUULI renders the caller's display name from its own registry, never from
  the request.** So a caller cannot choose how it is described; it can only
  choose which registered description to impersonate. Enforced in
  `f2z_intent::CallerRegistry::authorize` and tested by
  `the_rendered_name_comes_from_the_registry_and_not_the_request`.

What actually closes it is a transport that identifies the sender
([§3](#3-android)) or a verifier that binds the challenge to a session it
issued and receives the answer over a channel it controls
([§5](#5-what-is-not-built)).

## 3. Android

`Activity.getCallingPackage()` is the honest primitive. It returns the package
that started the activity **for a result**, and it comes from the system, not
from the message. Combined with the signing certificate — read from
`PackageManager` with `GET_SIGNING_CERTIFICATES`, hashed, and compared against
an allowlist — it distinguishes our published build from a side-loaded APK that
merely reused the package name.

Both halves are implemented and both are refusals, not downgrades:

```rust
CallerAttestation::Platform { package, signing_cert }
```

- `package` must equal the request's claimed `caller`, or
  `INTENT_CALLER_NOT_AUTHORIZED`.
- `signing_cert` must be one of the registered digests for that caller, or
  `INTENT_CALLER_NOT_AUTHORIZED`.

Neither is a downgrade to "claimed": an app that lies about its identity while
the OS is watching is not a caller whose request should be shown to a user at
all. `an_android_impersonator_is_caught_by_the_platform_and_by_the_certificate`
covers both, and both mutations fail it
([`CONFORMANCE.md`](./CONFORMANCE.md)).

### 3.1 The catch, and it changes what #461 is for

`getCallingPackage()` returns `null` when the caller used `startActivity`
rather than `startActivityForResult`. So the attestation is a property of the
**transport**, not of the platform:

- **`startActivityForResult` against ZUULI's exported activity** gives caller
  identity *and* gives response authenticity for free — `setResult` returns to
  the identified caller, and no domain association is involved at all.
- A plain App Link *view* gives domain verification for the receiving end and
  no caller identity.

Which means the honest Android transport for this bridge is very likely
**activity-for-result, not App Links**, and if that holds then
[#461](https://github.com/free2z/zuu/issues/461) is an **iOS** prerequisite
rather than a universal one.

> **Not measured.** Whether an implicit `VIEW` intent on a verified https URL,
> started with `startActivityForResult`, preserves `getCallingPackage()` — and
> how that interacts with `FLAG_ACTIVITY_NEW_TASK`, App Link disambiguation and
> Android 11+ package visibility (`<queries>`) — has **not** been tested here.
> It should be the first thing the Android surface measures, on a signed build,
> on a device. Nothing in this repository currently proves it either way, and
> this document will not claim otherwise.

If it does not hold, Android has to choose one property or the other per call,
and the choice should be: **activity-for-result**, because caller identity plus
a directed result is strictly more than domain verification of the inbound link.

## 4. Response authenticity

A caller must be able to tell a genuine ZUULI response from a forged one.

**What the protocol gives on its own.** `request_id` is 32 CSPRNG bytes that
appear in exactly one outbound message, and
`IntentSession::accept` refuses any response that does not match an outstanding
question — identifier, family and window all re-checked, entry consumed either
way. So an app that never saw the request cannot forge a response.

**What it does not give.** An app that *received* the request holds the
identifier and can answer. Correlation is not authentication. Nothing in the
message proves ZUULI wrote it.

**Android**, on the activity-for-result path: solved. `setResult` delivers to
the caller that the system identified, and `onActivityResult` receives it from
the activity the caller itself started. No forgery window.

**iOS**: the response travels back as a Universal Link, and the security
property is that only the app whose team owns the `apple-app-site-association`
receives it. That is [#461](https://github.com/free2z/zuu/issues/461), and it
is a hard prerequisite: shipping this over a custom scheme would let any app
register the response link and answer `sign-challenge` with a signature the
caller then trusts — [#367](https://github.com/free2z/zuu/issues/367)'s confused
deputy, moved from the frame layer to the OS layer.

### 4.1 Residual risk if the App Link assumption fails

It does not fail by handing the link to a hostile app — the association is
domain-bound, and a third party cannot claim our domain. It fails by
**degrading to the web**, and that is the risk to plan for:

- `apple-app-site-association` served with the wrong content type, behind a
  redirect, or stale in a CDN cache; the association silently stops resolving.
- The user chose "open in Safari" from the link's long-press menu, or arrived
  via a context iOS does not treat as a Universal Link (a pasted URL, some
  in-app browsers).
- The app is not installed on this device.

In every one of those, the response opens **a web page on our own domain**
instead of the app. Not an attacker's page — but a URL, and URLs are written to
browser history, sent as `Referer`, and logged by every hop that serves them. A
signature or a `DeviceCredential` in a query string is then a secret in a log
file.

The mitigation is a protocol rule and belongs on the transport work, not here:
**never place a response payload in the query component.** Either put it in the
fragment, which is not sent to servers, or return only a one-use retrieval
handle and have the client fetch the payload over a channel the OS mediates.
Recorded here because it is exactly the sort of thing that is obvious in
advance and expensive after a shipped release.

## 5. What is not built

Stated plainly, because the alternative is a document that reads like coverage:

- **There is no iOS caller attestation, of any kind.** `sourceApplication` is
  not available for Universal Links and is not dependable for custom schemes on
  modern iOS. Every iOS request is `CallerTrust::Claimed` and the API has no
  path that upgrades it —
  `ios_gets_a_registered_caller_but_never_an_attested_one` pins that.
- **Per-caller enrollment keys are designed, not implemented.** The shape:
  during a one-time enrollment the user performs *inside ZUULI*, the calling app
  generates a keypair, ZUULI records the public half, and every later request
  carries a signature over the request digest. That authenticates the
  *installation*, which is a real reduction — from "any app that can send a
  link" to "an app the user once deliberately enrolled" — but it is
  trust-on-first-use with trust-on-first-use's weakness: a malicious app can be
  enrolled too, if the user enrols it. It is future work and nothing in this
  change implements it.
- **There is no signature over responses.** Adding one would need a ZUULI
  response key, which is a second identity for the wallet alongside the seed
  hierarchy, and minting one to paper over a transport gap is how a system ends
  up with two identities that disagree. The transport is the right layer.
- **Confusable identifiers are not detected.** See `PROTOCOL.md` §3.5.

## 6. The verdict

The framing this work started from was: *native confirmation is the primary
control; caller identity is defence in depth, strong on Android and weak on
iOS.* That is right in outline, and two corrections matter:

1. **The confirmation is not uniformly strong.** It is strong for
   `execute-payment`, medium for `issue-device-credential`, and weak for
   `sign-challenge` — because a human can audit an address and an amount and
   cannot audit 32 opaque bytes. The one intent that *looks* harmless, because
   it spends nothing, is the one where the primary control has the least to work
   with. Any staging that ships `sign-challenge` first because it is "only a
   signature" has it exactly backwards. Ship `execute-payment` first: it is the
   family the confirmation actually defends.
2. **"Strong on Android" is a property of the transport, not of Android.** It
   requires `startActivityForResult`, and that is a different transport from an
   App Link. If the two compose it costs nothing; if they do not, Android should
   take caller identity over inbound domain verification, and #461 narrows to
   an iOS prerequisite.

On iOS the honest summary is: **the native confirmation is the only control**,
the registry bounds which names it will render, and a user who approves an
`sign-challenge` request they did not initiate has no way to tell. That is
acceptable for a bridge that has not shipped a transport. It is not acceptable
as a permanent state, and per-caller enrollment keys are the named follow-up.
