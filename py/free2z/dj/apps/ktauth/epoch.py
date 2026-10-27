"""The durable per-account ownership counter, and the events that move it.

``account_epoch`` (``KT.md`` §4.5.4) is the authority's counter for the
**account** behind a handle. The key-transparency log retains the value from the
last assertion it admitted for that handle and requires the next one to be
strictly greater (rule **A15**), so one ``reset`` assertion can be spent on one
account-ownership event and not twice.

Why this module exists at all
-----------------------------

Until  the value was ``int(time.time())``. A monotonic clock satisfies
"strictly greater than the last one" **unconditionally and forever**, so A15 ran
on every submission, always passed, and enforced nothing. That is worse than
having no rule: a control that is visibly present and functionally absent stops
anyone from looking. The log now also applies **A18** — a ``2^20`` ceiling and a
``previous + 16`` step bound (free2z/zuu#651) — which refuses a Unix-seconds
value on its face, so the clock-derived issuer does not merely under-enforce, it
mints assertions no conforming log will take.

What the log can check, and what it cannot
------------------------------------------

A18 is **necessary and not sufficient**, and ``KT.md`` says so: no check on a
single ``uint32`` can prove the value came from durable storage. The remainder
is this module's obligation, stated by §4.5.4 as three requirements, all of
which are met here:

* the value is read from and written to a **per-account column that survives a
  process restart** — ``g12f.Creator.kt_account_epoch``;
* it is incremented **once per ownership event**, never once per assertion and
  never from a clock —:func:`bump_account_epoch`, and nothing else, writes it;
* an issuer that cannot read a usable value **refuses to issue** rather than
  substituting anything — see ``views.REASON_EPOCH_UNAVAILABLE``.

.. _ownership-events:

The ownership events — this list *is* the security property
-----------------------------------------------------------

An event that should invalidate outstanding assertions but does not increment
leaves exactly the replay window A15 exists to close, so the list is written
down here with its reasoning rather than left to be inferred from call sites.

The rule that decides membership: **an event increments when it changes the set
of principals who can authenticate as this account** — someone gained the
ability, someone lost it, or control was recovered from someone who had it.
``KT.md`` §4.5.4 names "account recovery and account transfer"; on this platform
those are not single endpoints, they are the credential-set changes below.

* ``password_reset`` — a password replaced by spending an emailed recovery
  token. Account recovery by definition: whoever controls the recovery mailbox
  now controls the account, and the reset the previous holder could have
  obtained must not still be available to them.
* ``password_change`` — a password replaced from an authenticated session. This
  is what a user does *because* they believe someone else has the old one, so
  treating it as routine hygiene rather than an ownership event would leave the
  thief's outstanding assertion alive through exactly the action taken to evict
  them.
* ``recovery_address_change`` — a **confirmed** email address replaced by a
  different one, **or deleted**: ``/api/emails/delete``, and the emailed
  one-click unsubscribe, which removes the row too. A deletion is as much a
  revocation as a replacement, and missing them made the sentence "the routes
  that remove one all increment" false (codex adversarial review). A confirmed address is a live recovery principal — it can
  perform ``password_reset`` — so replacing it revokes that standing capability
  to take the account. An attacker with a live session converts a session into
  permanent control this way, and an owner reclaiming a hijacked address is
  recovering the account.

  Only *confirmed*, on every one of those routes: replacing an address nobody has ever confirmed revokes
  nothing, because it was never a credential. Counting those let an
  authenticated caller spend the A18b budget below on seventeen typos (codex
  adversarial review). Adding a first address is an addition and counts for
  nothing either.
* ``social_identity_unlinked`` — a provider identity loses the ability to sign
  in as this Creator (``dj.apps.social``). This is the owner evicting a
  principal, so an assertion that principal minted must stop being spendable.
  The matching *link* deliberately does not increment; see the asymmetry below.
   landed as refuse-not-link: a provisioning path whose handle collides
  with an existing account is refused rather than merged, so the asymmetry is
  unchanged — only a path that genuinely **merges** accounts would be a
  transfer, and a transfer does count.
* ``twitter_identity_unlinked`` / ``twitter_login_toggled`` — the legacy
  ``dj.apps.twitter`` credential family, which predates ``dj.apps.social`` and
  is a **separate, still-live login path** rather than a provider inside it.
  Two revocations: an owner deleting their own ``TwitterProfile``
  (``TwitterDeleteView``) and turning ``allow_login`` **off**
  (``PublicStatusView``) — the switch that decides whether that identity may
  sign in at all. Found by the codex adversarial review, which is the point of
  running it: this family is easy to miss precisely because the newer
  ``social`` app looks like it superseded it.
* ``credential_admin_edit`` — staff reassigning, disabling or deleting a
  ``TwitterProfile`` or a ``ZcashIdentity`` through the Django admin, which is
  a supported operational repair and reaches none of the HTTP routes above.
  Also raised by the codex review. ``manage.py changepassword`` is the same
  gap from the other direction and is closed by ``g12f``'s override of that
  command rather than left as an operator's responsibility to remember.
* ``admin_credential_edit`` — staff changed a Creator's ``password`` or
  ``username`` through the Django admin. This is the literal "the account
  changed hands" path, performed by a third party, and it is the one that leaves
  the account holder with no signal of their own.
* ``account_deletion_scheduled`` — the holder asked for the account to be
  deleted after a grace period (``account_deletion.schedule_deletion``). The
  account goes inactive and every credential already handed out must stop
  working at once: the only thing anyone may do during the grace period is
  sign in afresh -- under the new epoch -- and cancel. Without the increment
  a session or bearer token minted before the request (a stolen one above
  all) would survive into the grace period and could cancel it. It ends
  credentials, not principals: the account's sign-in identities are
  carried across to the new epoch (``account_deletion._carry_login_identities``),
  since signing in with one is how the holder keeps the account.
* ``account_deletion_cancelled`` — a fresh sign-in kept an account whose
  deletion was pending (``account_deletion.keep_account``). Anyone holding a
  valid credential can do this, so it is recorded as an ownership event: the
  keep token it spends is bound to the old epoch and so is single-use, and
  the session it then mints is the only live credential.
* ``account_deleted`` — the holder deleted the account themselves
  (``dj.apps.g12f.account_deletion``). Every credential is removed in the same
  transaction — password, recovery address, social, X and wallet identities,
  passkeys, TOTP — so every principal loses the ability to authenticate at
  once: the largest revocation there is. The increment is what makes that
  reach the credentials already handed out — Knox tokens, browser sessions,
  and (through the published epoch) every OIDC access token an SDK app holds.
  Unlike plain deactivation (below), which leaves the credentials in place,
  deletion destroys them, so it belongs on this side of the line.

**Additions do not count, revocations do** — the asymmetry, since it is the
least obvious line here. A first draft of this list used "any change to the set
of principals who can authenticate", which reads well and is wrong in one
direction. Ask the question the counter actually answers: *must an assertion
minted before this event stop being spendable after it?*

* **Revoking** — an unlink, a disable, a password replaced, a transfer: yes. The
  principal who minted that assertion has just been evicted, and an assertion
  that outlives its holder's access is precisely the replay A15 closes.
* **Adding** — a new identity linked, a login re-enabled: no. Nothing about an
  assertion minted a moment earlier became illegitimate; the principal who
  minted it is still authorised. The danger of a hostile link is *persistence*,
  which the counter does not address and the unlink does.

Counting additions is not free, either. A18b gives a handle a budget of 16
epochs between admitted assertions, and every spurious increment spends some of
it — the codex review demonstrated an ordinary user permanently exhausting that
budget by flipping one boolean. So the broader rule cost availability and bought
nothing.

Deliberately **not** ownership events, with the reason, because an omission that
is only an omission looks the same as an oversight:

* **A credential being added** — a social identity linked, a Zcash address
  linked, a Twitter login re-enabled. See the asymmetry above. The routes that
  *remove* one all increment.
* **Account creation** (including social/Zcash first sign-in, which creates a
  Creator and links an identity in one step). There is no predecessor to
  invalidate; the counter simply starts at:data:`INITIAL_ACCOUNT_EPOCH`.
* **TOTP enrolled or disabled** (``dj.apps.otp``). A second factor narrows or
  widens *how hard* it is to use the password; it does not change **who** holds
  it. The password events above already cover every principal that could
  authenticate. Revisit this if TOTP ever becomes a standalone credential.
* **Knox token revocation / sign-out-everywhere.** Ending a session removes a
  bearer credential derived from an authentication that already happened. The
  principal set is unchanged, and the assertion the session may already have
  obtained is bounded by its own five-minute validity, not by the session.
  This entry is about sign-out *as an event*: it counts nothing, and a
  voluntary sign-out changes nobody's access. The converse direction is real,
  though — every ownership event above now *causes* a sign-out-everywhere as a
  side effect; see the revocation section below.
* **Username change.** It changes which *handle* the account maps to, and A15 is
  retained per handle, so the old handle's retained value is not the new
  handle's baseline. The counter is per account and correctly does not move. The
  handle-collision problem this creates is ``views.REASON_AMBIGUOUS``'s, not
  this module's.
* **Deactivation, strikes, takedown.** Nobody gains the ability to authenticate.
  A deactivated account cannot reach the endpoint at all.
* **Profile edits** — display name, avatar, balances, verification. None of them
  touch a credential.

What "unspendable" means here, precisely
----------------------------------------

The counter bounds **how many resets a handle can accumulate**: one per
ownership event, because A15 requires each admitted assertion to carry a
strictly greater epoch than the last. It is not, and cannot be, a revocation
channel for an assertion already handed out.

The difference is worth writing down because the loose phrasing ("an old
assertion becomes unspendable") invites the wrong reading. An assertion minted
and **withheld** at epoch N stays admissible against a log retaining anything
below N for as long as it lives — which is ``ttl_ms()``, five minutes, capped
again by the log's own ``DEFAULT_MAX_VALIDITY_MS``. Advancing the counter to
N+1 does not reach back and kill it; nothing this side of the log can, because
the log is the only party that holds the retained value and consumes it.

So the guarantees are: an assertion is single-use (the log's nonce ledger), it
is short-lived (the validity cap), and **the resets it can be spent on are
rationed by ownership events** (this counter). The five-minute window in which
a withheld assertion survives an ownership event is a property of the design,
not a defect in the counter, and it is why the TTL is five minutes rather than
five hours. Raised by the codex adversarial review, which read the old sentence
exactly as written.

An ACTIVATION BLOCKER: the counter is per ACCOUNT, the log retains per HANDLE
-----------------------------------------------------------------------------

``INITIAL_ACCOUNT_EPOCH`` is 1 for every account, and a first draft of this
module justified that with "any value under ``2^20`` works, because A15 is
retained per handle". **That is wrong, and it is wrong in the way this whole
issue is about — a confident sentence in front of a control that does not do
what it says.** A handle is not permanently attached to an account. A username
can be changed (``CreatorProfileUpdateSerializer``), which frees the old one for
somebody else, and ``views.handle_for`` only checks who holds it *now*.

So the log's retained value for ``@alice`` was produced by whichever account
held it then, and the next account to hold it brings its own, independently
initialised counter. Two ways that goes wrong, both permanent:

* the new holder's counter is **far ahead** — 40 against a retained 4 — and A18b
  refuses every reset it will ever issue, because 40 exceeds ``4 + 16`` and a
  counter that never decreases cannot climb back under the bound;
* the new holder's counter is **behind** — 1 against a retained 4 — and A15
  refuses its resets, opaquely, until unrelated credential revocations happen to
  carry it past 4.

Nothing on this side can fix it: the issuer never learns the retained value, and
a per-account counter cannot be made comparable to per-handle state without one.
It is the same shape as ``views.REASON_AMBIGUOUS`` — the handle namespace has no
transfer story yet — and it belongs with the handle-eligibility work and the
``UniqueConstraint(Lower("username"))`` ``WIRE.md`` §14.3 asks for. Raised by the
codex adversarial review; recorded as a blocker rather than a caveat because a
recycled username silently losing recovery is not something to discover in
production.

An ownership event also ends the evicted party's live sessions
--------------------------------------------------------------

The counter invalidates *outstanding assertions*, and for a while that was all
it did — which left the very sequence it exists to defeat running to completion
one step behind. An attacker signs in through a linked identity and takes a
Knox token, the owner unlinks it or replaces the password and the counter
advances, and the attacker's token was **still valid** — so they called this
endpoint again and were handed a fresh assertion at the new epoch. The old
assertion died and the evicted principal got a new one. Raised by the codex
adversarial review and recorded here as an activation blocker until it was
closed; ``dj/apps/ktauth/__init__.py`` carries the same observation, that
``IsAuthenticated`` is the only gate on this endpoint.

:bump_account_epoch now closes that itself, and this section is the record of
the decision rather than an open blocker. When the counter increments, the same
function ALSO revokes the four credential families this platform issues, which
is the whole enumeration and is written here so a partial list is visible as a
partial list:

1. **Bearer tokens** — every ``knox.AuthToken`` row (the family  is
   about: an agent/MCP bearer with a 90-day TTL is an ``AuthToken`` like any
   other, so it dies here rather than needing the list extended when that
   feature lands). This item used to name a second model,
   ``rest_framework.authtoken.Token``, which ``dj_rest_auth`` minted on every
   ``/api/auth/login/`` until;  uninstalled the app and purged
   every row, so there is none left to revoke. An earlier draft of this
   docstring asserted it was never issued, which was false; see
   :func:`_revoke_bearer_credentials` for that history.
2. **Django sessions** — every unexpired db-backend row decoding to the
   account, **retired** (the payload is emptied and ``expire_date`` is moved
   into the future so ``clearsessions`` can collect it) by the durable
   ``ktauth.sweep_sessions`` job after the change commits. The job row is
   inserted in the same database transaction as the event, so rollback leaves
   no cleanup promise and a committed event has a durable job even if the web
   process dies after COMMIT. Finding sessions still means reading every
   unexpired row on the platform (; see
   :func:`_schedule_session_sweep`). The rows are dead at use time from the
   instant the event commits regardless — item 6 below — so this is hygiene,
   and the hash is the revocation. The job is asynchronous best effort: queue
   delay, worker loss, and database stalls can postpone or leave the
   physical cleanup, but none of those conditions restore access.
3. **Password-reset tokens** — every unspent ``PasswordResetToken``. A full
   takeover credential with a one-day life; the two password routes and
   ``/api/emails/add`` already burned their own, which left the admin,
   management-command and unlink events issuing a credential change on top of
   a live reset link. See:func:`_spend_outstanding_reset_tokens`.
4. **Already-open WebSockets** — see below; the one that is best effort rather
   than transactional, and the only one of the four that is.

That list is what an event **deletes**. It is not the whole revocation, and
believing it was is what left,  and  open: a sweep can only
ever remove what exists when it enumerates, so it cannot reach a credential
committed a microsecond later by a login already in flight, and it must not
simply delete a passwordless creator's only login method. The other half is
``dj.apps.ktauth.credentials`` — **checks made when a credential is USED**,
which have no window at all because by then the event either committed or it
did not:

5. **Bearer tokens, again, at use time.** Every ``knox.AuthToken`` carries the
   account epoch it was minted against (``g12f.IssuedTokenEpoch``) and
   ``ktauth.authentication.AccountEpochTokenAuthentication`` refuses one that
   is behind the account. This is what closes the  race that the delete
   above cannot: the racing token is stamped from the snapshot that validated
   the identity, so an event committing afterwards makes it stale by exactly
   one.
6. **Django sessions, again, at use time.** ``Creator.get_session_auth_hash``
   mixes the counter in, so ``django.contrib.auth.get_user`` flushes a cookie
   whose account has moved on — including a session created *during* the
   sweep, and including the six events that never touch the password.
7. **The pending ``Email.token`` confirmation link**.
   ``ConfirmEmailView`` refuses a stamp the account has passed. Checked at use
   rather than rotated here, for the reason recorded at
   :func:`_spend_outstanding_reset_tokens`: rotating inside the bump would
   fire on ``recovery_address_change``, which ``AddEmailView`` raises while
   holding the freshly generated token in memory, and would mail a dead link
   on the platform's most-used email route.
8. **Linked social / Zcash / Twitter identities**. Each row records the
   epoch it was linked at and the login routes refuse a stale one — unless the
   account has no usable password, where refusing would be account destruction
   rather than a sign-out. Nothing is deleted: the owner re-links in
   one click from a session that now requires the new password, and the
   attacker whose planted identity this is aimed at cannot reach that route.
   Note this supersedes an earlier line here that excluded identities as "the
   owner's own login methods — revoking those is what *triggers* an event, not
   what an event does". That reasoning is right about the epoch COUNTER, and
   the asymmetry above still holds: linking still does not increment. It was
   never a reason to leave the credential alive across an eviction, and the
   module could not tell an owner's identity from an attacker's from the row
   alone — so it now records when, and asks at use time.

Still not revoked, deliberately: the TOTP secret — a second factor the owner
holds, not a principal.

An outstanding ``PasswordResetToken`` is deleted by the sweep and is **not**
additionally stamped. The reasoning, since "we decided not to" is not a reason:
its issuer (``emails.send_password_reset_email``) takes ``SELECT... FOR
UPDATE`` on the Creator row and re-compares the password hash under that lock,
so the two password events cannot race it at all; the six non-password events
can, but the credential they would leak is mailed to the account's own
**confirmed** address, which is not a mailbox the attacker this module is about
controls. Narrowed rather than closed, and named as such.

A note on how this list was got wrong once, since the whole point of the module
is that a confident sentence in front of a control is worse than no sentence.
This enumeration originally read "``rest_framework.authtoken`` is in
``INSTALLED_APPS`` but is not in ``DEFAULT_AUTHENTICATION_CLASSES`` and nothing
imports its ``Token``, so it issues nothing to revoke". The first half was
checked and the second half was assumed. ``dj_rest_auth`` imported it, every
login wrote one, and the row survived every ownership event — disproved
empirically by an independent reviewer, not by re-reading the sentence. What
authenticates a request and what is *stored as a credential* are two different
questions, and only the first is answered by
``DEFAULT_AUTHENTICATION_CLASSES``. ``dj/apps/test_authentication_inventory.py``
answers the first, by equality on the global list, and also walks
every view's own ``authentication_classes`` for DRF's ``TokenAuthentication``
-- a per-view override is exactly how a dormant credential becomes a live one.
(The dormant credential in question no longer exists:  purged it.)

The revocation
lives inside the function rather than beside each call site because the
ownership-event list must stay the single source of truth: a second,
hand-maintained list of "routes that also sign out" would drift exactly the way
this list would have drifted if it had been left to be inferred from call
sites. Every route that revokes a credential inherits sign-out-everywhere
automatically, including the ones that reach no HTTP view at all — the admin
mixin and ``manage.py changepassword``.

The decision taken is **revoke ALL, not all-but-current**, and the reasoning is
worth writing down because the alternative looks kinder. The function takes
only a user id: it has no notion of "the current request" to keep alive.
Plumbing a per-call exclusion through all 13 call sites — the password and
recovery-address routes, two twitter routes, the social unlink, the admin
mixin's three paths, the management command — would create two divergent lists
of call sites where there is now one. And on the reset path the session that
would be spared may be the *attacker's*: whoever initiated a password reset is
authenticated by definition, so keeping any session alive through that event
is unsafe by default. Signing out everywhere after a credential change is
standard practice, and the legitimate user just signs back in. One caller
stretches the "whoever triggered this was authenticating themselves" framing —
the emailed unsubscribe link, which mail infrastructure may fire rather than a
person at a keyboard — and:func:`bump_account_epoch`'s docstring records why
the uniform rule is still the right trade there.

With that, the property this module exists for holds end to end: an ownership
event invalidates the outstanding assertion AND ends every live bearer
credential that could request another one at the new epoch. What bounds an
assertion already handed out is unchanged and deliberately out of reach — see
"What 'unspendable' means here, precisely" above.

The third surface — already-open WebSockets — needs its own mechanism and has
one. ``AuthMiddlewareStack`` resolves ``scope["user"]`` from the session at
CONNECT time and the consumers cache it, so deleting the session row ends the
session **without** disconnecting a live socket: the evicted party would
otherwise keep that connection, and its identity, until they disconnect or the
pod recycles. So the event also broadcasts a close to every consumer
authenticated as the account — see ``dj.apps.events.revocation`` for the group
contract, and:func:`_schedule_socket_disconnect` for why it is fired from
``transaction.on_commit`` and why it never raises.

The surfaces do not fail the same way, and the difference is the point:
Knox tokens are deleted **inside the caller's transaction**, all-or-nothing
with the credential change; the session cleanup job is inserted in that same
transaction and runs later on a worker (a stale row it leaves behind is
refused at use time by the session auth hash); the socket broadcast is best
effort across a process boundary with no state to roll back, so it is logged
at ERROR when it fails rather than allowed to fail a credential change that
has already committed. The socket's ``on_commit`` callback and the durable job
are independent once the transaction is visible: the broadcast is the only
thing that reaches an already-connected socket, and it must not wait for an
O(all sessions) scan that a worker timeout can kill outright. The worker may
race the callback; the session hash, compare-and-swap write, and future grace
expiry make either execution order safe.
A socket the broadcast could not reach is push-only (neither
consumer implements ``receive``) and cannot mint an assertion — that path is
HTTP — so what survives a failed broadcast is a read of the account's own
notification/AI stream until the connection drops, not the ability to act.

An ACTIVATION BLOCKER: A18b's budget has no bound on this side
--------------------------------------------------------------

A18b refuses an ``account_epoch`` more than **16** above the value the log
retained for the handle. Nothing here bounds how fast the counter climbs: every
event in the list is one an ordinary user can repeat, so any account that runs
through more than sixteen revocations between two *admitted* assertions will
find its next ``reset`` refused as ``AccountEpochStepTooLarge`` — permanently,
because a counter that never moves backwards cannot climb back under the bound.

Dropping additions from the list (above) removed the two cheapest levers — a
boolean flip and an unconfirmed address — but it does not close this: seventeen
password changes do it too, just more slowly. **No issuer can satisfy A18b unilaterally**, because the
bound is relative to a value only the log holds, and the issuer never learns it.

This is stated as a **blocker on enabling the endpoint**, not as a caveat. The
failure is a refusal rather than an acceptance — the safe direction, and the
reason it does not block *this* change — but whoever sets
``KT_AUTHORITY_SECRET_NAME`` inherits it, and it has to be resolved with the log
operator first: either the log surfaces the retained value so an issuer can stay
inside the bound, or A18b becomes a rule about the *shape* of the advance rather
than a fixed step. Raised by the codex adversarial review; belongs upstream
alongside free2z/zuu#651.
"""

