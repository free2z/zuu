# Google Play setup — the three apps

Where each app stands in Google Play Console, what is blocking it, and what the
next agent should pick up. Derived from the live console on **2026-09-07**.

This page records **console state**, which no test in this repository can prove.
Treat it the way [`docs/status.md`](../status.md) treats the tree: if another
page disagrees, this one was checked against the console and the other is a bug.
Re-derive it before relying on it, because a human can change the console at any
time without touching the repository.

Developer account: **Corpora Inc**, `skylar@corpora.inc`.

| App | Package | Play status |
| --- | --- | --- |
| ZUULI | `cash.free2z.zuuli` | Draft, internal testing track exists |
| Free2Z | `cash.free2z.free2z` | Draft, 7 of 11 declarations done |
| E2E2Z | `cash.free2z.e2e2z` | Draft, 7 of 10 declarations done |

Nothing has been uploaded to any app. No release has been created. Nothing has
been sent for review — every change below is staged as a pending change in
Publishing overview. ZUULI's own setup was not modified.

---

## 1. What is complete on Free2Z and E2E2Z

Both apps, identically:

| Declaration | Answer | Why it is that answer |
| --- | --- | --- |
| Privacy policy | `https://free2z.cash/docs/legal/privacy-policy/` | resolves 200 |
| Ads | No | no ad, analytics or tracking SDK in either dependency tree; no `play-services` or `com.google.android.gms` in either Gradle config |
| Advertising ID | No | same evidence |
| Government apps | No | — |
| Health apps | None | — |
| Content ratings | **IARC Completed** | see below |
| Store listing | title, short and full description | graphics still missing, see §3 |
| Contact details | `help@free2z.com`, `https://free2z.cash/` | — |

Diverging:

| | Free2Z | E2E2Z |
| --- | --- | --- |
| Play category | Social | Communication |
| IARC category | Social | Communication |
| Financial features | None | None |

### The content ratings, and why they are load-bearing

Submitted 2026-09-07 under `help@free2z.com`.

| Authority | Free2Z | E2E2Z |
| --- | --- | --- |
| ClassInd (Brazil) | 14+ | All ages |
| ESRB (North America) | Teen | Everyone |
| PEGI (Europe) | Parental guidance | Parental guidance |
| USK (Germany) | 16+ | 16+ |
| IARC generic | 12+ | 12+ |

Free2Z carries the descriptor *Inappropriate Language* and the interactive
elements *Users Interact* and *In-App Purchases*.

The answers were derived from the tree, not guessed:

- **Purchases: yes** for Free2Z. `wallet/free2z/src/lib/auth/paid-intent.ts`
  declares the paid-action population — `ai`, `article-tip`, `creator-tip`,
  `creator-subscription`, `live-entry`.
- **Location shared with other users: no.** Neither app requests a location
  permission; see each `src-tauri/gen/android/app/src/main/AndroidManifest.xml`.
- **Nudity and graphic violence: no**, grounded in the published User Content
  Agreement, which prohibits obscene and pornographic content.
- **Block, report, chat moderation: no** for both. That is what the code
  supports — `wallet/free2z/src/features/articles/components/Comments/CommentCard.tsx`
  labels the comment surface *"Untrusted, unmoderated user content"*, and there
  is no report or block affordance anywhere in either app.

> **This is the trap for the next agent.** Those three "no" answers are on
> record with the rating authorities. When a report/block control ships, the
> questionnaire is stale and has to be **resubmitted** — it is not a form in our
> console that can be quietly corrected.

---

## 2. What is blocking, in dependency order

### Sign in details — both apps — blocks Target audience

Play asks whether any part of the app is restricted. Free2Z: yes (account
sign-in plus paid memberships, PPV entry, AI). E2E2Z: yes (device enrollment is
issued by the wallet app).

Answering yes opens an "Add details" dialog demanding a **demo username and
password**. Until it is submitted, Target audience and content **refuses to
open** on both apps; the console says so explicitly.

**A human must do this.** An agent must not type credentials into a form.

### Target audience and content — both apps

Blocked on the above. The privacy policy states the service is not intended for
children under 13; the age selection has to be consistent with that.

### Data safety — both apps

Blocked on a privacy-policy update, open as a PR in the private production
repository. Free2Z's declaration has to cover account information, published
content, identity documents and tax forms, payment and transaction records, AI
prompts, livestream audio and video, Zcash addresses, and usage data. E2E2Z's is
far smaller — it requests only `INTERNET` and keeps device keys on the device.

Do not file a declaration the published policy does not support.

### Child safety standards — Free2Z only

Choosing the **Social** category triggered it: *"Apps within the dating and
social categories must meet these requirements."* It wants published child
safety standards, an in-app CSAE reporting mechanism, and a law-enforcement
contact. E2E2Z, as Communication, was not asked.

The in-app half is the report/block work tracked in the private production
repository. The published document and the contact are owner and legal work.

---

## 3. Store graphics are absent

`wallet/zuuli/store/` is the catalog pattern: `manifest.json`,
`locales/en-US/play.json`, hash-pinned media in `wallet/zuuli/assets/store/`,
and deterministic captures from `scripts/store-screenshot-capture.mjs`.

**`wallet/free2z/` and `wallet/e2e2z/` have no `store/` and no `assets/store/`.**
Play will not complete a listing without a 512 × 512 icon, a 1024 × 500 feature
graphic and two phone screenshots per app. The listing *text* is already saved
in the console and should be moved into `store/locales/en-US/play.json` so the
repository, not the console, is the source of truth.

---

## 4. Automation is not available from a workstation

The only service account with Play access is
`corpan-play-verifier@corpora1.iam.gserviceaccount.com`. Its key is **not** on
the development machine, and `admin-account@corpora1.iam.gserviceaccount.com`
gets `403` from `androidpublisher.googleapis.com` on all three packages.

Even with a key, the Publisher API cannot reach most of this. `edits.listings`,
`edits.images` and `edits.details` cover listing text, media and contact
details. Privacy policy, app category, content ratings, target audience, data
safety, financial features, health and child safety standards are console-only.

So this work is browser work until someone provisions a key, and even then only
the listing half can be automated.

---

## 5. Suggested order for whoever picks this up

1. **Store catalogs for free2z and e2e2z** (§3). Pure repository work, blocks
   nothing else, and is the largest remaining chunk that an agent can finish
   alone.
2. **Report and block for user content.** Unblocks child safety standards, fixes
   a real Play UGC-policy gap, and is API-first — the private production
   repository has the issue with the scope.
3. **Data safety**, once the privacy-policy PR is merged and live.
4. **Sign in details and Target audience**, after a human supplies a demo
   account.
5. **Resubmit the IARC questionnaire** once report/block ships.

Steps 1 and 2 need no human input and do not depend on each other.
