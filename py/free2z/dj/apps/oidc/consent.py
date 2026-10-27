"""Consent and the grant (spec §5): when it is required, what it records, and
how it is revoked. ``agen`` -- ``AppAuthorization.generation`` -- moves only
through the functions here, and every move is published to resource servers.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta

from django.db import connection, transaction
from django.utils import timezone

from . import epoch_publish, ledger_projection
from .models import AccessToken, AppAuthorization, CapPeriod, RefreshToken
from .redirects import is_interactive_only
from .scopes import (
    INTERACTIVE_ONLY_SCOPES,
    PLATFORM_DEFAULT_CAP_PERIOD,
    PLATFORM_DEFAULT_SPEND_CAP_2Z,
    SCOPE_AI_INVOKE,
    scope_list,
    scope_string,
)

logger = logging.getLogger(__name__)

#Spec §10: raising a spend cap requires authentication within the last
#five minutes.
CAP_RAISE_MAX_AGE = timedelta(seconds=300)

REASON_PROMPT_CONSENT = "consent_required"
REASON_INTERACTION = "interaction_required"


class ConsentError(ValueError):
    """A consent POST that cannot be recorded; ``code`` is machine-readable."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class StepUpRequired(ConsentError):
    """Spec §10: the operation needs a recent authentication (RFC 9470)."""

    def __init__(self, message: str = "raising a spend cap requires authentication within the last 5 minutes"):
        super().__init__("insufficient_user_authentication", message)
        self.max_age = int(CAP_RAISE_MAX_AGE.total_seconds())


@dataclass(frozen=True)
class ConsentRequirement:
    required: bool
    #The error a `prompt=none` request is answered with when `required`.
    prompt_none_error: str | None
    existing: AppAuthorization | None


def live_authorization(user, application) -> AppAuthorization | None:
    return (
        AppAuthorization.objects.live()
        .filter(user_id=user.pk, application_id=application.pk)
        .first()
    )


def consent_requirement(user, application, scopes, redirect_kind: str, prompt) -> ConsentRequirement:
    """Whether this request must show the consent screen (spec §5).

    The rules, in the order they apply:

    1. ``prompt=consent`` always shows it.
    2. A loopback or private-use-scheme redirect never gets ``ai:invoke``,
       ``purchase:create`` or ``offline_access`` silently: any process on
       the device can claim that redirect, so the user's act is the only
       proof this app is the one they mean. ``prompt=none`` answers
       ``interaction_required`` for these.
    3. Otherwise a live grant that already covers every requested scope, and
       whose consented markup is not below the app's current effective
       markup, is enough.
    """
    prompt = set(prompt or ())
    requested = set(scope_list(scopes))
    existing = live_authorization(user, application)
    if "consent" in prompt:
        return ConsentRequirement(True, REASON_PROMPT_CONSENT, existing)
    if is_interactive_only(redirect_kind) and requested & INTERACTIVE_ONLY_SCOPES:
        return ConsentRequirement(True, REASON_INTERACTION, existing)
    if existing is None:
        return ConsentRequirement(True, REASON_PROMPT_CONSENT, existing)
    if not requested <= set(existing.scope_list):
        return ConsentRequirement(True, REASON_PROMPT_CONSENT, existing)
    if application.effective_markup_bps > existing.markup_bps:
        return ConsentRequirement(True, REASON_PROMPT_CONSENT, existing)
    return ConsentRequirement(False, None, existing)


#The authorization request's optional spend-cap hint. Not OAuth
#parameters: the platform's own, like ``f2z_login_ticket``. They only ever
#change what the consent screen PRE-SELECTS; nothing is recorded from them
#except through the user's confirmed consent POST, which carries the cap as
#its own body fields.
SPEND_CAP_HINT_PARAMETER = "f2z_spend_cap"
SPEND_PERIOD_HINT_PARAMETER = "f2z_spend_period"
#The ``spend_cap_2z`` column is a PositiveIntegerField.
MAX_SPEND_CAP_HINT_2Z = 2_147_483_647

SOURCE_GRANT = "grant"
SOURCE_APP = "app"
SOURCE_PLATFORM = "platform"
SOURCE_REQUEST = "request"


@dataclass(frozen=True)
class SpendCapHint:
    spend_cap_2z: int
    #``None``: keep the period of the pre-selection the hint replaces.
    cap_period: str | None