from __future__ import annotations

import logging
import time

from django.db import DEFAULT_DB_ALIAS, router, transaction
from django.db.models import F, Q

from . import signing

logger = logging.getLogger(__name__)

#The value every account starts at, and the value the migration backfills onto
#every existing row.
#
#1 rather than 0 so that a zero can only mean "never populated" and is refused
#as unusable rather than signed. It is **not** claimed that the specific value
#is free: see the per-account/per-handle blocker above for why a fresh counter
#is not comparable to state the log retained for a handle its previous holder
#gave up.
INITIAL_ACCOUNT_EPOCH = 1

#``KT.md`` §4.5.4 A18a. Re-exported from:mod:`dj.apps.ktauth.signing`, which
#owns it because that is where the value is refused on the wire; one
#definition rather than two so the two checks cannot drift apart.
ACCOUNT_EPOCH_CEILING = signing.ACCOUNT_EPOCH_CEILING

EVENT_PASSWORD_RESET = "password_reset"
EVENT_PASSWORD_CHANGE = "password_change"
EVENT_RECOVERY_ADDRESS_CHANGE = "recovery_address_change"
EVENT_SOCIAL_IDENTITY_UNLINKED = "social_identity_unlinked"
EVENT_TWITTER_IDENTITY_UNLINKED = "twitter_identity_unlinked"
EVENT_TWITTER_LOGIN_TOGGLED = "twitter_login_toggled"
EVENT_ADMIN_CREDENTIAL_EDIT = "admin_credential_edit"
EVENT_CREDENTIAL_ADMIN_EDIT = "credential_admin_edit"
EVENT_ACCOUNT_DELETED = "account_deleted"
EVENT_ACCOUNT_DELETION_SCHEDULED = "account_deletion_scheduled"
EVENT_ACCOUNT_DELETION_CANCELLED = "account_deletion_cancelled"

