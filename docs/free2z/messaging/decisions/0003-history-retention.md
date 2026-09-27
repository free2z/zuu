# ADR 0003 — History: per-conversation retention, negotiated inside the group

**Status:** **SUPERSEDED** by
[ADR 0007 — per-user local retention, with a non-binding ephemeral hint](./0007-retention-per-user.md)
(owner, 2026-08-08) · **Refs:** [#305](https://github.com/free2z/zuu/issues/305) §7.3,
[#342](https://github.com/free2z/zuu/issues/342)

> **Do not implement this ADR.** The negotiated model below — a `GroupContext`
> retention extension listed in `required_capabilities`, changed by a two-phase
> unanimity protocol — was withdrawn on owner review because it does not deliver
> the property it appears to deliver: a modified client advertises whatever
> capabilities it likes, joins, and retains everything. It is preserved as
> written — save for one cross-reference repointed at the section that replaced
> its target — as the record of a decision that was taken and then reversed.
> **The current design is [ADR 0007](./0007-retention-per-user.md)** and
> [`../ARCHITECTURE.md` §8](../ARCHITECTURE.md#8-retention-d3).

## Context

"Delete on delivery" is a server property. Whether the *client* keeps a local,
locally-encrypted copy is a separate and much more product-shaped question, and
the three plausible answers (never keep, always keep, let users choose) make
materially different products. Per-conversation choice is the most demanding of
the three and therefore needs the most careful specification.

## Decision

**Users choose retention per conversation or room.** This governs **client-side**
retention only — the server holds nothing after acknowledged delivery in every
case, and that is not adjustable.

Retention is a **negotiated, shared property of the conversation**, authenticated
inside the MLS group, not a local preference.

## Consequences

- Retention lives in a `GroupContext` extension (RFC 9420 §12.4), so every member
  validates it on every Commit and **the server cannot tamper with it, observe it,
  or suppress a change to it undetectably.** It is listed in
  `required_capabilities`, so a client that would silently ignore an ephemeral
  setting cannot join at all.
- **Changes apply forward only**, from the epoch in which the Commit lands.
  Retroactive deletion is unenforceable (members may be offline, may have
  exported, may have screenshotted) and retroactive retention is impossible (the
  data is gone). A separate, explicitly labeled `PurgeRequest{before_epoch}` asks
  members to delete older history; the UI must say "asked N, M confirmed," never
  "deleted." See
  [`../ARCHITECTURE.md` §8.3](../ARCHITECTURE.md#83-purge-requests-and-why-nothing-here-is-retroactive).
- **"Agreed" means "no silent change," not "no unilateral change."** A two-phase
  propose/ack negotiation precedes the Commit, but MLS cannot *enforce* unanimity —
  any member may commit a `GroupContextExtensions` proposal. What the protocol
  guarantees is that such a change is authenticated, attributable and visible. The
  UI must present an out-of-band change as a prominent, attributed security event.
- **Ephemeral mode is best-effort and the UI must not overclaim.** A recipient can
  screenshot, photograph the screen, or run a modified client. Copy implying
  otherwise is a defect.
- Ephemeral mode shortens the plaintext outbox window used to repair detected gaps
  ([`../ARCHITECTURE.md` §7](../ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)),
  so some gaps become unrecoverable. That is surfaced explicitly rather than left
  as a silent hole.
- **FROST ceremony transcripts are exempt and always retained.** A DKG transcript
  is evidence: it is what lets a participant later prove the ceremony ran
  correctly and who said what. Messages carry `retention_class = CEREMONY`, clients
  MUST NOT delete them under any retention setting, and the UI MUST state this
  before the ceremony begins so consent is informed.

## Alternatives rejected

- **No client history at all.** Rejected: it produces a product most people will
  not use, and it does not actually stop a determined counterparty from keeping a
  copy.
- **Always keep history.** Rejected: it forecloses the ephemeral use case, which
  is one of the reasons people reach for a private messenger.
- **Retention as a local per-user preference.** Rejected: a "disappearing"
  conversation where the other side silently keeps everything is a
  misrepresentation. Making it shared group state means the setting is at least
  honest about what both sides are doing.