def parse_spend_cap_hint(params) -> SpendCapHint | None:
    """The request's hint, or ``None`` when absent or unusable.

    An unusable hint (not a whole number of 2Z from 1, too large, an unknown
    period, a period without an amount) is IGNORED, never an error: it is a
    suggestion about what the screen pre-selects, and a bad suggestion must
    not fail an otherwise valid authorization request.
    """
    raw_cap = params.get(SPEND_CAP_HINT_PARAMETER)
    raw_period = params.get(SPEND_PERIOD_HINT_PARAMETER)
    if not isinstance(raw_cap, str) or not raw_cap.isascii() or not raw_cap.isdigit():
        return None
    if len(raw_cap) > len(str(MAX_SPEND_CAP_HINT_2Z)) or raw_cap.startswith("0"):
        return None
    cap = int(raw_cap)
    if not 1 <= cap <= MAX_SPEND_CAP_HINT_2Z:
        return None
    if raw_period is not None and raw_period not in CapPeriod.values:
        return None
    return SpendCapHint(cap, raw_period)


def clamp_cap(cap: int, period: str, ceiling_cap, ceiling_period) -> tuple[int, str] | None:
    """``(cap, period)`` lowered so it is not a raise over the ceiling, or
    ``None`` when no lowering of the amount can make it one.

    Under:func:`is_cap_raise` a period change on a capped ceiling is always
    a raise (a new period is a fresh ledger window, ), so only the
    amount can be clamped: a different period is refused, never rewritten. A
    ceiling of ``None`` (no cap) bounds nothing: any cap is already lower.
    """
    if ceiling_cap is None:
        return cap, period
    if CapPeriod(period) != CapPeriod(ceiling_period):
        return None
    return min(cap, ceiling_cap), period


def spending_baseline(last):
    """The grant a new AI spending decision is judged against, or ``None``.

    The user's last grant for the app, live or revoked (revoking leaves the
    ledger window in place, ) -- unless it never made an AI spending
    decision: no ``ai:invoke`` AND no cap. Such a grant stores "no cap" only
    because identity needs none; treating it as the user's budget would
    pre-select uncapped AI spending, which one Allow would then grant
    without the "no limit" confirmation the app's default requires (
    review). ``record_consent`` can never call anything a raise over it
    (an uncapped old grant cannot be raised), so skipping it is safe.
    """
    if last is None:
        return None
    if SCOPE_AI_INVOKE not in last.scope_list and last.spend_cap_2z is None:
        return None
    return last


def preselected_cap(application, existing, hint: SpendCapHint | None = None) -> tuple[int | None, str]:
    """Preserve existing consent; otherwise offer the developer's optional budget.

    A suggestion applies independently to each consenting user, not a shared
    app quota. With no suggestion, the user authorizes prepaid-balance spending
    without an additional app budget. The screen must still submit that choice
    explicitly (null); absence of a decision never implies consent.

    ``hint`` is the authorization request's ``f2z_spend_cap`` /
    ``f2z_spend_period``. See:func:`preselection`. Only the consent
    GET passes it; the POST never does.
    """
    return preselection(application, existing, hint)[:2]


def preselection(application, existing, hint: SpendCapHint | None = None) -> tuple[int | None, str, str]:
    """:func:`preselected_cap` plus where it came from (``SOURCE_*``).

    ``existing`` is the spending baseline (:func:`spending_baseline`). A
    ``hint`` replaces the pre-selection only when it fits BOTH ceilings by
    lowering its amount alone:

    * the registration's default -- a capped default fixes the period (a
      hint for another period is ignored) and bounds the amount; no default
      bounds nothing;
    * the baseline grant -- the same, by:func:`is_cap_raise`: a capped
      grant fixes the period, an uncapped one bounds nothing.

    So an applied hint is never a raise over the grant (never needs a fresh
    sign-in), never exceeds or re-periods the registration's default, and a
    URL can only ever pre-select a LOWER budget than the screen would have
    offered anyway. A hint that cannot fit is ignored, never bent.
    """
    if existing is not None:
        base = (existing.spend_cap_2z, existing.cap_period, SOURCE_GRANT)
    elif application.default_spend_cap_2z is None:
        base = (PLATFORM_DEFAULT_SPEND_CAP_2Z, PLATFORM_DEFAULT_CAP_PERIOD, SOURCE_PLATFORM)
    else:
        base = (application.default_spend_cap_2z, application.default_cap_period, SOURCE_APP)
    if hint is None:
        return base
    candidate = (hint.spend_cap_2z, hint.cap_period or base[1])
    for ceiling_cap, ceiling_period in (
        (application.default_spend_cap_2z, application.default_cap_period),
        (existing.spend_cap_2z, existing.cap_period) if existing is not None else (None, None),
    ):
        candidate = clamp_cap(*candidate, ceiling_cap, ceiling_period)
        if candidate is None:
            return base
    return candidate[0], candidate[1], SOURCE_REQUEST