#Every event that may increment the counter. Bounded and enumerated so a typo
#at a call site is a loud ``ValueError`` rather than a silent bump, and so a
#test can hold each one against the enumeration in this module's docstring.
#
#Incrementing is not all an event does::func:`bump_account_epoch` also
#deletes the account's Knox tokens and ends its Django sessions, so this is
#equally the enumeration of when sign-out-everywhere happens. That is why it
#must stay in one place — see the revocation section of the docstring.
OWNERSHIP_EVENTS = frozenset({
    EVENT_PASSWORD_RESET,
    EVENT_PASSWORD_CHANGE,
    EVENT_RECOVERY_ADDRESS_CHANGE,
    EVENT_SOCIAL_IDENTITY_UNLINKED,
    EVENT_TWITTER_IDENTITY_UNLINKED,
    EVENT_TWITTER_LOGIN_TOGGLED,
    EVENT_ADMIN_CREDENTIAL_EDIT,
    EVENT_CREDENTIAL_ADMIN_EDIT,
    EVENT_ACCOUNT_DELETED,
    EVENT_ACCOUNT_DELETION_SCHEDULED,
    EVENT_ACCOUNT_DELETION_CANCELLED,
})


def bump_account_epoch(user_id, *, event: str, using: "str | None" = None) -> None:
    """Record one account-ownership event against ``user_id``.

    The **only** writer of ``Creator.kt_account_epoch``. It is a single
    ``UPDATE... SET kt_account_epoch = kt_account_epoch + 1``, deliberately:

    * ``F()`` makes it atomic in the database, so two ownership events landing
      concurrently produce two increments rather than one — a read-modify-write
      in Python would lose one, and a lost increment is a live assertion that
      should have been dead;
    * ``QuerySet.update()`` never loads or writes any other column, so this can
      neither clobber a balance nor be reordered against the caller's own save;
    * it takes ``user_id`` rather than an instance, because an instance is the
      thing that might be stale and the increment must be relative to the row.

    Call it **after** the credential change has been written, inside the same
    transaction, so an increment cannot survive a rolled-back password change.
    Getting that backwards is safe in the direction that matters (a spurious
    increment only costs a legitimate reset an A18b step) but it is still wrong.

    ``using`` names the database alias, for the one caller that has an explicit
    one — ``manage.py changepassword --database``. Left ``None`` it routes the
    way every other write here does. It is not optional politeness: an operator
    repairing a restored database would otherwise change the password on one
    database and increment a same-numbered primary key on another (codex
    adversarial review). The configured Procrastinate Django connector must
    target that same alias; a mismatch raises before any epoch/token write,
    rolling back the caller's credential transaction. Passing task arguments
    never changes the queue connection.

    Never raises for an account that no longer exists: the row is gone, there is
    nothing left to invalidate, and an ownership-event hook must not turn a
    successful credential change into a 500.

    **An event also revokes.** When the UPDATE matched a row, every Knox token
    held for the account is deleted too, and a durable job is queued to retire
    every unexpired Django session whose decoded user is that account once a
    worker runs — the evicted party holding a live bearer credential could
    otherwise simply ask this endpoint again and receive a fresh assertion at
    the new epoch, which is the replay this counter exists to close. The decision to revoke ALL credentials rather than all
    but "the current" one, and the reasoning, is documented in the module
    docstring under "An ownership event also ends the evicted party's live
    sessions"; the shape of it is that this function takes only a user id and
    has no request to exempt.

    The token deletes are plain ORM writes made inside the caller's
    transaction: every HTTP and management-command caller already wraps the
    bump in the same transaction as the credential change (above), so the
    increment and the token revocation commit or roll back together, and no
    new atomic block is opened here. The session sweep is the exception, by
    design: it is O(every unexpired session on the platform), so a durable
    Procrastinate job is inserted in the current transaction and runs later,
    out from under whatever row lock the caller holds (;
    :func:`_schedule_session_sweep` has the argument). The job insert rolls
    back with the event, while a committed event keeps its cleanup promise if
    the web process dies before an ``on_commit`` callback could run. The one
    caller that stock Django leaves outside a transaction — the
    admin changelist's bulk delete reaching:meth:`CredentialAdminMixin.
    delete_queryset` — now opens its own atomic block for exactly this reason.
    Note the load-bearing detail on `/api/emails/add`: it sits in
    `NON_ATOMIC_POST_PATHS` (py/dj/util/middleware.py) precisely because it
    locks the account row and must not hold the request-wide transaction — but
    it is saved by `AddEmailView` opening its OWN explicit
    `transaction.atomic()` around the address change and this bump. A future
    route that opts out of the request-wide transaction without opening one of
    its own would silently break the all-or-nothing property here; keep the
    pairing (opt-out ⇒ explicit atomic) when editing those views.

    **Known consequence, stated rather than buried:** one of those callers is
    the emailed unsubscribe link (`emails.OptOutEmailView`, RFC 8058 one-click),
    which removes a confirmed recovery address and so fires
    ``recovery_address_change``. Whoever — or whatever mail client — holds that
    link can therefore sign the account out of every device with one click.
    That is deliberate: the click proves control of a mailbox that could until
    that moment reset the password, and distrusting every bearer token minted
    before the proof is the conservative direction. The legitimate user pays a
    single re-login; an attacker who had the mailbox loses their sessions at
    exactly the moment their standing capability is torn away.
    """
    if event not in OWNERSHIP_EVENTS:
        raise ValueError(f"{event!r} is not a declared ownership event")

    # Imported here, not at module scope. This module is reachable from the
    # ktauth URLconf and from several apps' views; importing the user model at
    # import time would bind it before the app registry is populated.
    from django.contrib.auth import get_user_model

    from django.core.exceptions import ImproperlyConfigured
    from procrastinate.contrib.django import app
    from procrastinate.contrib.django.django_connector import DjangoConnector

    user_model = get_user_model()
    using = using or router.db_for_write(user_model)
    # Task kwargs do not choose the enqueue connection. Refuse a mismatched
    # queue before changing credentials: otherwise its job can survive an
    # ownership-transaction rollback on another database.
    if not isinstance(app.connector, DjangoConnector) or app.connector.alias != using:
        raise ImproperlyConfigured(
            "Ownership events require the Procrastinate Django connector "
            "on the same database alias as the account write."
        )
    rows = user_model._default_manager.using(using)
    updated = rows.filter(pk=user_id).update(
        kt_account_epoch=F("kt_account_epoch") + 1
    )
    if updated:
        current_epoch = rows.filter(pk=user_id).values_list(
            "kt_account_epoch", flat=True,
        ).get()
        from .credentials import mark_passwordless_fallbacks

        fallbacks_marked = mark_passwordless_fallbacks(
            user_id, current_epoch, using=using,
        )
        tokens_revoked = _revoke_bearer_credentials(user_id, using)
        resets_revoked = _spend_outstanding_reset_tokens(user_id, using)
        # The disconnect is the only post-commit callback. It is the ONLY
        # thing that reaches an already-connected WebSocket -- consumers cache
        # `scope["user"]` at handshake and never re-read it -- while the
        # session sweep is a worker job and cannot occupy this request thread.
        # Once the commit is visible, the callback and worker are independent;
        # the session hash, CAS write, and future grace expiry make either
        # execution order safe. Raised by the codex adversarial review.
        _schedule_socket_disconnect(user_id, using)
        _schedule_session_sweep(user_id, using)
        _schedule_epoch_publication(user_id, using)
        logger.info(
            "kt account_epoch incremented: user=%s event=%s "
            "(revoked %d bearer token(s) across both token models, "
            "%d reset token(s); marked %d passwordless fallback identity(ies); "
            "session sweep queued for commit)",
            user_id,
            event,
            tokens_revoked,
            resets_revoked,
            fallbacks_marked,
        )


