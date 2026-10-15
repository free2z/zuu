# Child-directed and all-ages apps

An app whose users may include children can use the Free2Z SDK. This page says
what Free2Z does for such an app and what the app must still do itself.

> **Status (2026-10-14).** The gateway side below is implemented. The
> registration setting, its consent-screen line and the access-token claim are
> **pending** on the Free2Z identity provider, and until they ship every token
> reads as not child-directed. Free2Z's published terms still say the service
> is not available to anyone under 13; an amendment for adult-held accounts
> used by child-directed apps is under review. Until both are live, do not
> declare a child audience on the strength of this page (see
> [STORE-COMPLIANCE.md](./STORE-COMPLIANCE.md)).

## The account model

- **The account holder is an adult.** The person who taps "Connect Free2Z" and
  approves the consent screen is the Free2Z account holder: a parent, a teacher
  or another adult. The people who then use the app may be children.
- **Free2Z does not create accounts for children.** The SDK never asks for a
  child's name, age, email or any other detail, and Free2Z does not knowingly
  collect personal information from children.
- **Burner and no-email accounts work.** The SDK never requires or assumes an
  email address.

## Register the app as child-directed

**Pending** (see Status above): set `child_directed` on the registration in
the developer console, or `PATCH https://free2z.cash/api/oauth/apps/{app_id}/`
with `{"child_directed": true}`. Set it when the app is directed to children or
to all ages, children included.

The gateway enforces the claim only once the identity provider issues it.
After the setting is saved, new tokens carry it within five minutes (the
access-token lifetime); a token issued before keeps its old value until it
expires.

What changes when it is set:

- **Consent screen** (pending). One line tells the account holder that
  children may use the app and that they are connecting their own account as
  the adult account holder. It is not a parental-consent mechanism; see
  "What your app must still do".
- **Access tokens** (pending) carry `"child_directed": true`
  ([`spec/oidc.md`](./spec/oidc.md) §6.1).
- **The AI gateway**, for a token that carries the claim:
  - sends the call only to a provider it sends `store: false` to — today
    OpenAI. Any other model, or fallback, is refused (`403 model_disabled`,
    `reason: "child_directed"`), as is a model id the catalogue does not hold
    (`404 model_not_found`), before anything is recorded;
  - refuses `metadata` on `/v1/chat` and `/v1/chat/estimate`
    (`400 invalid_request`, `field: "metadata"`, `reason: "child_directed"`;
    [`spec/chat-api.md`](./spec/chat-api.md) §2.1) and does not record the
    `response_format` schema name;
  - stores the request fingerprint and the `Idempotency-Key` only as keyed
    HMACs under a server secret, so neither a guessable prompt nor the key
    text can be read back from the record. A same-key retry that spans the
    setting changing, in either direction, replays the original call rather
    than charging again.

  A child-directed app's call records then hold numbers only.
- **Debug capture** of prompts and completions is never available to a
  child-directed app. (It is not implemented for any app today.)

## What Free2Z keeps, and what it sends on

| Data | Kept by Free2Z? |
|---|---|
| Prompts, images, tool definitions and completions | **No.** They pass through the gateway to the model provider and are not written to the call record, the ledger or any log |
| Call record: model, provider, token counts, charge, finish reason, error code, times, catalogue version | Yes, as a ledger record; the app can read it for 90 days ([`spec/chat-api.md`](./spec/chat-api.md) §7). This is what metering and receipts need |
| Content-free request features (whether structured output or tools were used, their counts and sizes) | Yes, with the call record when enabled. Never a schema body or a prompt; for a child-directed app, not the schema name either |
| Caller `metadata` | Refused for a child-directed app; otherwise stored with the call record |
| Request fingerprint and `Idempotency-Key` (for same-key retries; keys expire after 24 hours) | For a child-directed app, only as keyed HMACs. For other apps, an unkeyed SHA-256 of the request and the key as sent |
| Gateway logs | Route, status, timing, counts and sizes only. Never a prompt, a completion, a header value or a peer address (`rs/crates/f2z-ai/tests/redaction.rs`) |
| Device identifiers, advertising IDs | **Never collected.** The SDK identifies itself only as `f2z-sdk/<version>`, and sign-in runs in the system browser |

What the model provider receives: the messages, images, tools and output
format of the call, and nothing that identifies the user — no Free2Z account
id, no app id, no `metadata`. For OpenAI, the gateway sets `store: false` on
every call (Responses and Chat Completions), for every app; the caller cannot
change it. `store: false` keeps the response out of OpenAI's stored
completions. It is **not** zero retention.

Model providers act as Free2Z's service providers. Their API terms say API
inputs and outputs are not used to train models by default, and allow them to
keep that data for abuse and safety monitoring: up to 30 days, unless the law
requires them to keep it longer. Some keep flagged content longer — Anthropic
up to two years — which is one reason child-directed calls go to OpenAI only.
**Zero Data Retention with OpenAI is not yet in place** for Free2Z; this page
will say so when it is. OpenAI's guidance is not to send personal information
of users under 13 without it, so for a child-directed app that is a hard rule
(below), not a preference.

## What Free2Z does, and does not do

- **Does:** keeps no prompt or completion; refuses the call shapes above;
  sends nothing that identifies the user to the provider; reviews reports of
  AI output that reach it (an in-app report endpoint for SDK apps is pending);
  relies on each provider's own safety systems and abuse monitoring.
- **Does not:** run its own content filter or moderation pass over SDK calls
  or their output today, or read your prompts. Filtering what a child sees is
  your app's job.

## What your app must still do

The platform cannot do these for you. App-store and privacy rules apply to
your app, not only to Free2Z.

1. **An adult step before "Connect Free2Z".** A short, one-time step that an
   adult completes — never in the learning loop.
2. **Never send a child's personal information.** This is a hard rule. No
   name, age, school, location, contact details, photo, voice or free text a
   child typed may reach a prompt, an idempotency key or a URL. Use structured
   requests (a topic, a level, a choice of preset questions) and no free-form
   chat.
3. **Disclose the AI, and ask first.** Say in the app and in its privacy
   policy that requests go to a third-party AI service through Free2Z, and get
   the adult's permission before the first call. If any child's personal
   information could reach the service, you need verifiable parental consent
   under COPPA first.
4. **A report button for AI content.** Let the user flag a generated answer
   from inside the app, without leaving it, and act on the reports.
5. **No ads and no third-party analytics.** Do not collect or send hardware
   identifiers or advertising IDs, and do not add SDKs that do.
6. **No purchase funnel.** Do not sell 2Z or link to a purchase. When credits
   run out, show a calm state and a neutral "Manage Free2Z account" link that
   opens the system browser. Never open Free2Z pages in a WebView.
7. **Account deletion.** Link to how the account holder deletes their Free2Z
   account.
8. **Age-appropriate output.** Set system instructions for the age you serve,
   validate structured output before you show it, and filter anything shown
   to a child — Free2Z does not filter it for you.
