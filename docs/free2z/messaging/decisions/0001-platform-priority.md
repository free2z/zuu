# ADR 0001 — Platform priority: ZUULI-first, web is an explicitly lesser client

**Status:** Accepted (owner, 2026-08-08) · **Refs:** [#305](https://github.com/free2z/zuu/issues/305) §3.5, §7.1

## Context

A web app's E2EE is only as good as the JavaScript the server just sent you. A
compromised or coerced free2z server can serve modified code to **one targeted
user**, exfiltrate their keys, and leave no trace on the client. This is a
well-documented, fundamental limitation of browser-delivered E2EE — the user
fetches the program that performs the encryption from the party the encryption is
meant to protect against, on every page load. Subresource integrity and CSP do
not help, because the attacker controls the document that declares them.

ZUULI is a signed native binary with a Rust crypto core: fetched once, from a
signed update channel, verifiable out of band.

## Decision

**Full guarantees live in ZUULI.** The web client speaks the same protocol, but
its trust model is weaker and this is stated **in the interface**, not merely in
documentation.

The crypto core is **Rust, built once**: used natively by ZUULI and compiled to
WASM for the web client. There is no second implementation.

## Consequences

- One codebase for all cryptography eliminates the implementation-divergence
  class of bug outright. This also settles the MLS library choice toward a Rust
  engine (OpenMLS) over a TypeScript one (ts-mls).
- The web UI **must** carry a visible statement of its weaker guarantee. Marketing
  or UI copy describing the web client's guarantee as equivalent to ZUULI's is
  false and is a defect.
- High-value operations that create spending authority — FROST/DKG ceremonies —
  are **ZUULI-only**. They are not offered in the browser.
- WASM cannot guarantee memory zeroization (the JS engine's GC may copy buffers;
  we do not control the heap), which independently disqualifies the browser for
  ceremony key handling.
- Web code transparency is a **research track, never a release blocker**. See
  [WAIT](https://arxiv.org/pdf/2104.06136) and
  [Trustworthy JavaScript for the Open Web](https://hacks.mozilla.org/2026/05/trustworthy-javascript-for-the-open-web/).
  At best it converts the attack from undetectable to detectable-after-the-fact,
  which is a real improvement and still not a fix.

## Alternatives rejected

- **Web-first parity.** Rejected: it would require either claiming a guarantee we
  cannot deliver, or holding ZUULI back to the browser's trust model. Both are
  worse than being honest about the difference.
- **Ship only ZUULI.** Rejected: free2z is a web platform and the reach matters.
  A weaker-but-stated guarantee reaching many people is worth more than a
  stronger guarantee reaching none, provided the statement is truthful and
  prominent.
- **Block release on web code transparency.** Rejected: the technology is not
  deployable today and making it a blocker means shipping nothing.
- **Two independent implementations (Rust + TypeScript).** Rejected: divergence
  between two crypto implementations is a reliable source of exploitable bugs,
  and it doubles the audit surface.