def _schedule_epoch_publication(user_id, using) -> None:
    """Publish the new epoch to resource servers once it is committed.

    The OIDC access tokens ``dj.apps.oidc`` mints carry the account epoch as
    ``aep``, and a resource server (the AI gateway) refuses a token whose
    epoch is behind the account's -- reading the current value from the
    shared Redis that ``dj.apps.oidc.epoch_publish`` writes. This is the
    write. It runs ``on_commit`` so a rolled-back event publishes nothing,
    the value published is the one this transaction wrote (read back here
    rather than assumed), and the write itself is monotonic so two events
    committing out of callback order cannot leave Redis one behind.

    A publication that fails is logged, never raised: the event is already
    committed, and a resource server that cannot read the epoch fails
    closed and asks ``/api/oauth/internal/epoch/<sub>/``.
    """
    from django.contrib.auth import get_user_model

    from dj.apps.oidc.epoch_publish import publish_account_epoch

    row = (
        get_user_model()
        ._default_manager.using(using)
        .filter(pk=user_id)
        .values_list("public_id", "kt_account_epoch")
        .first()
    )
    if row is None:
        return
    public_id, epoch = row
    transaction.on_commit(
        lambda: publish_account_epoch(public_id, epoch), using=using,
    )


def _spend_outstanding_reset_tokens(user_id, using) -> int:
    """Burn every unspent password-reset token the account has outstanding.

    A ``PasswordResetToken`` is a full account-takeover credential — spending
    one replaces the password without proving the old one — and it lives for a
    day. It is a bearer credential in the same sense a Knox token is, and it
    was the one family that survived some of the events on this list.

    Both password routes and ``/api/emails/add`` already did this for
    themselves, and that is exactly the "two lists that are supposed to be the
    same list" the module docstring warns about: the events they did NOT cover
    were ``social_identity_unlinked``, both twitter events,
    ``admin_credential_edit`` and ``credential_admin_edit``. The last two are
    the ones that matter — staff repairing a compromised account, or
    ``manage.py changepassword``, would replace the password and leave a live
    reset link pointing at whatever mailbox the attacker still controlled.
    Moving the sweep in here makes it unconditional and leaves the per-route
    calls as harmless no-ops (they run first, inside the same transaction, so
    this updates zero rows by the time it runs).

    Marked ``used`` rather than deleted, matching what every existing call site
    does: the row is the audit trail of a link that was issued, and the
    redemption path keys on ``used=False``.

    **Not swept, and this is a known live hole rather than a tidy boundary:**
    ``Email.token``, the pending-address confirmation link. The chain, spelled
    out because the codex adversarial review was right to escalate it from a
    footnote: an attacker with a stolen session POSTs their own address to
    ``/api/emails/add``, which replaces the account's (OneToOne) ``Email`` row
    with an unconfirmed one and mails THEM a confirmation link; the owner
    notices and changes their password; everything above dies, the attacker
    loses the session — and the emailed link still works. Confirming it makes
    the attacker's mailbox the account's recovery principal, and a password
    reset then hands them the account back.

    **Closed since, and still not by rotating it here** — which is the
    trap this paragraph used to warn whoever picked it up about, and the reason
    the shape of the fix is worth keeping on the record. The natural fix,
    rotating ``token`` when ``confirmed_at is None``, fires on
    ``recovery_address_change``, which ``AddEmailView`` raises *while holding
    the freshly generated token in memory* and then passes to
    ``send_confirmation_email``: it would have silently mailed a dead link on
    the ordinary email-change flow. Rotating a *confirmed* row would have been
    worse still, because that column is also the RFC 8058 one-click
    unsubscribe token and burning it breaks links already sitting in inboxes —
    a compliance problem, not a UX one.

    So the link is stamped with the epoch it was issued at
    (``Email.token_epoch``) and ``ConfirmEmailView`` refuses a stamp the
    account has moved past. Nothing is rotated, confirmed rows are untouched,
    the unsubscribe landing never consults the stamp, and ``AddEmailView``
    stamps *after* its own bump so the link it mails survives the event it
    raises. See ``dj.apps.ktauth.credentials``.
    """
    # Imported inside the function: `dj.apps.emails.views` imports this module,
    # and this keeps the dependency one-directional at import time.
    from dj.apps.emails.models import PasswordResetToken

    outstanding = PasswordResetToken.objects.filter(
        email__user_id=user_id, used=False,
    )
    if using is not None:
        outstanding = outstanding.using(using)
    return outstanding.update(used=True)


