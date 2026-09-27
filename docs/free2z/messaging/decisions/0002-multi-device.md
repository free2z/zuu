# ADR 0002 — Multi-device: design for it, ship single-device

**Status:** Accepted (owner, 2026-08-08) · **Refs:** [#305](https://github.com/free2z/zuu/issues/305) §3.1, §7.2

## Context

Delete-on-acknowledged-delivery and multi-device pull directly against each
other. If the relay destroys ciphertext when device 1 acknowledges it, device 2
never receives it. Every serious messenger resolves this by fanning out to
**per-device queues**, so "delivered" means "delivered to every registered device
of the recipient."

Retrofitting that later is expensive: it changes the definition of delivered, the
queue model, and the key hierarchy simultaneously — the three things that are
hardest to change once a federation is running.

## Decision

**The protocol, queue model and key hierarchy assume per-device fan-out from day
one. The first release exposes a single device in the UI.**

## Consequences

- **"Delivered" is defined once, correctly, from the start.** Four separate
  states — `accepted`, `queue-delivered`, `device-delivered`, `delivered` — where
  `delivered` means a receipt from *every* device in the recipient's device set as
  of the epoch the message was sent. See
  [`../ARCHITECTURE.md` §6.3](../ARCHITECTURE.md#63-what-delivered-means).
- **The relay implements only `queue-delivered`**, per-queue and unconditionally:
  ACK arrives → delete. It holds no cross-queue state, because cross-queue state
  would mean knowing the device set, which would mean knowing the recipient.
- **Identity keys and device keys are separate levels of the hierarchy from the
  first commit.** Identity keys are seed-derived and restorable; device keys are
  generated on-device, never leave it, and are *not* seed-derivable. A
  `DeviceCredential` signed by the identity key binds the two and is carried as
  the MLS `Credential`, so every peer validates the binding during ordinary MLS
  processing.
- **A device MUST NOT acknowledge to the relay before its durable local write
  completes.** ACK-on-read plus a crash equals permanent message loss, because the
  relay has already deleted the only copy. This is the single most safety-critical
  rule in the delivery layer.
- Fan-out multiplies relay storage and egress by the device count. At our sizing
  this is negligible; the assumption is baked into the cost model.
- **Device registration and revocation are designed now and shipped later — and
  when they ship they are security-critical.** A rogue device added to an account
  is a wiretap. Every registration must be surfaced to every other device of the
  account and published to the key-transparency log, so it cannot happen silently.
- History transfer to a *newly added* device is an unresolved question
  ([`../ARCHITECTURE.md` §13-D](../ARCHITECTURE.md#13-open-questions)): MLS forward
  secrecy means a new device cannot decrypt past epochs by design.

## Alternatives rejected

- **Ship multi-device in v1.** Rejected: device registration is a wiretap-shaped
  feature and deserves its own design and review cycle, not a rushed one.
- **Accept single-device permanently.** Rejected: users have more than one device,
  and retrofitting fan-out into a live federation is far harder than designing
  for it.
- **Server-side "delivered to all devices" tracking.** Rejected: it would require
  the relay to know the device set, i.e. to know the recipient, which destroys the
  metadata property that the whole queue design exists to provide.
