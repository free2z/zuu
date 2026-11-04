"""Messaging handles: which free2z account owns which E2EE handle.

``dj.apps.ktauth`` signs a ``HandleAssertion`` saying "this account owns this
handle". Until this app existed, *which* handle an account owned was guessed
from the username on every request (``lowercase(username)``), and that guess
was not a function: production holds case-variant duplicate usernames, so two
real accounts could fold onto one handle. The authority refused both. This app
replaces the guess with a stored, database-unique binding.

The policy (free2z/zuu#1022, "Handles" working assumption)
-----------------------------------------------------------

* A handle is ``^[a-z0-9_]{1,30}$``, ASCII, compared as bytes. The same rule
  as ``tauri-plugin-f2zmsg/src/handle.rs`` and ``ktauth.signing.HANDLE_RE``.
* **An eligible account gets its lowercased username reserved.** Existing
  accounts get it from migration ``0002``; accounts created afterwards get it
  from a ``post_save`` receiver (``signals.py``), with
  :func:`reservation.ensure_username_handle` as the fallback on the POST paths
  that need a handle.
* **In a case-collision group the earliest-created account keeps the
  lowercase handle** (``date_joined``, then ``pk``). The others are left
  unclaimed and must claim a different one.
* **Reserved words are never assigned automatically** and cannot be claimed
  (``policy.RESERVED_HANDLES``). An existing binding is never revoked by
  adding a word to that list.
* **An ineligible or unclaimed account claims one handle, once.**
  ``POST /api/e2ee/handle/claim/``.
* **A bound handle is permanent for this internal phase.** No rename, no
  release, no reassignment through any API. Renaming the username does not
  move it. If an account is deleted the row stays, with ``user`` set to NULL
  and ``status = retired``, so the handle is never handed to somebody else:
  the key-transparency log has already published a key for it, and a
  second owner would be an impersonation the log cannot tell apart from a
  reset. Changing that is a product decision, not a code change.
* Uniqueness is case-insensitive **in the database**
  (``UniqueConstraint(Lower("handle"))``), and a ``CheckConstraint`` pins the
  charset, so no writer, including a shell session, can store a handle the
  directory could not hold.

What this app does not do
-------------------------

It does not sign anything; ``ktauth`` does, and reads the binding from here.
It does not talk to the key-transparency log. It keeps no record of identity
keys: an assertion is still a signature over live state, and ``ktauth`` still
has no models (``ktauth/tests/test_app_shape.py``).
"""