def _schedule_socket_disconnect(user_id, using) -> None:
    """Hang up the account's already-open WebSockets, once the change commits.

    The third credential surface, and the one a token/session delete cannot
    reach on its own. ``AuthMiddlewareStack`` resolves ``scope["user"]`` from
    the session **at connect time** and both consumers cache it, so a socket
    that is already up keeps its identity after the row behind its cookie is
    gone — indefinitely, on a tab nobody closes. 's review recorded this
    as a documented residual gap; it is closed here rather than described.

    Two deliberate choices, both of which the alternative gets subtly wrong:

    ``transaction.on_commit`` **rather than an inline call.** Every caller runs
    this inside the transaction that writes the credential change, and a
    transaction can still roll back after the bump (a later validation error, a
    deadlock, the admin's bulk delete failing on the next row). Disconnecting
    inline would sign a user out of a live socket for a change that never
    happened — an irreversible side effect ordered before the commit that
    justifies it. Outside any atomic block — ``manage.py changepassword``
    opens its own, but a future autocommit caller might not — Django runs the
    callback immediately, which is the correct degenerate case.

    **No exception escapes**, by construction in
    :func:`~dj.apps.events.revocation.disconnect_live_sockets`. This runs after
    COMMIT, where raising would turn a completed credential change into a 500
    and abandon the callbacks queued behind it, and the channel layer is Redis
    — a dependency whose loss must not take password changes down with it. The
    durable half (the token deletes) already committed atomically with the
    credential change and is what fails closed; a socket the broadcast could
    not reach is logged at ERROR, with the account id, by that function.
    """
    # Imported inside the function: `dj.apps.events` pulls in channels, and
    # this module is reachable from the ktauth URLconf.
    from dj.apps.events.revocation import disconnect_live_sockets

    transaction.on_commit(
        lambda: disconnect_live_sockets(user_id),
        using=using or DEFAULT_DB_ALIAS,
    )


def _deleted_rows_of(queryset, model) -> int:
    """``queryset.delete()``, counting only ``model``'s own rows.

    ``QuerySet.delete()`` returns ``(total, per_label)`` where ``total``
    includes cascaded deletions -- and ``g12f.IssuedTokenEpoch`` cascades from
    every ``AuthToken``, so the total is roughly double the tokens.
    Reading the per-label entry keeps the log line counting credentials.
    """
    _total, per_label = queryset.delete()
    if isinstance(per_label, dict):
        return per_label.get(model._meta.label, 0)
    return _total  # pragma: no cover - Django has always returned the dict


#How many ``django_session`` rows one round trip of the sweep fetches. The
#complete scan is O(all session rows), but one worker pass reads only this
#many rows before yielding via a durable continuation. Expired rows count
#toward the page limit too, preventing an expired-key gap from expanding
#the page query. Database stalls still have no strict wall-clock bound.
SESSION_SWEEP_FETCH_CHUNK = 2000

#How many doomed rows go into one conditional expiry statement. Each
#contributes its key AND the payload the scan read (see
#:func:`_expire_matching`), so this bounds both the parameter count and the
#bytes held in memory between the read and the write.
SESSION_SWEEP_EXPIRE_BATCH = 200

#How long a swept row is left un-collectable by ``clearsessions``, measured
#from the write that swept it. A swept row is emptied, so it authenticates
#nobody the instant the statement lands; the grace exists only so the reaper
#cannot physically delete the row while the request that owns it is still
#between COMMIT and ``SessionMiddleware.process_response`` — a delete there
#makes that middleware's ``force_update`` raise ``SessionInterrupted`` and
#hand a 400 to someone who successfully changed their password.
#
#The number remains deliberately generous. The async worker may start before,
#during, or after the request that created a session finishes its response
#save. The row must outlive that response-save window; 900 seconds covers it
#without pretending to bound the full scan, and still leaves the row to the
#reaper on its next daily pass.
SESSION_SWEEP_REAP_GRACE_SECONDS = 900

#A sweep slower than this is logged at WARNING rather than INFO. The number
#exists so the growth  describes is an alert, not a post-mortem: at the
#measured ~70k rows/s (that issue, on the  branch) this is roughly
#350k unexpired rows, five times the working set that first prompted it.
SESSION_SWEEP_WARN_SECONDS = 5.0