def is_cap_raise(old_cap, old_period, new_cap, new_period) -> bool:
    """Spec §5: a change is a raise whenever it can increase what the app may
    spend in ANY window -- the current one included.

    The ledger counts spend per window, keyed by ``ledger.window_start(period,
    now)`` (``ledger_spend_window``), and ``ledger_projection.sync_grant``
    opens a new cap frame (``cap_window_revision``) on every period change.
    So ANY change of period on a capped grant starts an EMPTY window: an app
    that has already spent this month's 100 gets a fresh 100 the moment
    "100 a month" becomes "100 in total" -- or "50 in total", or "100 a
    week" -- however the periods rank. Only a change that keeps the
    period keeps the window, and only then is a smaller amount a lowering.

    Direction by direction, on a capped grant (``old_cap`` not ``None``):

    * same period, amount not above the old one: the window and its spend
      carry over -- a lowering, applies at once;
    * same period, higher amount: a raise;
    * any other period, any positive amount: a fresh window -- a raise,
      whichever way the periods rank and even when the amount goes DOWN
      (100/month spent to 0 -> 50/total makes 50 spendable right now that
      the current window would not have allowed);
    * a cap of 0: admits no spend in any window, so never a raise;
    * no cap: a raise.

    Carrying the current window's spend into the new frame at the ledger
    level would make some period changes a true lowering, but that is a
    ledger migration (option b) and the rule here must stay a pure
    function of the two caps -- the consent screen mirrors it to warn about
    the step-up before the POST (``isCapRaise`` in
    ``ts/svelte/free2z/src/lib/oidc/consent.ts``).
    """
    if old_cap is None:
        # No cap before: nothing can be raised. Adding a cap is a lowering.
        return False
    if new_cap is None:
        return True
    if new_cap == 0:
        return False
    if new_cap > old_cap:
        return True
    return CapPeriod(new_period) != CapPeriod(old_period)


def _validate_cap(spend_cap_2z, cap_period):
    if spend_cap_2z is not None:
        if isinstance(spend_cap_2z, bool) or not isinstance(spend_cap_2z, int) or spend_cap_2z < 0:
            raise ConsentError("invalid_spend_cap", "spend_cap_2z must be a whole number of 2Z or null")
    if cap_period not in CapPeriod.values:
        raise ConsentError("invalid_cap_period", f"cap_period must be one of {', '.join(CapPeriod.values)}")


def _lock_application_for_consent(application) -> bool:
    """Hold the app row against deletion through the grant transaction."""
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT id FROM {application._meta.db_table} "
            "WHERE id = %s FOR KEY SHARE",
            [application.pk],
        )
        return cursor.fetchone() is not None


