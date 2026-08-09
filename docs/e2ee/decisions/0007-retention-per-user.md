# ADR 0007 — History: per-user local retention, with a non-binding ephemeral hint

**Status:** Accepted (owner, 2026-08-08) · **Supersedes:**
[ADR 0003](./0003-history-retention.md) ·
**Refs:** [#305](https://github.com/free2z/zuu/issues/305) §7.3,
[#342](https://github.com/free2z/zuu/issues/342)

## Context

[ADR 0003](./0003-history-retention.md) made retention a **negotiated, shared
property of the conversation**: a `GroupContext` extension (RFC 9420 §12.4)
listed in `required_capabilities`, changed by a two-phase
`RetentionChangeProposal` / `RetentionChangeAck` unanimity protocol.

Owner review of the merged Phase 0 docs rejected it, and the objection is
correct:

> "How could his setting force my device to delete? Isn't that sort of 'trusting
> the client'? Couldn't I just exfiltrate and backup the messages anyway? In
> general we want to reject theatrical measures that are easy to get around."

Yes. Once a recipient legitimately holds plaintext, nothing in the protocol
constrains what their device does with it. The `required_capabilities` check does
not help, because a modified client advertises whatever capabilities it likes and
joins anyway — the check filters clients that are *honest about not supporting*
the extension, which is the population that was never the threat. We were
spending real complexity, real group state and a join-time exclusion rule to buy a
property that a recompiled binary defeats.

## Decision

**Retention is a per-user local choice.** Each participant decides how long their
own device keeps its own copy. One keeps five minutes; another keeps forever. Both
are legitimate and neither constrains the other.

**A conversation may carry a non-binding ephemeral hint** — a requested mode and
TTL, sent as an MLS application message so it is confidential, **authenticated and
attributable**. Nobody can forge "Azhr asked for this to be ephemeral," and every
member sees who asked and when. Conforming clients honor it by default.

**The hint is a courtesy signal, not a security control**, and it MUST NOT appear
in any security claims table.

## Consequences

- **Removed:** the `GroupContext` retention extension, its listing in
  `required_capabilities`, the `RetentionChangeProposal` / `RetentionChangeAck`
  round trip, and the two-phase unanimity protocol.
- **The server still holds nothing after acknowledged delivery, in every mode.**
  This is unchanged, it is the one retention property that is a security claim,
  and it is not adjustable per conversation. It remains auditable rather than
  verifiable
  ([`../THREAT-MODEL.md` §4.5](../THREAT-MODEL.md#45-server-side-deletion-is-auditable-not-verifiable)).
- **`PurgeRequest{before_epoch}` survives unchanged**, because it was already
  labeled correctly: a request, not a guarantee. Conforming clients delete local
  history before that epoch and reply `PurgeAck`; the UI must say "asked N
  participants to delete; M confirmed," never "deleted." Nothing about it was
  theater, because it never claimed to compel anyone.
- **Nothing is retroactive**, in either direction, for the same reasons ADR 0003
  gave: retroactive deletion is unenforceable across other people's devices, and
  retroactive retention is impossible because the data is gone.
- **Ceremony transcripts are retained by default because the participant wants
  the evidence**, not because the protocol compels it. A DKG transcript is what
  lets them later prove the ceremony ran correctly and who said what; discarding
  it discards their own proof. This needs no exemption machinery — a default and
  a clear explanation before the ceremony begins, so consent is informed.
- **A short local TTL shortens the plaintext outbox window** used to repair
  detected gaps
  ([`../ARCHITECTURE.md` §7](../ARCHITECTURE.md#7-application-framing--hash-linked-causal-ordering)),
  so some gaps become unrecoverable. Surfaced explicitly rather than left as a
  silent hole. The trade-off is now made by, and lands on, the user who chose the
  short TTL.
- **Knock-on, stated plainly: dropping `required_capabilities` removes the
  join-time exclusion of non-conforming clients, and nothing replaces it.** Any
  client that speaks MLS and our application framing can join a conversation, and
  whether it honors hints is unobservable from outside. We accept this because the
  exclusion never worked against the client we actually cared about, but it is a
  real reduction in what a group can assert about its own membership and it should
  be read as one.
- **The hint is still worth shipping.** It defends against casual persistence,
  against a message lingering on a screen, and against device seizure after the
  TTL — the same value Signal and WhatsApp disappearing messages provide. The rule
  is: the feature ships, and it never appears in the security claims table
  ([`../THREAT-MODEL.md` §4.3](../THREAT-MODEL.md#43-ephemeral-hints-are-a-courtesy-signal-not-a-control)).
- Open question §13-J ("retention unanimity") is closed by removal of its premise.

## Alternatives rejected

- **Keeping ADR 0003's negotiated model.** Rejected as client-trust theater, per
  the reasoning above. The property it appeared to deliver cannot be delivered.
- **Keeping the `GroupContext` extension as a signal but dropping the unanimity
  negotiation.** Rejected: it costs group state and a wire-format extension to
  carry information that an authenticated application message carries equally
  well, and its presence in `GroupContext` would keep implying enforcement.
- **No client history at all.** Rejected, as in ADR 0003: it produces a product
  most people will not use, and it does not stop a determined counterparty from
  keeping a copy.
- **Always keep history, with no ephemeral option.** Rejected: it forecloses a
  legitimate use case, and the courtesy value of hints is real even though the
  security value is nil.
- **Detecting non-conforming clients.** Rejected as impossible, not merely
  expensive. There is no observable difference between a client that deleted its
  copy and one that did not.