def _revoke_bearer_credentials(user_id, using) -> int:
    """Delete every stored bearer token for ``user_id``, inside the transaction.

    ``knox.AuthToken`` is the only bearer credential this platform stores: the
    API's bearer token, and the family  is about. It carries "someone can
    act as this account" without holding its password and can be found by an
    indexed foreign key, and an ownership event evicts whoever lost access, so
    every row goes -- leaving one alive lets an evicted principal mint a fresh
    assertion at the new epoch, which defeats the counter this module owns.

    The next family, ``django.contrib.sessions`` rows, is NOT deleted here.
    It cannot be found by a foreign key — the user id lives inside a signed
    blob — so revoking it means reading every unexpired row on the platform,
    and  is the record of why that must not happen inside the caller's
    transaction. See:func:`_schedule_session_sweep`.

    **There used to be a second token model here, and an earlier draft of this
    module denied it existed.** ``rest_framework.authtoken.Token`` was minted
    by ``dj_rest_auth``'s ``LoginView`` with ``get_or_create`` on every
    ``POST /api/auth/login/`` (its default ``TOKEN_MODEL``), so every
    password-login account held a permanent, never-rotating key. The draft
    said "nothing imports its ``Token``, so it issues nothing to revoke"; the
    first half of that sentence was checked and the second was assumed, and an
    independent reviewer disproved it empirically. Nothing ever authenticated
    with that key -- ``knox.auth.TokenAuthentication`` looks the presented
    prefix up in ``AuthToken`` -- but it was deleted here anyway, because
    "inert" was a property of the configuration, not of the credential.

    It is gone now, in three steps:  stopped issuing it
    (``REST_AUTH['TOKEN_MODEL'] = None``),  uninstalled
    ``rest_framework.authtoken`` and purged every row in the same release
    (``g12f`` migration 0113, which also drops the table's foreign key to
    Creator so an account delete cannot trip over a row Django no longer
    knows about), and a later release drops the empty table. So there is
    nothing of it left to revoke, and this function deletes Knox rows only.
    ``dj/apps/test_authentication_inventory.py`` pins that the app stays
    uninstalled and that no view wires DRF ``TokenAuthentication`` back in.

    Returns the number of ``AuthToken`` rows deleted, for the log line in
    :func:`bump_account_epoch`. Deleting zero rows is the ordinary case — most
    accounts hold none when an event lands — and is harmless by construction:
    a delete of nothing commits nothing.
    """
    from knox.models import AuthToken

    tokens = AuthToken.objects.filter(user_id=user_id)
    if using is not None:
        tokens = tokens.using(using)

    # Count only THIS model's rows: delete() returns the total including
    # cascades, and ``g12f.IssuedTokenEpoch`` is one-to-one with every
    # AuthToken, so the raw total would double the log line.
    return _deleted_rows_of(tokens, AuthToken)


def _live_session_auth_hashes(alias, user_id) -> frozenset:
    """The session auth hashes that count as current for ``user_id``, now.

    Empty when the account is gone — deleted between the bump and the
    commit — which is the right answer twice over: its sessions decode to a
    user ``get_user`` refuses anyway, and there is no current credential to
    spare anything against. ``SECRET_KEY_FALLBACKS`` hashes count as
    current, or a secret rotation would sign everyone out here a second
    time.
    """
    from django.contrib.auth import get_user_model

    account = (
        get_user_model()._default_manager.using(alias).filter(pk=user_id).first()
    )
    if account is None:
        return frozenset()
    return frozenset(
        {account.get_session_auth_hash(), *account.get_session_auth_fallback_hash()}
    )


def _retire_matching(target, batch, empty_payload, expires_at) -> int:
    """Retire exactly the rows still holding the payload the scan read.

    Two things at once, and each closes a finding from the codex adversarial
    review of.

    **Emptied, then scheduled for the reaper — not deleted, and not merely
    expired.** The payload is replaced with an encoded ``{}``, which is what
    actually ends the session: ``get_user`` needs ``_auth_user_id`` and there
    is none, so the row authenticates nobody from the instant the statement
    lands. ``expire_date`` is then set a minute out rather than into the past.
    Deleting was wrong because the password routes re-login the caller inside
    the request transaction and ``cycle_key()`` writes that row from a session
    cache still holding the pre-event hash — the sweep cannot tell it from a
    stale row, and ``SessionMiddleware.process_response`` runs OUTSIDE the
    request transaction, after these callbacks, so its ``force_update`` would
    hit a missing row and raise ``SessionInterrupted``: a 400 for successfully
    changing a password. Stamping the expiry into the past instead left the
    same row eligible for the daily ``clearsessions`` job in that identical
    window, which is the same failure with a smaller probability. A minute of
    grace removes it, costs nothing, and still hands the row to the reaper.

    **Conditional on the payload the scan read** —
    ``WHERE (key = %s AND data = %s) OR...`` rather than the obvious
    ``WHERE key IN (...)``. The sweep classifies a row from a cursor and
    writes it some time later, and in that gap the row can be rewritten by the
    request that owns it: with two ownership events overlapping on one
    account, sweep A reads the payload of the row request B's ``cycle_key()``
    has since replaced with the current hash and a fresh expiry, and a blind
    key-only write then retires a session B already re-proved — B returns 200
    and its next request is signed out. Matching the payload back makes the
    write a compare-and-swap: a row that moved is left to whoever moved it.

    Returns the number of rows actually written, which is the count worth
    logging — a row that changed under the scan was not swept.
    """
    predicate = Q()
    for pk, session_data in batch:
        predicate |= Q(pk=pk, session_data=session_data)
    return target.filter(predicate).update(
        session_data=empty_payload, expire_date=expires_at
    )


def _schedule_session_sweep(user_id, using) -> None:
    """Durably enqueue the account's Django-session cleanup.

    Why not inline, like the token deletes above: the contrib db
    backend stores the user id inside a signed blob, so the only way to find
    an account's sessions is to read **every unexpired row on the platform**
    and decode each one in Python. That is O(all sessions), and the table is
    not bounded by anything this module controls — ``SESSION_COOKIE_AGE`` is
    14 days and any unauthenticated route that writes to ``request.session``
    mints a row per cookie-less hit. Doing that inside the caller's
    transaction meant doing it while ``/api/emails/add`` held
    ``SELECT... FOR UPDATE`` on the Creator row, on a route that is in
    ``NON_ATOMIC_POST_PATHS`` precisely because it must not hold that lock;
    the measured cost was ~14s per million rows, under the lock, on the
    account-recovery path, inflatable by anyone with ``curl``.

    ``bump_account_epoch`` verifies the Procrastinate Django connector uses
    the same alias as the account write, so ``defer`` joins that transaction.
    A worker cannot see the row until the event commits; rollback removes the job with
    the epoch/token changes. This is intentionally not an ``on_commit``
    callback: a process dying after COMMIT but before that callback runs would
    otherwise lose the cleanup promise.

    Each ownership epoch gets its own full scan. A continuation from an older
    epoch must never swallow a newer event whose stale sessions can occur
    before its cursor. Workers serialize within each epoch and discard
    superseded epochs; each bounded page queues behind existing work.
    In-flight pages from different epochs may overlap, with current-hash
    checks and payload CAS protecting newer sessions. A killed worker can
    strand its own epoch, but its lock cannot block a later event's scan.

    The sweep is hygiene, not revocation. While this job waits, the account
    epoch and ``Creator._get_session_auth_hash`` refuse every pre-event
    session at use time. A worker outage can delay physical row retirement;
    it cannot restore an old owner's access.
    """
    from django.contrib.auth import get_user_model
    from .tasks import enqueue_session_sweep

    alias = using or DEFAULT_DB_ALIAS
    generation = get_user_model().objects.using(alias).values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user_id)
    enqueue_session_sweep(user_id, alias, generation)


