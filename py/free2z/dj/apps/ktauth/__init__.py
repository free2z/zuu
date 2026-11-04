"""The handle-ownership authority: free2z's whole Django surface for E2EE.

This app is one POST endpoint. It exists because the key-transparency log
cannot answer the first question a user actually asks.

The trust model, stated plainly
-------------------------------

``docs/free2z/messaging/KT.md`` in the public ``free2z/zuu`` repository specifies an
append-only, privacy-preserving directory built on ``akd``. Everything in it is
cryptographic: the tree proves it is append-only, ``KT.md`` §4.4 proves an entry
was authorized by the key that held the handle before it, and the witnesses
prove the log did not equivocate. **None of that says who owns a handle.** A
key-transparency log will faithfully, verifiably and permanently publish a key
for ``@alice`` on behalf of *whoever submitted first* — see
https://github.com/free2z/zuu/issues/594, which is the spec gap this app is a
proposed answer to.

Something non-cryptographic has to say "``@alice`` is this account", and no
amount of cryptography derives it. **That something is this app.** It is the
platform asserting, under its own Ed25519 key, that the free2z account it just
authenticated owns the handle it is named by. Concretely:

* Django authenticates the caller with the project's ordinary session/Knox
  authentication. That authentication *is* the evidence. There is no other.
* The handle is the one ``dj.apps.handles`` has bound to ``request.user`` and
  nothing else — never a body field, never a query parameter. A request cannot
  ask for a handle; it can only ask for the one the caller already owns. That
  binding is stored and unique in the database (free2z/zuu#1022); it used to
  be ``lowercase(username)`` computed per request, which two case-variant
  accounts could share.
* Django signs a short-lived ``HandleAssertion`` (``signing.py``) and hands it
  back. The log verifies that signature against a configured authority public
  key and applies its own rules, including a cap on the validity window that
  this issuer cannot raise.

The one piece of state this app owns
------------------------------------

``account_epoch`` — the durable per-account ownership counter (``epoch.py``,
issue ). It is the only thing here that is not derivable from the request:
it is a **count of how many times this account has changed hands or been
recovered**, and the log uses it to make one ``reset`` assertion spendable on
one ownership event rather than on all of them forever.

It is a column on ``g12f.Creator`` rather than a model here, deliberately. This
app keeps its "no models, no migrations" property, and more importantly the
counter belongs to the *account*, not to key transparency: the events that move
it are password resets, credential links and admin edits, none of which this app
owns or should own. ``epoch.py``'s docstring enumerates those events and the
reasoning for each, and that enumeration **is** the security property — an event
that should invalidate outstanding assertions but does not increment leaves the
replay window open, silently.

What that buys, and what it does not
------------------------------------

**It does not make free2z trusted.** The assertion is a *bearer* document — a
blob anyone who intercepts it holds in full. It is useless on its own: ``KT.md``
requires the submission carrying it to *also* be signed by the identity private
key the assertion is about, so a thief holding a copy cannot use it without
already holding the key it was trying to replace. That pairing is structural in
the Rust verifier (``rs/crates/f2z-authority`` on ``free2z/zuu``): there is no
code path there that checks an authority signature without also checking the
binding.

**It does make free2z a trust root for handle *naming*.** A compromised issuing
key can vouch that ``@alice`` belongs to an attacker's identity key. What bounds
that is the rest of the system, not this app: the log publishes it, the log's
publication is append-only and cosigned, and Alice's own client raises a
non-dismissible alarm on a key change she did not initiate (``ARCHITECTURE.md``
§9.2). The authority makes impersonation *attributable and detectable*, not
impossible. This is the honest position and it is the reason the issuing key is
kept in GCP Secret Manager, fetched once at boot, and held only in memory.

**A self-hoster is not obliged to trust us.** ``AuthoritySet`` in the Rust crate
is set membership, and a log may configure its own authority — or none at all,
in which case it must *report* that its handles are unvouched.

**A platform credential is what authorizes a reset here, and that is a decision
nobody has made yet.** ``intent="reset"`` is ADR 0014's platform-reset path: the
account behind the handle changed hands or lost its keys, and a new identity key
takes over. This endpoint gates it on ``IsAuthenticated`` and nothing more — no
step-up factor, no recent-authentication window, no proof from the outgoing
identity key. So a *stolen Knox token* is enough to ask for one. Three things
bound that, and none of them is this endpoint:

* An assertion is not an entry. ``KT.md`` §4.4 requires a ``platform_reset``
  entry to also carry a ``ResetAuthorization`` signed by the **pinned, offline
  reset authority key**, and the log MUST NOT publish it before
  ``effective_at_ms`` — a multi-day cooldown during which clients keep using the
  old key.
* ADR 0014 makes the reset **loud**: a non-dismissible peer alarm, permanently
  counted. It is a real weakening announced rather than hidden, and that is the
  whole mitigation.
* Somebody holding a session for the account can already read the platform side
  of it, change its password and change its email. "The account changed hands"
  is what a reset *means*.

It is still worth naming, because the honest answer is that **what authorizes a
reset is exactly what zuu#594 has to specify** — its acceptance list includes
every validity rule for an assertion — and requiring a TOTP factor or a recent
re-authentication here would be guessing that answer ahead of the issue rather
than implementing it. Decide it there; add the gate here when it says what the
gate is. Nothing is exposed meanwhile: no manifest enables this endpoint.

Scoped failure, on purpose
--------------------------

If the issuing key cannot be fetched, this endpoint answers ``503`` with a
bounded reason code and **nothing else on the platform changes**. Boot does not
fail, the app registry loads, every other endpoint is unaffected. Fail closed
and scoped; never fail closed and global.

The deployment requirement, which the code cannot enforce
---------------------------------------------------------

``KtauthConfig.ready`` fetches the issuing key, and ``ready()`` runs in **every**
Django process — gunicorn, Daphne, the Procrastinate workers, cron jobs,
``manage.py migrate``. Today every one of those runs under the same Kubernetes
service account, so if the secret name and the IAM binding were applied
deployment-wide, a compromise of any of those workloads would yield the seed and
with it offline forgery of an assertion for **any** handle until the key is
rotated. Nothing in this repository can check that; it is a manifest and IAM
property.

Two things follow, and both are conditions of turning this on:

* ``KT_AUTHORITY_SECRET_NAME`` belongs on the **API server workload only**, and
  the ``secretmanager.secretAccessor`` binding belongs on a service account only
  that workload uses. The module gates on the setting being present, so a
  process without the variable never holds the key and never calls out.
* **No manifest sets it today.** This branch ships the endpoint inert: it
  answers 503 everywhere, on purpose, because ``HandleAssertion`` is an
  unratified proposal (below) and must not be live before zuu#594 lands. Whoever
  writes the manifest that enables it inherits the paragraph above.

Status
------

``HandleAssertion`` is a **proposal**, not ratified spec: it does not appear in
the merged ``KT.md``. https://github.com/free2z/zuu/issues/594 must land before
anything depends on these bytes. The wire format implemented here tracks the
``feature/kt-authority`` branch of ``free2z/zuu`` and is verified against that
crate byte-for-byte (``tests/test_conformance_vectors.py``).
"""
