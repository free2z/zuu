"""The project's Knox authenticator: a bearer token is checked against the epoch.

``knox.auth.TokenAuthentication`` answers one question — does this string hash
to a stored digest that has not expired. It has no opinion about whether the
account has since evicted whoever holds it, and it cannot have one, because the
account epoch is this platform's concept.

Everything else about the credential is knox's and stays knox's: the constant-
time digest comparison, the expiry sweep, ``AUTO_REFRESH``. This subclass adds
exactly one check, in ``validate_user`` — knox's own extension point, reached
only after the presented token has already been proven genuine.

Why the check lives HERE and not in the login views
---------------------------------------------------

An issuer can only ever ask "has an ownership event committed *yet*", and the
answer is allowed to change one microsecond later. That is: the login
that read its identity before the sweep inserts its token after it, and no
amount of re-reading at issuance orders those two transactions against each
other. A check at **use** time has no such window — by the time the token is
presented, the event either committed or it did not, and if it did the counter
says so. See ``dj.apps.g12f.models.credentials`` for the full argument.

The refusal is a hard 401, and what happens to the row depends on WHY:

* a stamp **behind** the account can never come back into agreement --
  ``kt_account_epoch`` only ever increases (``dj.apps.ktauth.epoch``) -- so the
  row is deleted rather than left to be re-refused forever;
* a **missing** stamp is a different fact and is not treated as the same one.
  It is unreachable through the ORM (a ``post_save`` receiver stamps every
  token), but a rolling deploy can produce it: an old pod mints a token after
  ``migrate`` has run and a new pod sees no stamp. Refused, because admitting a
  credential this deployment cannot judge is the  mistake, but not
  destroyed, and logged at ERROR so a steady-state occurrence is visible.
"""

import logging

from django.utils import timezone
from django.utils.translation import gettext_lazy as _
from knox.auth import TokenAuthentication
from rest_framework import exceptions

from dj.util.middleware import run_after_request_transaction


logger = logging.getLogger(__name__)


class AccountEpochTokenAuthentication(TokenAuthentication):
    """Knox bearer authentication that refuses a token the account has outlived.

    ``super().validate_user`` runs first and unchanged, so an inactive user is
    still refused for being inactive rather than for its epoch.

    The account epoch is read from the ROW here, never from
    ``auth_token.user.kt_account_epoch``: knox resolves that FK lazily, so it
    happens to be a fresh read today, and "it happens to be fresh today" is not
    a property to build a revocation on. It is read in the same statement as
    the stamp, so the two values cannot come from different instants.

    A token with **no stamp** is refused rather than admitted. Every token gets
    one from ``ktauth.credentials.receive_auth_token_saved``, which is wired to
    ``post_save`` on the model itself, so the only way to reach this branch is
    a row written around the ORM. Defaulting it to "valid" would mean a raw
    INSERT — or a future issuer that bypasses the model — silently minting
    credentials this check cannot see, which is the  failure mode: a
    control that substitutes a value when it cannot read one enforces nothing.
    """

    def _cleanup_token(self, auth_token):
        """Knox's expiry sweep, made durable across a refused write.

        knox deletes the presented token when it has expired, and returns
        True so ``authenticate_credentials`` goes on to raise
        ``AuthenticationFailed``. On a POST/PUT/PATCH that delete runs inside
        AtomicMiddleware's block, which the raise rolls back -- so the expired
        row would come back and be swept again on every retry.

        knox's own code still runs unchanged (it also sends ``token_expired``
        and sweeps the user's OTHER expired tokens); this only re-issues the
        presented token's delete after the request transaction has ended,
        when it is guaranteed to stick. Keyed on the primary key and on
        ``expiry`` still being in the past, so it is idempotent and can never
        remove a row that was renewed in between.
        """
        # Captured BEFORE knox runs: Model.delete() nulls the instance's pk.
        model = type(auth_token)
        pk, expiry = auth_token.pk, auth_token.expiry
        expired = super()._cleanup_token(auth_token)
        if expired:
            run_after_request_transaction(
                lambda: model._default_manager.filter(
                    pk=pk, expiry=expiry, expiry__lt=timezone.now(),
                ).delete()
            )
        return expired

    def validate_user(self, auth_token):
        user, token = super().validate_user(auth_token)

        # ONE query, joining the stamp and the account's counter, on the
        # global authentication path. Two reads would be two statements and so
        # two snapshots: an ownership event committing between them could make
        # them disagree spuriously and 401 a perfectly good token, and it also
        # doubles the per-request cost for every bearer client on the platform
        # (codex adversarial review). `values_list` so nothing is instantiated.
        #
        # This is the ONLY query this check adds: `auth_token.user` was already
        # fetched by knox's own `_cleanup_token` before `validate_user` runs,
        # so `super()`'s `is_active` check costs nothing extra. Getting to zero
        # would mean reimplementing knox's `authenticate_credentials` loop with
        # a `select_related`, which is third-party code that would then have to
        # be kept in step by hand across knox upgrades -- a worse trade for one
        # indexed lookup.
        stamped, current = (
            type(token)
            ._default_manager.filter(pk=token.pk)
            .values_list(
                "account_epoch_stamp__account_epoch", "user__kt_account_epoch",
            )
            .first()
        ) or (None, None)

        if current is not None and stamped is not None:
            if stamped == current:
                return (user, token)
            # A stamp BEHIND the account can never come back into agreement:
            # `kt_account_epoch` only ever increases. Delete rather than
            # re-decide the same refusal on every future request -- and
            # deleting is safe under DRF's contract because this raises, so no
            # view runs.
            #
            # NOT inline: on a POST/PUT/PATCH this runs inside
            # AtomicMiddleware's block, and the AuthenticationFailed below
            # now rolls that block back -- an inline delete would be undone
            # and redone on every retry. Deferred, it commits on its own once
            # the request transaction has ended; on a GET it runs now.
            run_after_request_transaction(token.delete)
        else:
            # MISSING, not stale, and the two are not the same fact. Every
            # token gets a stamp from `credentials.receive_auth_token_saved`,
            # wired to `post_save` on the model, so through the ORM this is
            # unreachable. What CAN reach it is a rolling deploy: a not-yet-
            # updated pod mints a token after `migrate` has run, and an
            # updated pod then sees no stamp (codex adversarial review).
            #
            # Refused either way -- admitting an unjudgeable credential is the
            #  mistake, a control substituting a value it could not read
            # -- but NOT deleted, and logged at ERROR with the account. The
            # holder re-authenticates; nothing about the row is proven bad, and
            # a rollout artifact should not be destroyed on the way past.
            logger.error(
                "kt: refusing an UNSTAMPED bearer token for user %s. Expected "
                "only during the rollout of #1570; a steady-state occurrence "
                "means a token was written around the ORM.",
                user.pk,
            )
        raise exceptions.AuthenticationFailed(
            _("Invalid token."),
        )