def _lock_user_for_consent(user) -> bool:
    """Lock an active consenting account before locking its app.

    Account deletion takes Creator FOR UPDATE before it locks owned apps.
    Matching that order prevents a self-owned app consent from holding the
    app while its deferred user FK waits for the Creator row at COMMIT.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT is_active FROM {user._meta.db_table} "
            f"WHERE {user._meta.pk.column} = %s FOR KEY SHARE",
            [user.pk],
        )
        row = cursor.fetchone()
        return row is not None and row[0]


def record_consent(
    user,
    application,
    scopes,
    *,
    spend_cap_2z,
    cap_period,
    recent_auth_time=None,
) -> AppAuthorization:
    """Create or replace the grant for (user, app) with what the user chose.

    ``scopes`` are the scopes the user granted (a subset of what the app may
    request). ``recent_auth_time`` is the consenting session's ``auth_time``
    when known; a cap RAISE on a re-consent -- judged against the user's
    last grant for the app whether it is live or revoked, since revocation
    leaves the ledger's spend window in place -- needs it to be within
    :data:`CAP_RAISE_MAX_AGE`, and fails closed (:class:`StepUpRequired`)
    when it is unknown.

    Scope reduction bumps the generation (spec §5); a raise does not.
    The consented markup is the app's effective markup right now.
    """
    granted = scope_list(scopes)
    if not granted:
        raise ConsentError("invalid_scope", "at least one scope must be granted")
    outside = set(granted) - set(application.allowed_scope_list)
    if outside:
        raise ConsentError("invalid_scope", f"scope(s) not allowed for this app: {' '.join(sorted(outside))}")
    if SCOPE_AI_INVOKE not in granted:
        # A cap is meaningful only for AI spend; a grant without ai:invoke
        # records no additional budget by default. Adding AI scope later still
        # requires explicit consent, including an explicit cap/null decision.
        cap_period = cap_period or PLATFORM_DEFAULT_CAP_PERIOD
    _validate_cap(spend_cap_2z, cap_period)

    now = timezone.now()
    with transaction.atomic():
        # Match account_deletion's Creator -> application lock order. The
        # grant FKs are deferred, and taking the app first would let consent
        # hold it while waiting for Creator at COMMIT, opposite to account
        # deletion's Creator FOR UPDATE -> app FOR UPDATE order.
        if not _lock_user_for_consent(user):
            raise ConsentError(
                "account_unavailable", "this account is no longer available",
            )

        # Take the same KEY SHARE lock the deferred app FK would take at
        # COMMIT. A deletion that wins this lock observes no new grant; when
        # it commits, the row is gone and this check returns false.
        if not _lock_application_for_consent(application):
            raise ConsentError(
                "application_unavailable", "this app is no longer available",
            )

        existing = (
            AppAuthorization.objects.select_for_update()
            .filter(user_id=user.pk, application_id=application.pk)
            .first()
        )
        if existing is None:
            authorization = AppAuthorization.objects.create(
                user=user,
                application=application,
                scope=scope_string(granted),
                spend_cap_2z=spend_cap_2z,
                cap_period=cap_period,
                markup_bps=application.effective_markup_bps,
                generation=1,
                consented_at=now,
            )
            created = True
        else:
            # Against the LAST grant, live or revoked. Revoking a grant does
            # not reset its ledger spend window (``ledger_spend_window`` is
            # keyed by app, account and window start, and outlives the
            # grant), so a revoke followed by a re-consent at another period,
            # or with no cap, would open an empty window exactly as a direct
            # change would -- without ever having asked for a fresh sign-in
            # ( review). The row here is the source of truth for that
            # frame: ``ledger_spend_cap`` is written from it and nowhere
            # else. Re-consenting at the same cap and period carries the
            # spend over and needs nothing.
            if is_cap_raise(
                existing.spend_cap_2z, existing.cap_period, spend_cap_2z, cap_period,
            ):
                if recent_auth_time is None or now - recent_auth_time > CAP_RAISE_MAX_AGE:
                    raise StepUpRequired()
            reduced = existing.is_live and not set(existing.scope_list) <= set(granted)
            existing.scope = scope_string(granted)
            existing.spend_cap_2z = spend_cap_2z
            existing.cap_period = cap_period
            existing.markup_bps = application.effective_markup_bps
            existing.consented_at = now
            existing.revoked_at = None
            if reduced:
                existing.generation += 1
            existing.save()
            authorization = existing
            created = False
        ledger_projection.sync_grant(authorization)
        epoch_publish.schedule_publish_grant_generation(
            user.public_id, application.client_id, authorization.generation,
        )
    logger.info(
        "oidc: consent %s user=%s client=%s scopes=%r cap=%s/%s markup=%s gen=%s",
        "recorded" if created else "replaced", user.pk, application.client_id,
        granted, spend_cap_2z, cap_period, authorization.markup_bps,
        authorization.generation,
    )
    return authorization


def update_grant_cap(
    user,
    application,
    *,
    spend_cap_2z,
    cap_period,
    recent_auth_time=None,
) -> AppAuthorization | None:
    """Change a live grant's spend cap from ``/account/apps`` (spec §5, ).

    Returns the grant, or ``None`` when the user has no LIVE grant for the
    app. The same raise rule as a re-consent (:func:`is_cap_raise`): a raise
    -- a higher amount, no cap, or any change of period, which opens a fresh
    ledger window -- needs ``recent_auth_time`` within
    :data:`CAP_RAISE_MAX_AGE` and fails closed (:class:`StepUpRequired`)
    without one; a lowering applies at
    once. Only the cap moves: scopes, consented markup and ``generation``
    are untouched (a cap change never reduces what a token may name), so
    nothing is published to resource servers -- the ledger's
    ``ledger_spend_cap`` projection is what the hold reads, and it is
    written in the same transaction.

    Refuses (``ConsentError("cap_not_applicable")``) a grant without
    ``ai:invoke``: a cap bounds AI spend only, and on such a grant it is the
    pre-selection a later re-consent starts from, which only consent sets.
    """
    _validate_cap(spend_cap_2z, cap_period)
    now = timezone.now()
    with transaction.atomic():
        authorization = (
            AppAuthorization.objects.select_for_update()
            .filter(user_id=user.pk, application_id=application.pk, revoked_at__isnull=True)
            .first()
        )
        if authorization is None:
            return None
        if SCOPE_AI_INVOKE not in authorization.scope_list:
            raise ConsentError(
                "cap_not_applicable",
                "this app was not allowed to spend 2Z on AI, so it has no spending limit",
            )
        previous = (authorization.spend_cap_2z, authorization.cap_period)
        if is_cap_raise(authorization.spend_cap_2z, authorization.cap_period, spend_cap_2z, cap_period):
            if recent_auth_time is None or now - recent_auth_time > CAP_RAISE_MAX_AGE:
                raise StepUpRequired()
        authorization.spend_cap_2z = spend_cap_2z
        authorization.cap_period = cap_period
        authorization.save(update_fields=["spend_cap_2z", "cap_period", "updated_at"])
        ledger_projection.sync_grant(authorization)
    logger.info(
        "oidc: grant cap changed user=%s client=%s cap=%s/%s -> %s/%s",
        user.pk, application.client_id, previous[0], previous[1], spend_cap_2z, cap_period,
    )
    return authorization


def _revoke_tokens(user_id, application_id) -> None:
    """Every refresh-token family, every access token, and every outstanding
    authorization code of the grant.

    The codes too: a code issued before the revocation and redeemed after a
    re-authorization within its 60 s would otherwise mint against the new
    grant (codex adversarial review, round 2).
    """
    from .models import AuthorizationCode

    AuthorizationCode.objects.filter(
        user_id=user_id, application_id=application_id, redeemed_at__isnull=True,
    ).delete()
    families = set(
        RefreshToken.objects.filter(
            user_id=user_id, application_id=application_id, revoked__isnull=True,
        ).values_list("token_family", flat=True)
    )
    for family in families:
        RefreshToken.revoke_family(family)
    AccessToken.objects.filter(user_id=user_id, application_id=application_id).delete()


def revoke_authorization(user, application) -> AppAuthorization | None:
    """Spec §5: revoking increments ``agen`` and deletes every token of the
    grant. Returns the grant, or ``None`` if there was none."""
    with transaction.atomic():
        authorization = (
            AppAuthorization.objects.select_for_update()
            .filter(user_id=user.pk, application_id=application.pk)
            .first()
        )
        if authorization is None:
            return None
        already_revoked = not authorization.is_live
        if not already_revoked:
            authorization.revoked_at = timezone.now()
            authorization.save(update_fields=["revoked_at", "updated_at"])
            authorization.bump_generation()
        _revoke_tokens(user.pk, application.pk)
        ledger_projection.sync_grant(authorization)
        epoch_publish.schedule_publish_grant_generation(
            user.public_id, application.client_id, authorization.generation,
        )
    logger.info(
        "oidc: grant revoked user=%s client=%s gen=%s", user.pk,
        application.client_id, authorization.generation,
    )
    return authorization


def bump_generation_for_reuse(refresh_token) -> None:
    """Refresh-token reuse (spec §8): the family is already revoked by the
    library; move the grant generation so every access token minted under
    the old one -- the stolen chain's above all -- is refused at once.

    Other families (other devices) keep their refresh tokens: their next
    refresh mints an access token at the new generation and they carry on
    after one 401. Deleting their access tokens here would orphan their
    refresh tokens and sign every device out for one device's compromise.
    """
    with transaction.atomic():
        authorization = (
            AppAuthorization.objects.select_for_update()
            .filter(
                user_id=refresh_token.user_id,
                application_id=refresh_token.application_id,
            )
            .first()
        )
        if authorization is None:
            return
        authorization.bump_generation()
        ledger_projection.sync_grant(authorization)
        epoch_publish.schedule_publish_grant_generation(
            refresh_token.user.public_id,
            refresh_token.application.client_id,
            authorization.generation,
        )