def _sweep_sessions_page(user_id, using, *, after_key="") -> tuple[int, str | None]:
    """Retire at most one keyset page and return its continuation cursor.

    Returns (retired count, next cursor), with None when the scan is complete.

    Sessions are enumerated rather than filtered in SQL because their payload
    is opaque at the storage layer: ``SessionStore`` encodes the user id inside
    a signed blob, and only ``decode()`` can read it back out. Expired rows are
    skipped; they authenticate nobody and belong to session garbage collection.
    The scan is paged over the primary key, two columns at a time rather than
    whole model instances, and the writes go out in bounded batches — each one
    a compare-and-swap against the payload the scan read, see
    :func:`_retire_matching` — so neither the platform's active-session table
    nor the account's own session list is ever materialised at once, on either
    side of the connection.

    **The row is emptied and left for the reaper, not deleted, and that is
    what makes running after commit safe rather than merely faster.** The
    payload becomes an encoded ``{}``, which is what actually ends the
    session — ``get_user`` needs ``_auth_user_id`` and there is none — and
    ``expire_date`` is set a minute out so ``clearsessions`` collects the row
    on its next daily pass. What the row does NOT do is vanish out from under
    a request that is still holding it. The password routes re-login the
    caller *inside* the request's transaction, and ``cycle_key()`` writes
    that new row from the session cache it already holds, so on disk it still
    carries the **pre-event** auth hash when this runs: nothing here can tell
    it from a stale row. ``SessionMiddleware.process_response`` runs
    *outside* the request transaction, and the worker may run before, during,
    or after that response save. A delete in that window would leave its
    ``force_update`` hitting a missing row and raising
    ``SessionInterrupted`` — a 400 handed to someone who successfully changed
    their password. Against a row that still exists that same ``save()``
    succeeds and rewrites the payload, the hash and the expiry, which is the
    outcome wanted on both sides: the caller keeps the session they just
    re-proved, everyone else's is dead at its next load.

    :func:`_retire_matching` carries the rest of that argument, including why
    the expiry goes a minute into the FUTURE rather than the past (an expiry
    in the past hands the same row to ``clearsessions`` inside the same
    window, which is the identical failure with a smaller probability) and
    why the write is a compare-and-swap against the payload the scan read.

    **A row already carrying a current session auth hash is spared**, because
    after commit the sweep races forward as well as backward: another worker
    can complete a login *with the new credential* — the owner signing back
    in on the device they just reset from — and ``_auth_user_id`` alone
    cannot tell that session from the evicted party's. The hash is the
    discriminator that already exists, since every event moves the counter
    and ``_get_session_auth_hash`` mixes it in, so a row proving a current
    hash was necessarily written after the event that produced it. The test
    is taken immediately before each write rather than once before the
    cursor opens — see ``retire()`` below — so a SECOND ownership event
    committing mid-scan does not leave this sweep retiring logins made
    against a credential newer than the one it snapshotted. It does NOT
    spare the caller's own ``cycle_key()`` row, which still holds the
    pre-event hash; that row is why this empties rather than deletes.

    Expiry is hygiene either way. The revocation is
    ``Creator._get_session_auth_hash``, which mixes the counter in: every
    event moves it, so every session written before the event is refused by
    ``django.contrib.auth.get_user`` on its next request whether or not this
    ever ran.

    The enumeration hard-codes the contrib db backend's model, which is what
    ``SESSION_ENGINE`` has always been here (nothing in settings overrides it).
    If that ever changes, this function would silently revoke nothing while the
    log line kept saying "0 session(s)" — which is exactly the shape of quiet
    failure this module refuses, so a non-db engine is called out loudly at
    WARNING instead of being allowed to rot invisibly.

    A row whose payload does not decode is treated as belonging to nobody:
    ``SessionBase.decode`` already reduces a bad signature or a bad pickle to
    ``{}``, and the guard below keeps even an engine whose decode raises from
    turning a password change into a 500.
    """
    from datetime import timedelta

    from django.conf import settings
    from django.contrib.sessions import models as session_models
    from django.contrib.sessions.backends.db import SessionStore as DbSessionStore
    from django.utils import timezone

    if settings.SESSION_ENGINE != (
        "django.contrib.sessions.backends.db"
    ):  # pragma: no cover - a future engine swap, not a current path
        logger.warning(
            "kt ownership-event revocation cannot see sessions: "
            "SESSION_ENGINE is %s, not the contrib db backend; "
            "only Knox tokens will be revoked",
            settings.SESSION_ENGINE,
        )

    alias = using or DEFAULT_DB_ALIAS
    now = timezone.now()

    # Page every key, including expired rows. Filtering expiry before LIMIT
    # could make a sparse active page scan an arbitrarily large expired gap.
    sessions = session_models.Session.objects.using(alias).values_list(
        "pk", "session_data", "expire_date",
    )
    target = session_models.Session.objects.using(alias)
    wanted_id = str(user_id)
    store = DbSessionStore()
    empty_payload = store.encode({})

    def retire(batch):
        """One batch, with the current-hash test taken as late as possible.

        The reaper grace is stamped here too, for the same reason.

        ``live_hashes`` is read here rather than once before the cursor
        opens, and that is the difference between a window as wide as the
        whole scan and one as wide as a single statement. A second ownership
        event can commit while this sweep is streaming, and a login with THAT
        credential is legitimate and newer than anything this sweep knows
        about; a snapshot taken before the scan would not contain its hash
        and would retire it, signing the owner out right after a successful
        login (codex adversarial review). Reading immediately before the
        write does not make the race impossible — nothing short of a row
        lock would — but it narrows it to the gap between two adjacent
        statements.
        """
        live_hashes = _live_session_auth_hashes(alias, user_id)
        keep = [
            (pk, session_data)
            for pk, session_data, payload_hash in batch
            if payload_hash not in live_hashes
        ]
        if not keep:
            return 0
        # Measured from THIS write, not from the top of the sweep: the scan
        # is unbounded, so a grace stamped once could already have elapsed
        # by the time a later batch lands.
        expires_at = timezone.now() + timedelta(
            seconds=SESSION_SWEEP_REAP_GRACE_SECONDS
        )
        return _retire_matching(target, keep, empty_payload, expires_at)

    sweep_started = time.monotonic()
    retired = 0
    doomed = []
    # Keyset pagination, NOT `.iterator()`. Django's Postgres backend opens a
    # chunked cursor with `withhold=connection.autocommit`, and this function
    # now runs in the worker — normally in autocommit — so `.iterator()` here
    # declares a WITH HOLD cursor, which Postgres materialises in full (to
    # memory, then to temporary files) at commit and keeps materialised for
    # the life of the cursor. The `chunk_size` bounds what the CLIENT fetches
    # and nothing about that: the sweep is O(every unexpired row on the
    # platform), so an "obviously streaming" call would have moved an
    # unbounded allocation onto the shared production database, where the
    # cost lands on unrelated queries. It read as bounded, which is what made
    # it worth catching (codex adversarial review). A page at a time over the
    # primary-key index has no held state at all, and each page is its own
    # statement — which is the point of being out of the transaction.
    page = list(
        sessions.filter(pk__gt=after_key).order_by("pk")[:SESSION_SWEEP_FETCH_CHUNK]
    )
    next_key = page[-1][0] if len(page) == SESSION_SWEEP_FETCH_CHUNK else None
    for pk, session_data, expire_date in page:
        if expire_date <= now:
            continue
        payload = store.decode(session_data) or {}
        if payload.get("_auth_user_id") != wanted_id:
            continue
        doomed.append((pk, session_data, payload.get("_auth_user_hash")))
        if len(doomed) >= SESSION_SWEEP_EXPIRE_BATCH:
            retired += retire(doomed)
            doomed = []
    if doomed:
        retired += retire(doomed)

    elapsed = time.monotonic() - sweep_started
    logger.log(
        logging.WARNING if elapsed > SESSION_SWEEP_WARN_SECONDS else logging.INFO,
        "kt ownership-event session sweep for user %s: retired %d session(s) "
        "in %.3fs after commit",
        user_id,
        retired,
        elapsed,
    )
    return retired, next_key


def _read_account_epoch(user_id) -> "int | None":
    """The raw column value, or ``None`` if the row is gone."""
    # Imported here for the same reason as above: the user model must not be
    # bound before the app registry is populated.
    from django.contrib.auth import get_user_model

    return (
        get_user_model()
        ._default_manager.filter(pk=user_id)
        .values_list("kt_account_epoch", flat=True)
        .first()
    )


def _refuse(user_id, why: str):
    logger.warning("kt account_epoch %s for user=%s; refusing to issue", why, user_id)
    return signing.AuthorityUnavailable(signing.REASON_EPOCH_UNAVAILABLE)


def account_epoch_for(user_id) -> int:
    """The counter to sign for ``user_id``, or raise ``AuthorityUnavailable``.

    Read from the row, never from an authenticated ``request.user`` instance:
    authentication loads that instance at the start of the request, and an
    ownership event that commits while the request is in flight would otherwise
    be signed away — which is the replay window this counter exists to close,
    reopened by a cache.

    Refuses rather than substitutes, which is the whole lesson of. A row
    that has vanished, a zero (only reachable from a bad backfill or a hand
    edit), or a value at or above:data:`ACCOUNT_EPOCH_CEILING` all mean "there
    is no usable counter", and ``KT.md`` §4.5.4 requires an issuer in that
    position to refuse. Substituting a clock, a timestamp, or a default is
    exactly what created the bug.

    Pair it with:func:`confirm_account_epoch` — see there for what the read
    alone does *not* give you.
    """
    value = _read_account_epoch(user_id)
    if value is None:
        raise _refuse(user_id, "has no row")
    if not INITIAL_ACCOUNT_EPOCH <= value < ACCOUNT_EPOCH_CEILING:
        raise _refuse(user_id, f"is out of range ({value})")
    return value


