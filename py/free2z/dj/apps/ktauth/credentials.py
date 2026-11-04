"""Use-time revocation: the half of an ownership event a sweep cannot do.

``epoch.bump_account_epoch`` revokes by **deleting rows** — Knox tokens,
session rows — and marking reset links spent. That is the durable half
and it is transactional with the credential change. It is also, by
construction, a **point-in-time sweep**: it can only delete what exists when it
enumerates. Three credential families defeated it, and
they defeat it in two different ways:

* a credential **committed after the enumeration** — a login already in flight
  . No larger sweep reaches it; the row is not there to be seen.
* a credential the sweep deliberately **does not touch** — a pending
  ``Email.token`` confirmation link, a linked social/Zcash/Twitter
  identity. Adding them to the sweep would close  and  while
  leaving the  race open on each of them in turn, and (for the identities)
  would delete a passwordless creator's only way to sign in.

This module is the other half: **every one of those credentials carries the
account epoch it was minted against, and the thing that validates it compares
that stamp against the account's current epoch.** A stale stamp is refused.
Nothing is enumerated, nothing is deleted, and there is no window — a check
made at use time cannot be raced by a write that happened before the use.

Why a counter and not a timestamp, one more time
------------------------------------------------

A credential issued *during* the revocation window has a **later** creation
time than the event that should kill it, so "created before the last ownership
event" is exactly the wrong test — it lets the racing credential through, which
is the bug. What identifies the racing credential is that the **authentication
that produced it** saw the old epoch. So the stamp must be the epoch read in
the same database snapshot that validated the authenticating credential, and
the comparison is equality against the account's current counter.

That snapshot requirement is load-bearing and easy to get wrong. Reading the
identity row and then reading the Creator row are **two statements and two
snapshots** under READ COMMITTED: an unlink committing between them yields a
stamp that is already the new epoch, and the token survives. The issuers here
therefore read both in ONE query (``select_related('creator')``), or take the
epoch from ``request.user``, which authentication loaded from the same row that
validated the request's own credential.

What this module does not claim
-------------------------------

It bounds **credentials**, not **requests**. A request that authenticated a
microsecond before an ownership event committed still runs to completion — DRF
resolves ``request.user`` once, at the start. So an attacker whose write was
already in flight can still finish that one write; what they cannot do is walk
away from it holding anything that authenticates again. Closing that would mean
re-validating the caller's credential at every write, which is a different
change with a different cost. Stated here rather than left to be assumed.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


# These identity models live in separate apps and do not share a creation
# column.  The order is only a final tie-breaker for rows created in the same
# timestamp tick; it is not a trust ranking between providers.
_PASSWORDLESS_IDENTITY_PROVIDER_ORDER = {
    "social": 0,
    "twitter": 1,
    "zcash": 2,
    "passkey": 3,
}


def _passwordless_identity_records(creator_id, current_epoch, using=None):
    """Return comparable records for every login identity on an account.

    ``linked_at_epoch`` records the last ownership epoch at which the identity
    was linked.  A row that already lost fallback selection is excluded by its
    durable ``fallback_rejected_at_epoch`` marker; it must never become
    trusted again merely because rows ahead of it were unlinked.  The model
    timestamps are the age signal among the remaining rows.

    Rows from a future epoch are excluded: the caller refuses those as
    anomalous, and allowing one to win fallback ranking could hide a valid
    stale recovery identity. Unconfigured methods remain in the returned set
    so an event can durably reject them, but they cannot be selected as the
    account's fallback.

    The timestamp fields have different historical names.  They are populated
    by the database on creation, except that an unowned legacy Twitter row has
    its timestamp reset when it is first adopted because it granted no login
    access before that association.  A stable provider order and provider
    identifier make equal timestamps deterministic.  This remains a heuristic:
    imported or manually corrected timestamps, and already-adopted historical
    Twitter rows whose association time was never recorded, can make the
    selected identity not be the account-origin identity.  Choosing one
    deterministic candidate is still safer than allowing every stale identity
    to mint a fresh credential.  A missing timestamp is sorted last; the
    production fields are non-null, so that case is only a defensive boundary
    for damaged or hand-imported data.

    The ownership event reads the provider tables as separate statements. The
    ownership-event caller has already advanced and locked the Creator row,
    and user-facing identity-set mutations take that same lock, so these
    statements cannot observe a supported link/removal half-way through the
    event decision. Staff reassignment through ``CredentialAdminMixin`` is an
    operator repair path with separate restamping instructions in that mixin's
    docstring. Login-time callers use only the identity's own durable marker
    and never query the other provider tables or choose a new fallback.
    """
    from dj.apps.social.models import SocialIdentity
    from dj.apps.twitter.models import TwitterProfile
    from dj.apps.zauth.models import ZcashIdentity
    from dj.apps.identity.models import WebAuthnCredential
    from django.conf import settings
    from dj.apps.social.clients import configured_providers

    configured_social = configured_providers()
    twitter_configured = all(
        (getattr(settings, key, "") or "").strip()
        for key in ("TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET")
    )
    passkey_configured = (
        getattr(settings, "IDENTITY_PASSKEY_SIGNIN_ENABLED", False) is True
        and bool((getattr(settings, "WEBAUTHN_RP_ID", "") or "").strip())
    )

    records = []
    for (
        provider,
        model,
        timestamp_field,
        identifier_field,
        eligibility_field,
    ) in (
        ("social", SocialIdentity, "verified_at", "provider_uid", None),
        ("twitter", TwitterProfile, "created_at", "twitter_id", "allow_login"),
        ("zcash", ZcashIdentity, "created_at", "zcash_address", None),
        (
            "passkey", WebAuthnCredential, "created_at", "credential_id", None,
        ),
    ):
        fields = [
            "pk",
            timestamp_field,
            identifier_field,
            "linked_at_epoch",
            "fallback_rejected_at_epoch",
        ]
        if provider == "social":
            fields.append("provider")
        elif provider == "passkey":
            fields.append("rp_id")
        if eligibility_field is not None:
            fields.append(eligibility_field)
        queryset = model.objects.using(using) if using is not None else model.objects
        for row in queryset.filter(
            creator_id=creator_id, linked_at_epoch__lte=current_epoch,
        ).values(*fields):
            # A disabled Twitter profile cannot be the account's surviving
            # passwordless login.  Its disable event moves the account epoch;
            # counting it here would make every still-usable identity look
            # like a lower-ranked stale credential.
            if row["fallback_rejected_at_epoch"] is not None:
                continue
            if provider == "social":
                eligible = configured_social.get(row["provider"]) is True
            elif provider == "twitter":
                eligible = bool(row[eligibility_field]) and twitter_configured
            elif provider == "passkey":
                eligible = (
                    passkey_configured
                    and row["rp_id"].strip().lower()
                    == (getattr(settings, "WEBAUTHN_RP_ID", "") or "")
                    .strip().lower()
                )
            else:
                eligible = True
            records.append({
                "marker": (provider, row["pk"]),
                "linked_at_epoch": row["linked_at_epoch"],
                "timestamp": row[timestamp_field],
                "eligible": eligible,
                "sort_key": (
                    row[timestamp_field] is None,
                    row[timestamp_field],
                    _PASSWORDLESS_IDENTITY_PROVIDER_ORDER[provider],
                    row[identifier_field],
                    row["pk"],
                ),
            })
    return records


def _is_passwordless_fallback_identity(identity, creator_id, current_epoch) -> bool:
    """Whether ``identity`` is the durable stale fallback selected at the event.

    The age ranking belongs exclusively to:func:`mark_passwordless_fallbacks`,
    which runs in the ownership-event transaction.  Login must not rank the
    rows that happen to remain: doing so can promote a dormant planted row or
    a row that was already rejected after the selected fallback is removed.
    After event-time marking, at most one eligible stale row is unmarked. The
    identity row's own rejection marker is the entire decision.
    """
    linked_at = getattr(identity, "linked_at_epoch", None)
    if linked_at is None or linked_at >= current_epoch:
        return False
    # Ownership events durably choose the sole stale fallback and stamp every
    # other stale method, so login uses only the row it was already given.
    # This keeps the identity check in the same SELECT snapshot as Creator
    # authentication, avoids three follow-up table reads on every login, and
    # prevents READ COMMITTED races with concurrent unlinks.
    return getattr(identity, "fallback_rejected_at_epoch", None) is None


def mark_passwordless_fallbacks(user_id, current_epoch, using=None) -> int:
    """Freeze the fallback decision made by an ownership event.

    A lazy decision at the next login is unsafe: unlinking the identity that
    happened to win can otherwise rehabilitate a dormant identity that was
    planted before the event. At the event boundary, choose the oldest
    eligible stale identity once and durably reject every other stale one.
    Accounts with a usable password do not need a fallback and are left alone.
    Configured methods only can win; unavailable methods are marked rejected so
    enabling a provider later cannot silently restore an old stale login.
    """
    from django.contrib.auth import get_user_model
    from dj.apps.social.models import SocialIdentity
    from dj.apps.twitter.models import TwitterProfile
    from dj.apps.zauth.models import ZcashIdentity
    from dj.apps.identity.models import WebAuthnCredential

    manager = get_user_model()._default_manager
    if using is not None:
        manager = manager.using(using)
    user = manager.filter(pk=user_id).first()
    if user is None or user.has_usable_password():
        return 0

    records = [
        record
        for record in _passwordless_identity_records(
            user_id, current_epoch, using=using,
        )
        if record["linked_at_epoch"] < current_epoch
    ]
    if not records:
        return 0
    eligible = [record for record in records if record["eligible"]]
    if not eligible:
        # An unavailable provider is not evidence that every stale method
        # should be permanently rejected. Leave the set untouched when there
        # is no eligible fallback to preserve.
        return 0
    winner = min(eligible, key=lambda record: record["sort_key"])["marker"]
    models = {
        "social": SocialIdentity,
        "twitter": TwitterProfile,
        "zcash": ZcashIdentity,
        "passkey": WebAuthnCredential,
    }
    marked = 0
    for provider, identity_pk in (
        record["marker"]
        for record in records
        if record["marker"] != winner
    ):
        queryset = models[provider].objects
        if using is not None:
            queryset = queryset.using(using)
        marked += queryset.filter(
            pk=identity_pk,
            creator_id=user_id,
            fallback_rejected_at_epoch__isnull=True,
        ).update(fallback_rejected_at_epoch=current_epoch)
    return marked


def has_unmarked_passwordless_survivor(
    user,
    *,
    exclude_social_pk=None,
    exclude_twitter_pk=None,
    exclude_zcash_pk=None,
    exclude_passkey_pk=None,
) -> bool:
    """Whether a passwordless account retains an unmarked login identity."""
    if user.has_usable_password():
        return True

    from dj.apps.social.models import SocialIdentity
    from dj.apps.twitter.models import TwitterProfile
    from dj.apps.zauth.models import ZcashIdentity
    from dj.apps.identity.models import WebAuthnCredential

    social = SocialIdentity.objects.filter(
        creator_id=user.pk,
        linked_at_epoch__lte=user.kt_account_epoch,
        fallback_rejected_at_epoch__isnull=True,
    )
    if exclude_social_pk is not None:
        social = social.exclude(pk=exclude_social_pk)
    if social.exists():
        return True

    twitter = TwitterProfile.objects.filter(
        creator_id=user.pk,
        linked_at_epoch__lte=user.kt_account_epoch,
        allow_login=True,
        fallback_rejected_at_epoch__isnull=True,
    )
    if exclude_twitter_pk is not None:
        twitter = twitter.exclude(pk=exclude_twitter_pk)
    if twitter.exists():
        return True

    zcash = ZcashIdentity.objects.filter(
        creator_id=user.pk,
        linked_at_epoch__lte=user.kt_account_epoch,
        fallback_rejected_at_epoch__isnull=True,
    )
    if exclude_zcash_pk is not None:
        zcash = zcash.exclude(pk=exclude_zcash_pk)
    if zcash.exists():
        return True

    passkeys = WebAuthnCredential.objects.filter(
        creator_id=user.pk,
        linked_at_epoch__lte=user.kt_account_epoch,
        fallback_rejected_at_epoch__isnull=True,
    )
    if exclude_passkey_pk is not None:
        passkeys = passkeys.exclude(pk=exclude_passkey_pk)
    return passkeys.exists()


PASSWORDLESS_LAST_IDENTITY_DETAIL = (
    "Reconnect another login method before removing this one."
)


def account_epoch_of(user_id, using=None) -> "int | None":
    """The account's current ``kt_account_epoch``, read from the row.

    Never from a cached ``request.user``: authentication loads that instance at
    the start of the request, so comparing a stamp against it would compare two
    values that are stale together and always agree.
    """
    from django.contrib.auth import get_user_model

    rows = get_user_model()._default_manager
    if using is not None:
        rows = rows.using(using)
    return (
        rows.filter(pk=user_id)
        .values_list("kt_account_epoch", flat=True)
        .first()
    )


def stamp_issued_token(auth_token, account_epoch: int) -> None:
    """Record the epoch ``auth_token`` was minted against.

    Called twice for a token issued by a login: once by the ``post_save``
    receiver below with the epoch as it stands in the database *now*, and then
    again by the issuer with the epoch from its own validating snapshot. The
    second write is the one that matters and it can only ever be **lower or
    equal** — the receiver's read happens later in wall-clock time, so if it
    differs at all it differs because an ownership event landed in between,
    which is precisely the case the issuer's value must win.
    """
    from dj.apps.g12f.models.credentials import IssuedTokenEpoch

    IssuedTokenEpoch.objects.update_or_create(
        token=auth_token, defaults={"account_epoch": account_epoch},
    )


def issue_bearer_token(user, account_epoch: int):
    """``AuthToken.objects.create(user)`` plus the stamp, as one step.

    Every login path that mints a Knox token goes through here so that the
    stamp cannot be forgotten at a call site — the failure mode  warns
    about is two lists that are supposed to be the same list.

    ``account_epoch`` must be the value read in the SAME snapshot that
    validated the authenticating credential. Passing a freshly read one is not
    a safe convenience: it is the bug (see the module docstring).
    """
    from knox.models import AuthToken

    instance, raw_token = AuthToken.objects.create(user)
    stamp_issued_token(instance, account_epoch)
    return instance, raw_token


def receive_auth_token_saved(sender, instance, created, **kwargs):
    """Give every Knox token a stamp, whoever created it.

    ``post_save`` rather than a required argument to a helper, so that a token
    minted by code this module has never heard of still gets a stamp: a token
    with no stamp is REFUSED by:mod:`dj.apps.ktauth.authentication`, and a
    silent 401 on a credential the platform just handed out is a worse failure
    than the one being prevented.

    **It is a floor, not the mechanism.** The value read here is the counter as
    of *after* the row was written, which is one statement too late for the
     interleaving: an issuer that authenticated at epoch N, was overtaken
    by an ownership event, and only then inserted, would be stamped N+1 and
    survive. So every issuer that actually exists overrides it with the epoch
    from its own validating snapshot — ``social``, ``zauth``, and
    ``dj/free2z/urls.py``'s ``LoginView``, which wraps knox's own
    ``/api/token/login/`` for exactly this reason. That last one was missing
    until the codex adversarial review of  pointed out that "knox mints it
    for us" is not the same as "it is stamped correctly".

    Fires on creation only: knox re-saves the row to extend ``expiry`` on
    almost every authenticated request (``AUTO_REFRESH``), and re-stamping
    there would silently repair a stale token into a valid one on first use.
    """
    if not created:
        return
    account_epoch = account_epoch_of(instance.user_id)
    if account_epoch is None:  # pragma: no cover - FK makes this unreachable
        logger.error(
            "kt: cannot stamp a bearer token for missing user %s",
            instance.user_id,
        )
        return
    stamp_issued_token(instance, account_epoch)


def identity_can_authenticate(identity, creator) -> bool:
    """May a linked provider identity still complete a login?

    ``identity`` is a ``SocialIdentity``, ``ZcashIdentity`` or
    ``TwitterProfile``; ``creator`` is the account it points at, **read in the
    same query as the identity** so the two answers come from one snapshot.

    The rule, and the reason it is not simply "an ownership event unlinks
    everything":

    * an identity linked at the account's current epoch is **current** — it was
      linked either before any ownership event ever happened, or by an
      authenticated session that survives the most recent one. It signs in;
    * an identity stamped with an older epoch was linked **before an ownership
      event that has since evicted whoever was holding the account**.
      excluded identities on the grounds that they are "the owner's own login
      methods", which is right for an identity the owner linked and wrong for
      one an attacker planted, and the row cannot tell them apart. So the
      conservative direction wins: it stops signing people in, and the owner
      re-links it in one click from an authenticated session — which now
      requires the new password. Nothing is deleted, so an owner who re-links
      gets the same identity back rather than a new account;
    * **unless the account has no usable password**, in which case one ranked
      stale identity is kept as a last-resort login and the others are refused.
      Refusing every identity is account destruction (and the objection
       raises against the obvious fix). Among identities not already
      refused, ranking uses the available cross-provider age signals:
      ``SocialIdentity.verified_at``, ``TwitterProfile.created_at`` and
      ``ZcashIdentity.created_at``. Equal values are broken by explicit
      provider order and stable provider identifier. This is deterministic,
      and a stale identity that loses is durably refused. An explicit
      authenticated re-link clears that refusal and establishes fresh
      ownership evidence. A stale identity other than the selected candidate
      cannot mint a current-epoch credential.

      A future-epoch or missing-epoch identity is refused even on a passwordless
      account. Such a row is anomalous rather than evidence of ownership, and
      allowing it would turn a data inconsistency into an authentication bypass.

    Race-free for the same reason the token stamp is: an identity linked
    concurrently with an ownership event carries the pre-event epoch (the
    linking request stamps from ``request.user``, loaded when its own
    credential was validated), so the event's commit makes it stale, whichever
    order the two transactions commit in.
    """
    # A durable fallback rejection is stronger than the linked epoch.  The
    # marker records an ownership decision made for this identity, so it must
    # not be bypassed by a later route (or damaged data) presenting the row as
    # current.  Explicit authenticated re-linking clears the marker before
    # the identity can be used again.
    if getattr(identity, "fallback_rejected_at_epoch", None) is not None:
        logger.warning(
            "kt: refusing a durably rejected %s login for account %s "
            "(rejected at epoch %s)",
            type(identity).__name__,
            creator.pk,
            identity.fallback_rejected_at_epoch,
        )
        return False

    linked_at = getattr(identity, "linked_at_epoch", None)
    if linked_at == creator.kt_account_epoch:
        return True
    if linked_at is None or linked_at > creator.kt_account_epoch:
        logger.warning(
            "kt: refusing anomalous %s login for account %s "
            "(identity epoch %s, account epoch %s)",
            type(identity).__name__,
            creator.pk,
            linked_at,
            creator.kt_account_epoch,
        )
        return False
    if not creator.has_usable_password() and _is_passwordless_fallback_identity(
        identity, creator.pk, creator.kt_account_epoch,
    ):
        logger.warning(
            "kt: allowing the ranked stale-epoch %s login for passwordless "
            "account %s (identity epoch %s, account epoch %s); newer "
            "identities are refused (#1602)",
            type(identity).__name__,
            creator.pk,
            linked_at,
            creator.kt_account_epoch,
        )
        return True
    logger.warning(
        "kt: refusing a %s login for account %s: the identity was linked at "
        "epoch %s and the account is at %s (#1574)",
        type(identity).__name__,
        creator.pk,
        linked_at,
        creator.kt_account_epoch,
    )
    return False


#What a login route tells a caller whose identity is stale. Deliberately
#actionable and deliberately identical for every provider: it is not a
#failure of the provider handshake, and a caller who is told "authorization
#failed" will retry the handshake forever.
STALE_IDENTITY_DETAIL = (
    "This login method was disconnected by a recent account-security change. "
    "Sign in with another working login, then reconnect it."
)


def purge_unusable_tokens(user) -> int:
    """Delete ``user``'s Knox rows that the RUNNING knox cannot authenticate.

    Why this exists, and why it is NOT a data migration
    ---------------------------------------------------
    The knox 4.2.0 -> 5.1.0 upgrade invalidated every token issued before it
    (``TOKEN_KEY_LENGTH`` 8 -> 15 makes the lookup match zero rows, and
    ``hash_token`` changed), and ``TOKEN_LIMIT_PER_USER`` counts rows that are
    merely UNEXPIRED. So a user holding five dead rows is refused a
    replacement with a 403 and cannot clear them, because both logout routes
    need a working token. It self-heals only at ``TOKEN_TTL`` -- up to ten
    hours.

    **Reachability, measured rather than assumed.** ``/api/token/login/``
    authenticates with SessionAuthentication + this project's Knox
    authenticator and no BasicAuthentication, so the cap 403 is only ever
    served to a caller who authenticated SUCCESSFULLY -- a session cookie, or
    an already-valid 5.x token. A bearer-only client holding a dead legacy
    token fails authentication and never reaches ``post()`` at all, so this
    function cannot help it and does not claim to. The codex adversarial
    review caught an earlier revision that asserted the opposite with
    ``force_authenticate()``; ``dj/apps/g12f/test_knox_token_purge.py`` now
    pins the real behaviour.

    **How such a client gets back in, stated precisely**, because a later
    round of the same review caught this paragraph overclaiming too. Only
    ``/api/auth/social/`` and ``/api/auth/zcash/`` mint a Knox token without
    one (they call ``issue_bearer_token``, which does not enforce the cap) --
    grep confirms those are its only call sites. ``/api/auth/login/`` is NOT
    a Knox issuer: ``REST_AUTH['TOKEN_MODEL']`` is None, so it
    issues no bearer token at all (it used to return an inert
    ``rest_framework.authtoken`` key, which
    ``emails/test_password_events_revoke_tokens.py`` still asserts does not
    authenticate here). So a PASSWORD-only integration's only route to a
    new Knox token is the session cookie that same login sets, followed by
    ``/api/token/login/`` -- which is exactly the caller this function
    unblocks, and the reason it is worth having.

    The obvious fix is a ``RunPython`` that empties the table at upgrade time.
    It is the wrong one, and this repo's own deploy code says why
    (``bin/prod-healthcheck.sh``):

        Rolling back reverts CODE only, not the schema -- safe as long as
        migrations stay backward-compatible (expand/contract). A destructive
        migration would need its own gated follow-up so rollback remains safe.

    ``manage.py migrate`` runs BEFORE ``bazel-apply``, so such a migration
    deletes every bearer credential at a point where 5.1.0 is not serving yet
    and may never serve: any later build step can fail, and the auto-rollback
    restores the previous IMAGE without rewinding migration history. Those
    tokens were still valid on the 4.2.0 pods that keep running, so the
    "fix" would log out every API client for a release that never happened.
    Being one-shot, it is also both too late (rows minted after it is recorded
    as applied are never cleaned) and too eager (after the documented
    ``migrate g12f 0107`` rollback it re-runs and deletes live 5.x tokens).
    Both halves came out of the codex adversarial review of this change.

    Here, in the running code, neither problem exists. It cannot run unless
    5.x is actually serving, because it IS 5.x; it runs at the exact moment a
    user would otherwise be refused; and it is idempotent, so it is safe on
    every login forever.

    Why the shape test, rather than deleting everything
    ---------------------------------------------------
    Live 5.x tokens exist by the time this runs, and deleting those would
    sign the user out of every other device on every single login. So it
    removes exactly the rows that provably cannot work, and nothing else.

    ``token_key`` is written as ``token[:CONSTANTS.TOKEN_KEY_LENGTH]``, so a
    row minted by the RUNNING knox always has exactly that length (the token
    is 64 hex characters, so the slice is never short), while a row minted
    under a different key length never does. That makes length an exact test
    for "this row was written by a knox whose lookup can never match it" —
    checked against the constant rather than a hard-coded 8 or 15, so it stays
    correct through a future change instead of encoding today's one.

    It is deliberately NOT a digest or expiry test: an unexpired row with the
    right key length is one the running code might genuinely authenticate, and
    guessing about those is how a cleanup starts revoking live credentials.
    """
    from django.db.models.functions import Length
    from knox.models import get_token_model
    from knox.settings import CONSTANTS

    tokens = get_token_model()._default_manager.filter(user=user)
    # Collected as ids first: `delete()` must run on a plain queryset so
    # Django's collector cascades the `IssuedTokenEpoch` stamps with it (the
    # database constraint is NO ACTION DEFERRABLE, so the cascade is Python's,
    # not the database's).
    stale_ids = list(
        tokens.annotate(_key_length=Length("token_key"))
        .exclude(_key_length=CONSTANTS.TOKEN_KEY_LENGTH)
        .values_list("pk", flat=True)
    )
    if not stale_ids:
        return 0
    logger.warning(
        "purging %d Knox token(s) the running knox cannot authenticate "
        "for user %s",
        len(stale_ids),
        user.pk,
    )
    tokens.filter(pk__in=stale_ids).delete()
    return len(stale_ids)
