# Store compliance: getting a Free2Z app approved

**Status:** product guidance, checked against primary sources on 2026-10-14 ·
**Part of:** [f2z-sdk v1](./README.md)

This is the playbook for shipping an app built on the Free2Z SDK to the Apple
App Store and Google Play, listed for all ages, with no backend of your own.
Every rule below is written so you can test it before you submit. The
[Sources](#sources) section lists the policy text each rule rests on.

> **This is not legal advice.** It is Free2Z's reading of the store policies
> and laws on the date above. Policies change, and you are responsible for your
> own listing. Re-check the dated sources before every submission, and talk to
> a lawyer about children's-privacy law in the places you ship.

## The short version

1. **Never sell 2Z in the app.** No in-app purchase of 2Z, no checkout, and no
   `purchase:create` scope in any build. 2Z Inc sells 2Z on the web, on the
   user's Free2Z billing page.
2. **Never put a buy button, a price or "buy 2Z" copy in the app or its store
   listing**, except where the [table in §2](#2-the-line) allows it.
3. **Sign in through the system authentication session**
   (`ASWebAuthenticationSession`, Custom Tabs). Never open a Free2Z page in a
   WebView.
4. **When credits run out, stay calm.** Show "No credits" and a
   **Manage Free2Z account** button that opens the system browser
   (`client.openManageAccount()`, `sdk-v0.3.0`). A Google Play build, or an
   iOS build available outside the US storefront, **must not** show a billing link
   (`openBilling()`, SDK 0.4.0) or grant the plugin permission
   `f2z:allow-open-billing` ([§2](#2-the-line)).
5. **List the app as Education (or another fitting category) at 4+.** Do not
   use the Kids Category, and never write "for kids" in the metadata.
6. **Ask before sending anything to AI.** Name Free2Z and the AI provider, and
   get explicit permission before the first call. In an app that children use,
   an adult does this once, before **Connect Free2Z**.
7. **Keep the AI structured.** Offer preset choices in and accept
   schema-checked output back, with no free-text chat.
8. **Put a Report button on every AI-generated item.**
9. **Link account deletion** to `https://free2z.cash/account/delete`, both in
   the app and in Play Console.
10. **Tell App Review the truth.** Use the [notes template](#6-app-review-notes-template).

> **Do not submit until** each of these Free2Z pages exists and passes its
> check. As of 2026-10-14:
>
> - ✅ the store-safe **Manage** view: `/account/apps?client_id=` with no
>   purchase path ([§2](#2-the-line)). Built and on stage; it reaches
>   free2z.cash with the next production release. Check it there before you
>   submit;
> - ⏳ the deletion page `/account/delete` ([§4](#4-account-deletion));
> - ⏳ X-only accounts able to sign in on these pages, which deletion and
>   revoking an app depend on: X sign-in has to return to the page it
>   started from.

## 1. Why an SDK app never sells 2Z

2Z are platform credits that work in every Free2Z app. Neither store lets an
app sell credits that work beyond the app that sold them.

**Apple**, Developer Program License Agreement, Attachment 2:

> **§2.2** You may not enable end users to purchase Currency of any kind
> through the In-App Purchase API, including but not limited to any Currency
> for exchange, gifting, redemption, transfer, trading or use in purchasing or
> obtaining anything within or outside of Your Application. "Currency" means
> any form of currency, points, credits, resources, content or other items or
> units recognized by a group of individuals or entities as representing a
> particular value […]

> **§1.1** […] You may not use the In-App Purchase API to offer goods or
> services to be used exclusively outside of an Application, whether Yours or
> someone else's.

§2.2 is the clause that applies. §1.1 covers goods used *only* elsewhere. §2.1
also bars balances or credits for purchases "for use exclusively outside of
Your Application".

**Google**, Payments policy:

> In-app virtual currencies must only be used within the app or game title
> for which they were purchased.

So every SDK app is a **consumption-only client**. The user already holds 2Z,
which they bought from 2Z Inc on the web. The app spends 2Z through the AI
gateway. Usage is metered in 2Z usage credits, which are never cashed out.
Developer compensation is governed by the Free2Z Creator Compensation Agreement (cc-2026-10-v2, schedule `sdk-application-2026-10-v2`). It is paid in USD by 2Z Inc. from
its own funds, and it applies only after the developer's authenticated
acceptance, a verified legal-payee binding and activation (see
[metering §2.3](./spec/metering.md#23-splits)). Apps don't sell 2Z: the
SDK's purchase API ([purchase.md](./spec/purchase.md)) is deprecated for apps
since 0.4.0, and the SDK's default scopes no longer request `purchase:create`.
A web, direct-download desktop or Apple-US-storefront build that wants a "get
2Z" link opens the user's Free2Z billing page with `openBilling()`
([the billing URL contract](./INTEGRATION.md#get-2z--the-billing-url-contract)).
A store build must not request `purchase:create`, call `createPurchase` or
call `openBilling()`.

Google says plainly that this model is allowed:

> Google Play allows any app to be consumption-only, even if it is part of a
> paid service. For example, a user could log in when the app opens and access
> content paid for somewhere else.

**Apple is the gray zone.** 3.1.1: "If you want to unlock features or
functionality within your app, […] you must use in-app purchase." 3.1.3(b) lets an app use items bought elsewhere "provided
those items are also available as in-app purchases", which §2.2 makes
impossible for 2Z. The nearest rule is 3.1.3(f), for free companion apps,
"provided there is no purchasing inside the app, or calls to action for
purchase outside of the app". It is a **weak fit**: its examples are "VoIP,
Cloud Storage, Email Services, Web Hosting", not an app that spends AI
credits. Build to its standard anyway, and explain the model in your review
notes (§6). There is precedent:
[RouterChat](https://apps.apple.com/app/id6776368852) is on the App Store as a
client that signs in to OpenRouter and shows that account's credits. Precedent
is not a promise.

## 2. The line

The line separates **account management**, which is allowed everywhere, from
a **purchase funnel**, which is allowed only where noted. Choose the column
**when you build**, by where that build is distributed — never at runtime, and
never by device locale or IP address. A build available in **any** App Store
storefront other than the US uses the "outside the US" column, even if it is
also sold in the US. Only a build whose App Store availability is limited to
the US storefront alone uses the "US-storefront-only build" column.

| In the app or its listing | Apple, any build available outside the US | Apple, US-storefront-only build | Google Play |
|---|---|---|---|
| **Connect / Sign in with Free2Z** (system auth session) | ✅ | ✅ | ✅ |
| Balance shown neutrally ("1,240 2Z") | ✅ | ✅ | ✅ |
| Calm **No credits** state | ✅ | ✅ | ✅ |
| **Manage Free2Z account** → `https://free2z.cash/account/apps?client_id=<id>` in the **system browser** | ✅ once the store-safe view ships | ✅ | ✅ once the store-safe view ships |
| Plain text with no link: "Add 2Z at free2z.cash" | ❌ (3.1.3: may not "encourage") | ✅ | ✅ |
| Buy or top-up button, or link to purchase, in the **external browser** | ❌ | ✅, optional, behind a remote flag that defaults to off | ❌, unless enrolled in the US external content links program |
| **Get 2Z on Free2Z** → `openBilling()` (`https://free2z.cash/buy-2z?client_id=<id>`), and the plugin permissions `f2z:allow-open-billing` / `f2z:allow-billing-url` | ❌ | ✅, optional: the permissions may be granted in this build, and the link stays behind a remote flag that defaults to off | ❌ |
| Prices ("500 2Z for $5"), "buy 2Z", "top up" | ❌ | ✅ only beside that flagged link | ❌ |
| Any Free2Z page in an in-app WebView | ❌ | ❌ | ❌ |
| The same purchase wording in the name, description, screenshots or keywords | ❌ | ❌ (metadata is per language, not per storefront) | ❌ |

**The billing link is opt-in, per build.** From SDK 0.4.0, `billingUrl()` /
`openBilling()` open the user's Free2Z billing page, where they pay with
Zcash or by card. It is a link to purchase, so it follows the "link to
purchase" row above. A **Google Play build**, or an **iOS build available in
any storefront outside the US**, must not show billing links or grant
`f2z:allow-open-billing` (or `f2z:allow-billing-url`) in any Tauri
capability. A capability is fixed when the app is built, not per storefront,
so only a **US-storefront-only build** may grant the permissions — and even
then the link stays behind a remote flag that defaults to off (below).
Otherwise keep them out of the iOS build entirely. Web apps and directly downloaded
desktop apps are outside the stores and may use it freely.

**US storefront, Apple.** Guideline 3.1.1(a) says that link entitlements "are
not required for developers to include buttons, external links, or other calls
to action in their United States storefront apps". This comes from the
*Epic v. Apple* injunction. The Ninth Circuit (No. 25-2935, 2025-12-11) held
that Apple may charge a commission on linked-out purchases. The commission is
based on the costs "genuinely and reasonably necessary for its coordination of
external links", and the court added that Apple "is entitled to some
compensation for the use of its intellectual property". It sent the amount
back to the district court. Separately, the
Supreme Court granted review on 2026-06-30 (No. 25-1311), limited to the
contempt finding. Even in a US-storefront-only build, keep the link **behind a
remote flag that defaults to off**, so you can remove it without an app update
if Apple sets a fee.

**Google, any country.** You may write purchasing information without a link.
A link to purchase needs the
[external content links program](https://support.google.com/googleplay/android-developer/answer/16470497):
enrollment, Google's link APIs, US users only, and from 2026-10-01 a service
fee on purchases made within 24 hours of the link. Those purchases happen at
2Z Inc, not at the developer, so **do not enroll**. Use plain text.

**Free2Z's side of the line.** Google allows links to "an account management
page […] as long as the webpage does not eventually lead to an alternate
payment method". So the page that **Manage Free2Z account** opens
(`/account/apps?client_id=`) must show no purchase link, price or sales pitch
when it is opened with a `client_id`. It may show grants, this app's budget,
sign-out and deletion. The same rule covers every hosted Free2Z page that an
SDK app opens by default (sign-in, sign-up, consent, account, deletion). The
billing page (`/buy-2z`) is the one exception: it sells 2Z, so only a build
allowed to link to purchase opens it, with `openBilling()`. **Manage never
points at billing**, in any build:

- **Commerce-free, including the navigation and footer the page inherits.** A
  "Buy 2Z" item in a shared header or footer is a path to payment.
- **For apps used by children, no third-party analytics or embeds** on pages a
  child sees. Load only first-party scripts, with no trackers, no social
  widgets and no third-party media.
- **The sign-in page is adult-gated, not child-facing.** An app used by
  children opens Free2Z sign-in only after its one-time adult step, for the
  adult account holder, in the system browser. In v1 that page keeps Google
  reCAPTCHA, an anti-abuse check rather than analytics or ads. A first-party
  replacement for it is planned. The exception holds only when all of these
  are true:
  1. **The adult gate is real.** It asks a question or sets a task a young
     child cannot trivially pass, with no answer hint on screen. A tap or an
     "I'm a grown-up" button is not enough, and no gate of this kind is
     COPPA verifiable parental consent.
  2. **Every Free2Z browser exit is behind the gate**, not just the first
     sign-in: connect, switch account (`prompt=login`), **Manage**,
     **Delete**, and any re-authentication after expiry or for a step-up.
     Signed out, **Manage** and **Delete** lead to the sign-in page, so a
     deep link or a token-expiry path that skips the gate breaks the
     exception.
  3. **It is disclosed.** The app's App Store privacy label and Google Play
     Data safety form disclose Google reCAPTCHA on the sign-in page, as does
     the Free2Z Privacy Policy.
  4. **The app is not in Apple's Kids Category.** An app in the Kids
     Category needs the first-party replacement first.

  The exception covers **only** the sign-in and sign-up page (`/login`).
  Consent, **Manage** and `/account/delete` load no third-party script.

The rest of free2z.cash may sell 2Z normally.

**Status as of 2026-10-14** (see "Do not submit until" above):

- Built and on stage, reaching free2z.cash with the next production release:
  `/account/apps?client_id=` focuses on the one app with no purchase link. Every SDK-facing page (consent, the sign-in
  and sign-up before it, Manage, deletion) renders without the site
  navigation and footer, and shows no purchase toasts. The sign-up Terms link
  opens a plain rendering of the legal documents (`/docs/plain/legal/`)
  without the docs navigation.
- Gap: X-only accounts cannot sign in on these pages until X sign-in returns
  to the page it started from.
- Gap: the deletion page `/account/delete` has not shipped.
- By design in v1: the adult-gated sign-in page loads Google reCAPTCHA (see
  above).

### Copy

| ✅ Good | ❌ Bad |
|---|---|
| "No credits · Manage Free2Z account" | "Get more 2Z now!" |
| "Free2Z balance: 1,240 2Z" | "Only $4.99 for 500 2Z" |
| "This app's budget is used up · Manage Free2Z account" | "Top up to keep learning" |
| "Connect Free2Z" | "Buy 2Z to unlock AI" |
| (Apple US-storefront-only build, flag on) "Add 2Z on free2z.cash ↗" | "Upgrade" / "Go Premium" / "Unlock" |
| (web, direct-download desktop, Apple US-storefront-only build with the flag on) "Get 2Z on Free2Z ↗" (`openBilling()`) | "Manage Free2Z account" that opens billing |

Don't add urgency, a countdown, a discount or "keep going" pressure. Each of
those is a sales pitch in any store.

### Pre-submission checks

- [ ] The requested scopes are `openid offline_access balance:read ai:invoke`,
      plus `profile` if you show a username. They do **not** include
      `purchase:create`.
- [ ] Search the built UI strings and store metadata in every locale for
      *buy, purchase, top up, price, $, €, upgrade, premium, unlock*. Each hit
      is either removed or, on Apple, present only in a US-storefront-only
      build behind the default-off remote flag.
- [ ] No code path loads a free2z.cash URL into a WebView. Sign-in uses the
      SDK's platform auth session, and **Manage** uses the OS browser opener.
- [ ] The **Manage** URL is the fixed `/account/apps?client_id=<id>`. It is
      never built from an OAuth subject or from model output, and never
      points at the billing page (`/buy-2z`).
- [ ] **Google Play builds, and iOS builds available outside the US
      storefront:** no capability file grants `f2z:allow-open-billing` or
      `f2z:allow-billing-url`
      (`grep -rnE "allow-(open-)?billing" src-tauri/capabilities`
      prints nothing), and no code path calls `openBilling()` or
      `billingUrl()`. The app shows "Manage Free2Z account" only.
- [ ] With the app's real `client_id`, every Free2Z page the app opens
      (sign-in, consent, **Manage**, deletion) has no purchase path, including
      in its header and footer. For an app used by children, the browser's
      network log shows no third-party requests on any page a child sees.
      The only v1 exception is reCAPTCHA on the sign-in and sign-up page
      (`/login`), never on consent, **Manage** or `/account/delete`.
- [ ] If your app is used by children: the adult gate is a real one (no
      on-screen hint; not a tap or an "I'm a grown-up" button), and every
      Free2Z browser exit sits behind it (connect, switch account,
      **Manage**, **Delete**, expiry and step-up re-authentication).
- [ ] Your App Store privacy label and Google Play Data safety form
      disclose Google reCAPTCHA on the Free2Z sign-in page, and the app is
      not in Apple's Kids Category.

## 3. Age and audience

### Apple: Education, 4+, not the Kids Category

Pick **Education** (or whatever fits) and answer the age questionnaire
honestly. A structured AI tutor normally answers **None / No** to everything,
which gives **4+**:

| Questionnaire item | Answer for a typical SDK app | Why it matters |
|---|---|---|
| Parental controls | No, unless you build them | — |
| Age assurance | Yes, if you call the Declared Age Range API | Allowed at 4+ |
| Unrestricted web access | **No**. Never embed a browser | Makes the app **16+** |
| User-generated content, messaging and chat | No (users don't reach other users) | Allowed at 4+, but avoid it |
| Social media, advertising, gambling, contests | No | — |
| All content descriptors (violence, mature themes, medical …) | None | — |

The questionnaire has no AI question. Describe the AI in the review notes
instead.

**Why not the Kids Category.** Guideline 1.3 says that Kids Category apps "may
not send personally identifiable information or device information to third
parties". It also requires that links out and purchasing opportunities sit
behind a parental gate. Every AI call goes to a third party (Free2Z and its AI
provider), and **Connect** and **Manage** are links out. The choice is also
sticky: "once customers expect your app to follow the Kids Category
requirements, it will need to continue to meet these guidelines […] even if
you decide to deselect the category."

**The metadata trap.** Guideline 2.3.8 says: "Use of terms like 'For Kids'
and 'For Children' in app metadata is reserved in the App Store for the Kids
Category." Guideline 5.1.4 adds: "Apps not in the Kids Category cannot include
any terms in app name, subtitle, icon, screenshots or description that imply
the main audience for the app is children." Describe the **subject and the
skill** ("fractions, step by step"), not the audience. Don't use child mascots
in screenshot captions, and don't say "for your child". Also leave out
third-party analytics and ads. 5.1.4 bans them only for "apps intended
primarily for kids", but leaving them out is the safe course for an all-ages
app.

### Google: an honest target audience brings in Families

Declare the age groups the app is really designed for. If they include under
13, the **Families policy** applies. Google may review your declaration
against your imagery and wording, and "misrepresentation […] may result in
removal or suspension". Families requires:

- **Content** that is appropriate for children.
- **Identifiers:** an app that targets only children must not transmit the
  advertising ID, SIM or build serial, MAC, SSID, BSSID, IMEI or IMSI at all.
  A mixed-audience app must not transmit them "from children or users of
  unknown age". The SDK reads none of these, and your own code must not read
  them either.
- **APIs and SDKs approved for child-directed services.** Google names this
  exact case: "an API Service using OAuth technology […] whose terms of
  service states that it is not approved for use in child-directed services".
  A mixed-audience app may use such an API only "behind a neutral age screen"
  or without collecting data from children. Google's Families data-practices
  page adds that such apps "must not require users to sign-in or access app
  content through" it.
- **Legal compliance** with COPPA, GDPR and other applicable law, including
  through the APIs and SDKs you call.

**The SDK's child-directed posture.** As of 2026-10-14, Free2Z's terms say
it is "not available to persons under the age of 13", which is exactly the
clause Google flags. The posture being built is an **adult-held Free2Z account
that a child-directed app may use**, chosen by a `child_directed` flag on the
app's client registration. Use that registration for any app whose audience
includes children, and follow the SDK's
[child-directed integration notes](./CHILD-DIRECTED.md). Until the posture is live, an app whose content requires
Free2Z cannot declare a child audience on Google Play.

### Consent before any data reaches AI

Apple 5.1.2(i): "You must clearly disclose where personal data will be shared
with third parties, including with third-party AI, and obtain explicit
permission before doing so."

COPPA, 16 CFR 312.5(a)(2) (amended rule, compliance from 2026-04-22): a parent
must be able to consent to collection "without consenting to disclosure of
his or her personal information to third parties, unless such disclosure is
integral", and disclosure needs "separate verifiable parental consent".

What to build: before the first AI call, show one screen that names
**Free2Z** and the **AI provider**, and says exactly what is sent (for example
"the problem, your answer, the grade level") and what is not (name, email,
device IDs). The person agrees with an explicit tap. Store the consent on the
device, and let them withdraw it in Settings. In apps for children,
this screen is part of the adult step below.

**A tap is not COPPA verifiable parental consent.** Neither is a neutral age
screen. Neither is one of the 312.5(b) methods. So design child-facing AI
requests to carry **no personal information from the child**: preset choices
and the problem only, never a name or free text. If an app must send a child's
personal information to AI, it needs a 312.5(b) method. That is a question for
counsel, not for this playbook.

### The one-time adult step

In an app that children use, put **one** adult step before **Connect Free2Z**,
and never inside the learning loop. Make it a **neutral age screen** (Google's
term). That means asking for a birth year or an age band without hinting at
the right answer; an "I'm a grown-up ✓" button doesn't count. Google's
definition of adult action lists "an adult PIN, password, birthdate, email
verification, photo ID, credit card, or SSN". Where the OS provides an age
signal (Apple's Declared Age Range, Google's Play Age Signals), use it. The
adult then sees the consent screen above and connects their own Free2Z
account.

### Structured AI, not free chat

Request problems with preset parameters, ask for
[`response_format`](./INTEGRATION.md#structured-output-response_format)
output, validate it, then render and grade it locally. Offer preset question
choices instead of a free-text box. Google's AI-Generated Content policy names
"text-to-text conversational generative AI chatbots" as its core case. Free
text from a child is also where names and other personal information leak in.

### Report AI output

Google AI-Generated Content policy: apps "must contain in-app user reporting
or flagging features that allow users to report or flag offensive content to
developers without needing to exit the app."

Every AI-generated item needs a **Report** control. A tap hides the item at
once and sends a preset reason with the item's `call_id` through the SDK's
`reportCall(callId, reason, detail?)` (Rust `ai().report_call`); reasons are
`incorrect`, `inappropriate`, `unsafe` and `other`. You need no backend: Free2Z
receives the report, lets you read it via `GET /api/oauth/apps/{app_id}/reports/`, puts it in its
moderation queue, and alerts its staff on `unsafe`. It stores the reference and
reason, never the AI content. Offer no free-text box in an app children may
use. See [Reporting AI output](./INTEGRATION.md#reporting-ai-output). A
`mailto:` link leaves the app, so it does not count.

## 4. Account deletion

Google counts directing users to an outside sign-up as account creation: the
app "directs the user to an app account creation flow outside of the app".
Apple doesn't say either way, so treat it as account creation there too.
Apple: "If your app supports account creation, you must also offer account
deletion within the app" (5.1.1(v)).

- **In the app:** add **Delete Free2Z account** in Settings, next to Sign out.
  It opens `https://free2z.cash/account/delete` in the system browser
  (`client.openDeleteAccount()`, `sdk-v0.3.0`; see
  [account exits](./INTEGRATION.md#manage-and-delete-the-free2z-account)). Apple accepts "a link directly to the page on your website where
  they can complete the process". Apple also says apps outside regulated
  industries "should not require people to […] send an email". That is why
  Free2Z is replacing deletion by email with this self-service page.
- **Play Console:** enter the same URL in the Data safety form's deletion
  field. Google requires a page that loads without error, "reference[s] the
  app or developer name", and lets users delete without reinstalling the app.
  Check that the page meets the naming requirement before you rely on it.
- **Your local data:** when the account is deleted or the user signs out,
  delete everything stored under that `subject`. Withdrawing consent and
  revoking the app's grant (`/account/apps`) are different actions from
  deleting the account. Offer both.
- **Before you submit:** open the deletion URL in a logged-out browser and
  confirm that it loads and names your app. As of 2026-10-14 the page is
  still being built, so don't submit until it loads.

## 5. Login (Apple 4.8)

4.8 requires an equivalent privacy-preserving login option when a third-party
login sets up "the user's primary account with the app". An SDK app has no
account of its own, so the exception applies: "Your app is a client for a
specific third-party service and users are required to sign in to their mail,
social media, or other third-party account directly to access their content."
Free2Z also supports accounts with no email, so users can keep their email
private either way. **Sign in with Apple on Free2Z is planned.** It is not
needed for v1.

## 6. App Review notes template

```text
WHAT THIS APP IS
<App> is a <subject> app. Its exercises are generated by AI and paid for with
the user's existing Free2Z platform credits ("2Z").

FREE2Z IS A THIRD-PARTY SERVICE
Free2Z (free2z.cash, operated by 2Z Inc) is an independent account service.
We do not operate it. Users sign in with their own Free2Z account through
ASWebAuthenticationSession. The app is a client for that service
(Guideline 4.8 exception).

NO PURCHASES IN THE APP
The app sells nothing and contains no in-app purchase. 2Z works across many
independent apps, so it cannot be sold through in-app purchase (DPLA
Attachment 2 §2.2). 2Z Inc sells 2Z on its website. [Any build available
outside the US storefront:] The app shows no purchase buttons, links, prices
or calls to action. When the
balance is zero, it shows "No credits" and a "Manage Free2Z account" link to
an account page with no purchase path. [Only once the store-safe view ships;
see "Do not submit until".]
[US-storefront-only build only: an optional "Get 2Z on Free2Z" link, behind
a remote flag that defaults to off, opens the user's Free2Z billing page
(free2z.cash/buy-2z) in Safari (3.1.1(a)).]

DEVELOPER COMPENSATION
Usage is metered in 2Z usage credits, which cannot be cashed out.
[Only after authenticated acceptance, a verified legal-payee binding and
activation: We are compensated in USD by 2Z Inc. from its own funds, under
the Free2Z Creator Compensation Agreement (cc-2026-10-v2, schedule
sdk-application-2026-10-v2).]
We do not sell 2Z, set its price or handle payments.

AI AND PRIVACY
AI requests are structured (preset choices in, validated data out); there is
no free chat. Before the first request the app names Free2Z and <provider>,
states what is sent, and asks for explicit permission (5.1.2(i)). Every AI
item has a Report button. No ads, no third-party analytics, no tracking.
Account deletion: Settings > Delete Free2Z account (free2z.cash/account/delete).

DEMO ACCOUNT
Free2Z username: <demo>  Password: <password>   (holds <N> 2Z for review)
Steps: Connect Free2Z > sign in > <first exercise>.
```

## 7. Play declarations checklist

- [ ] **Data safety:** declare what the app sends to Free2Z (user ID, the
      AI request content, the balance read) as **collected and shared**.
      Google exempts some user-initiated transfers, but declaring is the safe
      reading for an all-ages app. Mark encryption in transit **Yes**, and
      account deletion **Yes** with the URL from §4.
- [ ] **Target audience and content:** honest age groups (§3). If they
      include under 13, also confirm the Families requirements and the
      `child_directed` registration.
- [ ] **Content rating (IARC):** answer honestly. There is no user-to-user
      interaction, and if you are asked about digital purchases, the answer is
      no, because the app sells nothing.
- [ ] **Ads:** No. **Advertising ID:** not used. Don't request `AD_ID`.
- [ ] **AI-generated content:** the in-app Report control exists and
      delivers reports (§3).
- [ ] **Store listing:** no purchase wording, no "for kids" wording that
      misstates the audience.
- [ ] **App access:** give the same demo account as in §6.

## 8. US state age laws

**Texas SB 2420** (App Store Accountability Act) has been **in effect since
2026-06-04**. A federal injunction stopped it on 2025-12-23, and the Fifth
Circuit stayed that injunction (*CCIA v. Paxton*, 5th Cir. No. 25-50001). On
2026-07-06 the Supreme Court denied the application to vacate that stay
(No. 25A1390). For new Texas
accounts, the stores verify age and get parental consent for minors'
downloads. Developers take on three duties:

- **Get the age category** when you need it. On Apple, use the
  Declared Age Range API (under 13, 13–15, 16–17, 18+). On Google, use the
  Play Age Signals API, which returns Texas signals for accounts created after
  2026-05-28. Use the signal only "to provide age-appropriate content and
  experiences" (Google), and never for analytics.
- **Significant changes:** you decide what counts as one. A change of **age
  rating** always does. When one ships, request consent again through
  PermissionKit's Significant Change API (Apple).
- **Revocation:** a parent can withdraw consent, and the OS then blocks the
  app from launching. Apple's notice of this is a server notification, which
  an app with no backend cannot receive. Such an app relies on the OS block.

When you must act: **before you ship a change that raises your age rating**,
or any other change you judge significant (for example, a new AI
capability). Utah and Louisiana have similar laws, and their
dates have already moved. Check their current status before each submission.

## Sources

All accessed **2026-10-14**.

- Apple App Review Guidelines (last updated 2026-06-08): 1.3, 2.3.8, 3.1.1, 3.1.1(a), 3.1.3(b)/(f), 4.8, 5.1.1(v), 5.1.2(i), 5.1.4 — <https://developer.apple.com/app-store/review/guidelines/>
- Apple Developer Program License Agreement (last updated 2026-10-13), Attachment 2 §§1.1, 2.1, 2.2 — <https://developer.apple.com/support/terms/apple-developer-program-license-agreement/>
- Apple, Offering account deletion in your app — <https://developer.apple.com/support/offering-account-deletion-in-your-app/>
- Apple, Age ratings values and definitions — <https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/>
- Apple, Next steps for apps distributed in Texas (2025-11-04) — <https://developer.apple.com/news/?id=2ezb6jhj>; Update for apps distributed in Texas (2026-06-03) — <https://developer.apple.com/news/?id=sg176nne>
- Google Play, Payments policy — <https://support.google.com/googleplay/android-developer/answer/9858738>; Understanding the Payments policy (consumption-only, account pages) — <https://support.google.com/googleplay/android-developer/answer/10281818>
- Google Play, External content links program (US) — <https://support.google.com/googleplay/android-developer/answer/16470497>
- Google Play, Families policies — <https://support.google.com/googleplay/android-developer/answer/9893335>
- Google Play, AI-Generated Content — <https://support.google.com/googleplay/android-developer/answer/13985936>
- Google Play, Account deletion requirements — <https://support.google.com/googleplay/android-developer/answer/13327111>; Data safety section — <https://support.google.com/googleplay/android-developer/answer/10787469>
- Android, Play Age Signals overview (updated 2026-07-20) — <https://developer.android.com/google/play/age-signals/overview>
- Google Play, Data practices in Families apps — <https://support.google.com/googleplay/android-developer/answer/11043825>
- *CCIA v. Paxton*, 5th Cir. No. 25-50001; Supreme Court application 25A1390 (denied 2026-07-06) — <https://www.supremecourt.gov/docket/docketfiles/html/public/25A1390.html>
- COPPA, 16 CFR 312.5 — <https://www.ecfr.gov/current/title-16/part-312/section-312.5>
- *Epic Games v. Apple*, 9th Cir. No. 25-2935 (2025-12-11) — <https://law.justia.com/cases/federal/appellate-courts/ca9/25-2935/25-2935-2025-12-11.html>; Supreme Court No. 25-1311 (cert. granted 2026-06-30) — <https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/25-1311.html>