def confirm_account_epoch(user_id, signed: int) -> None:
    """Refuse to hand out an assertion whose epoch went stale while it was signed.

    Raised by the codex adversarial review, and the point is worth stating
    plainly rather than leaving the comment at:func:`account_epoch_for` to
    overclaim — which would be the  mistake again, a confident sentence in
    front of a control that does not do what it says.

    Reading the row instead of ``request.user`` closes the *large* window: the
    whole request lifetime, plus whatever staleness the authenticated instance
    already carried. It does not make read-then-sign atomic. An ownership event
    can still commit between the read and the signature, and the assertion then
    carries an epoch the account has already moved past.

    This is the cheap half of the remedy: one indexed primary-key ``SELECT``
    after the signing, and the assertion is discarded rather than returned if
    the counter moved. It is deterministic for the case that matters — an event
    that has *committed* by the time we would answer — and it costs no lock.

    What it still cannot do, stated rather than papered over: an event that
    commits after this check is an event that happened after issuance, and no
    check-then-sign can order itself against a transaction that has not
    committed yet. Closing that would mean holding ``SELECT... FOR UPDATE`` on
    the Creator row across an Ed25519 signature, which serialises this endpoint
    against every other writer of that row — the ledger, the admin, every
    password change — for a window measured in microseconds. The residual
    exposure is bounded three ways: the caller already held an authenticated
    session and could have obtained the same assertion a moment earlier, the
    assertion expires inside ``ttl_ms()``, and it authorises nothing without the
    identity key it names.
    """
    current = _read_account_epoch(user_id)
    if current is None:
        raise _refuse(user_id, "row vanished during issuance")
    if current != signed:
        raise _refuse(
            user_id, f"moved during issuance ({signed} -> {current})"
        )


class CredentialAdminMixin:
    """``ModelAdmin`` mixin for a model that grants a Creator a way to sign in.

    ``TwitterProfile``, ``ZcashIdentity`` and a **confirmed** ``Email`` are all
    credentials with their own admin, and staff reassigning, repointing,
    un-confirming or deleting one is a supported operational repair that reaches
    none of the HTTP routes. Without this the ownership counter is wired to the
    front door and open at the back — raised by the codex adversarial review.

    It applies the same **revoke-only** rule as the rest of this module, by
    *direction* rather than by field membership, which is the distinction the
    first draft got wrong (also codex):

    * reassigning a credential increments the **losing** Creator only. The
      gaining one merely acquired a principal, which invalidates nothing;
    * a column in:attr:`revoking_fields` counts on any change, because those
      identify the credential and changing one retires the old value;
    * a column in:attr:`revoking_switches` counts only on truthy → falsy — a
      permission being withdrawn. A disable-then-re-enable repair cycle spends
      one epoch of the log's A18b budget, not two;
    * deleting counts, and creating one by hand counts for nobody;
    * and none of it counts for a row that was not granting access in the first
      place — see:meth:`grants_access`, which is how an unconfirmed ``Email``
      stays outside the count.

    Admin reassignment is an operator repair, not a user-side relink. This
    mixin revokes the losing account but does not rewrite the gaining account's
    identity epoch or age. After moving a Twitter or Zcash identity, staff must
    set ``linked_at_epoch`` to the gaining Creator's current epoch; for Twitter,
    ``created_at`` should also reflect the association time. Until then the new
    account may refuse it as a future-epoch row or select it by its old age.
    """

    #Name of the ``ForeignKey``/``OneToOneField`` to ``Creator``.
    creator_field = "creator"
    #Identifier columns: any change retires the previous value.
    revoking_fields: frozenset = frozenset()
    #Permission columns: only truthy → falsy revokes. A boolean flag, or a
    #``confirmed_at`` timestamp being cleared.
    revoking_switches: frozenset = frozenset()
    #Extra columns:meth:`grants_access` needs that are not named above.
    access_fields: frozenset = frozenset()

    def grants_access(self, values: dict) -> bool:
        """Could the row these values describe sign somebody in?

        Default yes: a linked provider identity is a credential the moment it
        exists. Override where existing is not enough — an ``Email`` row is a
        recovery credential only once it is confirmed, and revoking something
        that never granted access counts for nothing.
        """
        return True

    def _tracked_columns(self):
        return sorted(
            frozenset(self.revoking_fields)
            | frozenset(self.revoking_switches)
            | frozenset(self.access_fields)
        )

    def _previous_row(self, obj):
        """The stored values of the tracked columns, before this save."""
        return (
            type(obj)
            ._default_manager.filter(pk=obj.pk)
            .values(f"{self.creator_field}_id", *self._tracked_columns())
            .first()
        )

    def _values_of(self, obj):
        values = {
            f"{self.creator_field}_id": getattr(obj, f"{self.creator_field}_id")
        }
        for name in self._tracked_columns():
            values[name] = getattr(obj, name)
        return values

    def save_model(self, request, obj, form, change):
        previous = self._previous_row(obj) if change else None
        super().save_model(request, obj, form, change)
        if previous is None:
            # A credential created by hand ADDS access it did not have.
            return
        if not self.grants_access(previous):
            # It was not a credential before this save, so nothing was revoked.
            return

        changed = frozenset(form.changed_data)
        revoked = self.creator_field in changed or bool(
            changed & frozenset(self.revoking_fields)
        )
        for switch in changed & frozenset(self.revoking_switches):
            if previous[switch] and not getattr(obj, switch):
                revoked = True

        # The LOSING account is the one whose outstanding assertions must die.
        losing_id = previous[f"{self.creator_field}_id"]
        if revoked and losing_id is not None:
            bump_account_epoch(losing_id, event=EVENT_CREDENTIAL_ADMIN_EDIT)

    def delete_model(self, request, obj):
        values = self._values_of(obj)
        super().delete_model(request, obj)
        user_id = values[f"{self.creator_field}_id"]
        if user_id is not None and self.grants_access(values):
            bump_account_epoch(user_id, event=EVENT_CREDENTIAL_ADMIN_EDIT)

    def delete_queryset(self, request, queryset):
        # The changelist's bulk "delete selected" action, which does NOT call
        # `delete_model` -- the gap that makes a per-object hook alone a lie.
        using = router.db_for_write(queryset.model)
        # `using` is resolved for the CREDENTIAL model and then forced onto the
        # Creator, AuthToken and Session writes as well. Deliberate: on this
        # single-database setup it is identical to DEFAULT_DB_ALIAS, and if
        # routers ever split models across aliases the revocation MUST land in
        # the same database as the credential rows it guards, not wherever the
        # other models happen to resolve.
        rows = list(
            queryset.values(f"{self.creator_field}_id", *self._tracked_columns())
        )
        revoked_from = {
            row[f"{self.creator_field}_id"]
            for row in rows
            if self.grants_access(row)
        }
        # NO early return when `revoked_from` is empty. An earlier draft did
        # `if not revoked_from: return`, which skipped `super().delete_queryset`
        # itself -- so bulk-deleting rows that grant nobody access silently
        # deleted NOTHING while Django's action reported success. Every
        # `Email` row that has never been confirmed is exactly that case
        # (`EmailAdmin.grants_access` returns False for `confirmed_at is
        # None`), so staff removing a suspicious pending address during a
        # remediation would have been told it was gone while its confirmation
        # token stayed usable until expiry. Found by the codex adversarial
        # review. The delete is unconditional; only the bumps are conditional.
        #
        # Stock Django does NOT wrap the delete_selected action in a
        # transaction, so without this block a mid-pass crash leaves exactly
        # the state this module exists to prevent: credential rows deleted,
        # epochs unmoved, Knox tokens still valid, and no way to tell which
        # accounts were missed. The atomic encloses BOTH halves — the
        # credential deletion and every bump — so the bulk action is
        # all-or-nothing. (The bumps being consistent with each other alone
        # would still have shipped the bug: rows gone + epoch unmoved.)
        #
        # One operational wart, worth naming rather than discovering: each bump
        # queues its own socket-disconnect on_commit callback, and they run
        # SERIALLY after this block commits. With Redis unreachable each one
        # costs `socket_connect_timeout` (5s -- see channel_layer_config), so
        # an N-account bulk delete can leave the admin request hanging for
        # ~5N seconds against gunicorn's 600s ceiling. Nothing is lost when it
        # happens -- the revocation has already committed and each failure is
        # logged at ERROR -- but the staff member sees a hung page. Raised by
        # an independent review of.
        with transaction.atomic(using=using):
            super().delete_queryset(request, queryset)
            # Filter BEFORE sorting: `TwitterProfile.creator` is nullable, so
            # `revoked_from` can legitimately contain None alongside real ids,
            # and sorted() over that mixed set raises TypeError -- an admin 500
            # AFTER the rows are already gone (without the enclosing atomic).
            for user_id in sorted(uid for uid in revoked_from if uid is not None):
                bump_account_epoch(
                    user_id, event=EVENT_CREDENTIAL_ADMIN_EDIT, using=using
                )
