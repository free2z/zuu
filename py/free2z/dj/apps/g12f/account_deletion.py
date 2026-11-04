"""Self-service account deletion: ``{origin}/account/delete``.

Why it exists
-------------

Apple (App Review Guideline 5.1.1(v)) and Google Play both require an app that
lets people create an account to let them delete it, in the app or through a
web link the app opens. Free2Z accounts are created inside SDK apps' sign-in
flows (¡AHA! is the first), so ``https://free2z.cash/account/delete`` is a
contract: SDK apps deep-link to it and it is the deletion URL listed on Google
Play. Before this, deletion was an email to support.

Request, grace period, purge
----------------------------

Deletion is *requested* (:func:`schedule_deletion`): the account goes inactive
at once -- hidden by every / gate, every session, token and app grant
revoked -- and is purged:data:`GRACE_PERIOD` (30 days) later by
:func:`purge_due_deletions`. Signing in during the grace period never signs
in silently: every sign-in path calls:func:`login_gate`, which answers with a
short-lived keep token instead of a credential, and only an explicit "Keep my
account" (:func:`keep_account`) reactivates the account and then signs in.
Owner decision, 2026-10-14; the alternative -- a restricted session for
pending accounts plus a route allowlist -- would have put a bespoke exception
into every authentication class, which is a larger surface than one check in
each sign-in path.

What the purge does
-------------------

The ``Creator`` row itself cannot be removed. Ledger accounts, economy records,
purchases and on-chain transactions point at it with ``PROTECT`` and several of
those tables are append-only by trigger, so a hard delete is refused by the
database -- correctly: those are the records law and accounting require. The
account is **pseudonymized in place** instead, and everything that is only
personal data is deleted.:data:`POLICY` classifies every relation to the
account; ``test_account_deletion.py`` fails when a new one appears unclassified,
so a new table of personal data cannot silently survive a deletion. And the
policy is enforced, not just declared::func:`policy_violations` re-reads every
``DELETE``/``UNLINK``/``REVOKE`` relation at the end of the transaction and the
deletion rolls back (``PolicyNotApplied``) if any row contradicts it.

* **Credentials** -- password, recovery email, social / X / Zcash wallet
  identities, passkeys, TOTP, recovery codes -- are deleted, and the account
  epoch moves (``ktauth`` event ``account_deleted``). That one increment signs
  every browser out, deletes every Knox token, and publishes the epoch the AI
  gateway checks, so OIDC access tokens die too.
* **Connected apps**: every grant is revoked the way ``/account/apps`` revokes
  one (``agen`` moves; codes, access tokens and refresh-token families die).
* **Profile**: name, bio, avatar, banner, payment address and email are
  cleared and ``deleted_at`` is set. The username stays on the hidden row for
  :data:`USERNAME_RESERVATION` (30 days) so nobody can register it and inherit
  old links, @mentions or a job queued under the name; then
  :func:`release_deleted_usernames` renames the row to a random
  ``deleted_<hex>``. The messaging handle is retired (never re-issued), exactly
  as ``handles.signals.retire_on_delete`` would on a real delete.
* **Content**: pages, series, uploads (their stored files are queued for
  deletion by the uploads ``pre_delete`` hook), AI conversations, stories,
  message requests, follows, blocks and mutes are deleted. A page that on-chain
  payments point at cannot be deleted (the same refusal the page DELETE route
  gives) and stays hidden behind ``is_active=False``, which every public read
  path honours. A comment is deleted unless somebody else replied to it;
  then its text is cleared so the other people's replies survive.
* **Held for moderation**: content under an open report (a page, a comment,
  or the account itself) is kept hidden instead of erased, with the uploads,
  until staff resolve the report -- the holder must not be able to destroy
  what a report is about. The holder is not told.
* **Unlinked**, exactly as a real delete's ``SET_NULL`` would: recording
  deliveries (a pending retry then terminalizes rather than re-uploading),
  export jobs, tag decisions, content reports and X announcements (unsent
  ones are suppressed and generated copy is cleared).
* **Kept, attached only to the pseudonymous row**: the 2Z ledger and its
  balance, purchases, paid memberships, payouts, tax/KYC records and on-chain
  transactions -- see the ``RETAIN`` entries in:data:`POLICY`.

The remaining 2Z balance is not moved. The Terms say ending an account ends the
right to use the services through that account, and that credits cannot be
cashed out; they promise no refund on deletion, so none is invented here. The
balance stays recorded on the retained ledger account and simply cannot be used
again. Whether to post it somewhere (forfeiture, unclaimed property) is an
owner decision, recorded in the PR that introduced this module.

Three situations refuse the deletion instead (:func:`blockers`):

* ``earnings_owed`` -- the account has creator earnings still owed, or paid
  work admitted but not yet settled (it would settle after deletion). Those
  survive termination under the creator agreement, and once the credentials are
  gone nobody could prove they are owed them; support has to pay them first.
* ``app_has_users`` -- the account owns an SDK app that people have authorized.
  Its grants and ledger usage must stay attributable to a live developer, the
  same reason the developer console refuses to delete such an app.
* ``staff_account`` -- a staff or superuser account; another admin removes
  its staff access first.
"""
from __future__ import annotations

import logging
import secrets
import json
from dataclasses import dataclass, field
from datetime import timedelta

from django.db import models, transaction
from django.db.models import Q
from django.utils import timezone

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# The policy: what happens to every relation that points at an account.
# ---------------------------------------------------------------------------

#The personal data is deleted.
DELETE = "delete"
#The row stays but no longer points at the account (a real delete's
#``SET_NULL``); any personal payload on it is cleared.
UNLINK = "unlink"
#The row is revoked (credentials / grants), not merely left.
REVOKE = "revoke"
#The row is a record law, accounting or the counterparty needs. It stays,
#pointing at the pseudonymized account.
RETAIN = "retain"
#Refuses the deletion while it exists (see ``blockers``).
BLOCK = "block"

POLICY: dict[str, tuple[str, str]] = {
    # -- credentials and sessions -------------------------------------------
    "emails.Email.user": (DELETE, "recovery address; its reset tokens cascade"),
    "otp.OTPSecret.user": (DELETE, "TOTP secret"),
    "identity.WebAuthnCredential.creator": (DELETE, "passkeys"),
    "identity.RecoveryCode.creator": (DELETE, "recovery codes"),
    "identity.AuthContext.creator": (DELETE, "sign-in contexts"),
    "social.SocialIdentity.creator": (DELETE, "Google/GitHub/X sign-in identities"),
    "twitter.TwitterProfile.creator": (DELETE, "legacy X sign-in identity"),
    "zauth.ZcashIdentity.creator": (DELETE, "Zcash wallet sign-in identity"),
    "knox.AuthToken.user": (REVOKE, "deleted by the account_deleted epoch bump"),
    "g12f.Creator_groups.creator": (DELETE, "staff group membership"),
    "g12f.Creator_user_permissions.creator": (DELETE, "staff permissions"),
    # -- connected apps (OIDC) ----------------------------------------------
    "oidc.AppAuthorization.user": (REVOKE, "grant revoked, agen moves; row kept as the ledger's grant record"),
    "oidc.AuthorizationCode.user": (REVOKE, "unredeemed codes deleted"),
    "oidc.AccessToken.user": (REVOKE, "deleted"),
    "oidc.RefreshToken.user": (REVOKE, "every family revoked"),
    "oidc.IDToken.user": (REVOKE, "deleted"),
    "oidc.DeviceGrant.user": (REVOKE, "deleted"),
    "oidc.F2ZApplication.user": (BLOCK, "an app people authorized blocks; an unused app is deleted"),
    # -- profile and social graph -------------------------------------------
    "handles.MessagingHandle.user": (UNLINK, "retired and unlinked; never re-issued"),
    "g12f.CreatorFollow.creator": (DELETE, "follows"),
    "g12f.CreatorFollow.follower": (DELETE, "follows"),
    "g12f.CreatorBlock.blocker": (DELETE, "blocks"),
    "g12f.CreatorBlock.blocked": (DELETE, "blocks"),
    "g12f.CreatorMute.muter": (DELETE, "mutes"),
    "g12f.CreatorMute.muted": (DELETE, "mutes"),
    "g12f.PageMentionDelivery.author": (DELETE, "mention notifications"),
    "g12f.PageMentionDelivery.recipient": (DELETE, "mention notifications"),
    # -- content -------------------------------------------------------------
    "g12f.zPage.creator": (DELETE, "pages; one on-chain payments point at, or under an open report, stays hidden"),
    "g12f.Series.creator": (DELETE, "series"),
    "uploads.GenericFile.owner": (DELETE, "uploads; stored files queued for deletion"),
    "comments.Comment.author": (DELETE, "deleted, or text cleared when others replied; kept hidden under an open report"),
    "oidc.AiOutputReport.reporter": (UNLINK, "reporter unlinked, as its SET_NULL says; the moderation report stays"),
    "oidc.AudienceChange.changed_by": (UNLINK, "who changed the audience is unlinked; the audit row stays"),
    "comments.ContentReport.reporter": (UNLINK, "reporter unlinked; the moderation report stays"),
    "openai.Conversation.user": (DELETE, "AI conversations"),
    "openai.PromptResponse.user": (DELETE, "AI responses; a fork another user made of the holder's conversation loses these turns"),
    "openai.Personality.creator": (DELETE, "AI personalities; one other people's conversations use is kept, made private"),
    "storytime.Story.creator": (DELETE, "stories"),
    "e2ee.ChatRequest.sender": (DELETE, "message requests"),
    "e2ee.ChatRequest.recipient": (DELETE, "message requests"),
    "exports.PublicationExportJob.creator": (UNLINK, "unlinked, as a real delete's SET_NULL would; archives expire within 24h"),
    "tagging.TagSuggestion.decided_by": (UNLINK, "unlinked, as a real delete's SET_NULL would"),
    "twitter.Announcement.subject_user": (UNLINK, "unlinked; unsent announcements suppressed, generated copy and images cleared"),
    "dyte.CreatorMeeting.creator": (RETAIN, "livestream room; every access and money path refuses an inactive creator"),
    "dyte.ProviderRoomCleanup.creator": (UNLINK, "unlinked, as a real delete's SET_NULL would; keeps creator_id_snapshot"),
    "dyte.RecordingDelivery.creator": (UNLINK, "unlinked so a pending recording retry terminalizes instead of re-uploading"),
    "dyte.RecordingDeliveryTarget.creator": (UNLINK, "unlinked, as a real delete's SET_NULL would; keeps creator_id_snapshot"),
    "admin.LogEntry.user": (RETAIN, "staff audit log"),
    "g12f.AccountDeletionEvent.creator": (RETAIN, "the deletion's own audit trail; timestamps and codes only"),
    # -- money, accounting, tax: kept ----------------------------------------
    "ledger.Account.owner": (RETAIN, "2Z ledger account and remaining balance"),
    "ledger.LedgerApp.developer_creator": (RETAIN, "ledger record"),
    "ledger.LedgerDevMarkupPending.developer_creator": (RETAIN, "ledger record"),
    "g12f.Transaction.creator": (RETAIN, "on-chain payment record"),
    "g12f.Subscription.fan": (RETAIN, "paid membership record; renewals refuse an inactive account"),
    "g12f.Subscription.star": (RETAIN, "paid membership record; renewals refuse an inactive account"),
    "events.Event.contributor": (RETAIN, "payment event"),
    "events.Event.payee": (RETAIN, "payment event"),
    "events.Event.receiving_user": (RETAIN, "payment event"),
    "kyc.UserProfile.user": (RETAIN, "identity verification and tax forms"),
    "purchases.PurchaseIntent.creator": (RETAIN, "purchase record"),
    "ztripe.CheckoutIntent.user": (RETAIN, "card purchase record"),
    "ztripe.StripeTransaction.user": (RETAIN, "card purchase record"),
    "tuzis.ZecCreditReceipt.creator": (RETAIN, "Zcash purchase receipt"),
    "tuzis.ZecPendingNotice.creator": (RETAIN, "Zcash purchase in flight"),
    "tuzis.TuziGrant.creator": (RETAIN, "2Z grant record; its username snapshot follows the release"),
    "tuzis.IdempotencyKey.user": (RETAIN, "payment idempotency record"),
    "tuzis.ProviderReservation.user": (RETAIN, "2Z hold record"),
    "tuzis.SubscriptionIntentEvidence.user": (RETAIN, "membership purchase evidence"),
    "tuzis.SubscriptionIntentAbandonment.user": (RETAIN, "membership purchase evidence"),
    "economy.CreatorPayable.creator": (BLOCK, "earnings owed, or work admitted but not yet settled, block; a settled payable is kept"),
    "economy.CompensationAgreement.creator": (RETAIN, "creator agreement"),
    "economy.CompensationAgreement.accepted_by": (RETAIN, "creator agreement"),
    "economy.FundingReservation.purchaser": (RETAIN, "economy record"),
    "economy.FundingReservation.recipient": (RETAIN, "economy record"),
    "economy.LegacyClaim.creator": (RETAIN, "economy record"),
    "economy.PaymentRequest.requested_by": (RETAIN, "payout record"),
    "economy.PurchaserDay.purchaser": (RETAIN, "economy record"),
    "economy.SdkServiceAdmission.subject": (RETAIN, "economy record"),
    "economy.ServiceAdmission.creator": (RETAIN, "economy record"),
    "economy.SupplierOfferApproval.approved_by": (RETAIN, "economy record"),
    "economy.SupplierOfferApproval.creator": (RETAIN, "economy record"),
    "economy.SupplierOfferRevocation.operator": (RETAIN, "economy record"),
    "economy.ZecNoteDisposition.actor": (RETAIN, "economy record"),
}

# Idempotency rows are retained with the payment/accounting records above, but
# many scopes also cache a successful HTTP response. A deleted account cannot
# replay its own request, so these response bodies are content retention, not
# payment evidence. Dynamic `subscribe:<creator-pk>` and
# `subscribe-intent:<creator-pk>` scopes use the prefixes below.
CONTENT_REPLAY_SCOPES = frozenset({
    "comment", "comment_reply", "comment_vote", "page_vote", "page_fund",
    "zpage-create", "zpage-translate-batch",
    "e2ee-chat-request", "storytime_page", "storytime_image",
    "ai_chat", "ai_completion", "ai_prompt", "ai_image",
    "donate-idempotent", "subscribe-confirmed",
})
CONTENT_REPLAY_SCOPE_PREFIXES = (
    "subscribe:",
    "subscribe-intent:",
)

# These fields can contain the holder's source text, generated translation,
# or excerpts from either. Keep charge state and immutable references needed
# by the worker, charge reaper, and variant reconciliation.
RECONCILIATION_RESPONSE_BODY_SCRUB_KEYS = {
    "zpage-translate": frozenset({
        "_attempted_output", "attempted_output_preview", "_fragments",
        "error_detail", "warnings",
    }),
}

# purchase_intent:<application-or-first_party> retains purchase_id because a
# stale claim uses it to recover the existing checkout. tuzi-grant keeps its
# grant_id/amount receipt. Stripe event scopes and zec-funding-note are
# reconciliation evidence; the latter is additionally immutable in the DB
# trigger (`economy.guard_note_observation_identity`).
PURCHASE_RECOVERY_SCOPE_PREFIX = "purchase_intent:"
GRANT_RECEIPT_SCOPE = "tuzi-grant"
# Scoring completion has no response body; its retained status is the
# exactly-once fence against another scoring reward or penalty.
BODYLESS_COMPLETION_SCOPES = frozenset({"aiscore_comment"})
# Financial snapshots/outcomes and the latest applied plan are read by Stripe
# reconciliation, including proof that a refund/dispute reversal restores funds.
IMMUTABLE_RECONCILIATION_SCOPES = frozenset({
    "zec-funding-note", "stripe-create-refusal",
    "stripe-authorization-terminal", "stripe-session-terminal",
    "stripe-financial-event", "stripe-financial-evidence", "stripe-financial-state",
})

#Codes:func:`blockers` returns; also the 409 ``code`` on the wire.
BLOCKER_EARNINGS_OWED = "earnings_owed"
BLOCKER_APP_HAS_USERS = "app_has_users"
BLOCKER_STAFF_ACCOUNT = "staff_account"
BLOCKERS = (BLOCKER_EARNINGS_OWED, BLOCKER_APP_HAS_USERS, BLOCKER_STAFF_ACCOUNT)

#How long a deleted account's username stays reserved on its row before
#:func:`release_deleted_usernames` frees it: old profile links, @mentions
#and queued jobs keyed by the name cannot be squatted in that window.
USERNAME_RESERVATION = timedelta(days=30)

#A comment chain is at most this deep before the reply sweep gives up and
#clears the rest instead of deleting it. Real threads are far shallower.
_MAX_REPLY_SWEEPS = 64


class PolicyNotApplied(RuntimeError):
    """A relation still holds what its POLICY entry says deletion removes."""


def _relation(name: str):
    from django.apps import apps

    label, field_name = name.rsplit(".", 1)
    return apps.get_model(label), field_name


def policy_violations(creator_pk: int, kept: dict | None = None) -> list[str]:
    """Every POLICY entry the account's rows still contradict.

    ``DELETE``: no row may point at the account except the pks ``kept`` names
    for that entry (protected, held for a report, still used by someone else).
    ``UNLINK``: no row may point at the account at all. ``REVOKE``: no live
    grant, no unrevoked refresh token, no other token or code. ``RETAIN`` and
    ``BLOCK`` impose nothing. Read with the base manager, so a manager that
    hides rows (banned comments) cannot hide them from this check.
    """
    kept = kept or {}
    violations = []
    for name, (action, _why) in POLICY.items():
        if action in (RETAIN, BLOCK):
            continue
        model, field_name = _relation(name)
        rows = model._base_manager.filter(**{field_name: creator_pk})
        if action == REVOKE:
            if name == "oidc.AppAuthorization.user":
                rows = rows.filter(revoked_at__isnull=True)
            elif name == "oidc.RefreshToken.user":
                rows = rows.filter(revoked__isnull=True)
            if rows.exists():
                violations.append(name)
        elif action == UNLINK:
            if rows.exists():
                violations.append(name)
        elif action == DELETE:
            left = set(rows.values_list("pk", flat=True)) - set(kept.get(name, ()))
            if left:
                violations.append(name)
    return violations


class DeletionBlocked(Exception):
    """The account cannot be deleted by its holder right now."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def account_relations():
    """``app_label.Model.field`` for every relation that points at an account."""
    from django.contrib.auth import get_user_model

    user_model = get_user_model()
    names = set()
    for rel in user_model._meta.get_fields(include_hidden=True):
        if rel.is_relation and rel.auto_created and not rel.concrete:
            names.add(f"{rel.related_model._meta.label}.{rel.field.name}")
    return names


#How long after a paid admission its settlement may still arrive (a
#viewer's departure webhook; a reconnect settles another interval of the
#same admission). Inside it, or while a livestream is live, the account is
#treated as owed earnings. Outside it an abandoned join (admitted, never
#delivered) no longer blocks; a settlement later still is recovered by the
#operator's inactive-claimant payout path.
SETTLEMENT_WINDOW = timedelta(hours=72)


def blockers(creator, *, now=None) -> list[str]:
    """Why ``creator`` cannot delete the account themselves, if anything."""
    from dj.apps.economy.models import CreatorPayable
    from dj.apps.oidc.models import AppAuthorization

    from dj.apps.dyte.models import CreatorMeeting
    from dj.apps.economy.models import ServiceAdmission

    now = now or timezone.now()
    found = []
    if creator.is_staff or creator.is_superuser:
        # Another admin removes staff access first: a staff account deleting
        # itself would also strip the audit trail's last live principal.
        found.append(BLOCKER_STAFF_ACCOUNT)
    owed = CreatorPayable.objects.filter(creator_id=creator.pk).filter(
        Q(balance_nusd__gt=0) | Q(held_nusd__gt=0)
    ).exists()
    # Work already admitted (a viewer joined a paid livestream) settles when
    # the provider's departure webhook arrives -- possibly after deletion,
    # creating earnings nobody could then claim. One delivery does not prove
    # the admission is finished (a reconnect settles another interval), and a
    # join that was never used never settles at all, so the rule is a window,
    # not a per-admission state (codex adversarial review).
    unsettled = (
        ServiceAdmission.objects.filter(
            creator_id=creator.pk, admitted_at__gte=now - SETTLEMENT_WINDOW,
        ).exists()
        or CreatorMeeting.objects.filter(creator_id=creator.pk, live_now=True).exists()
    )
    if owed or unsettled:
        found.append(BLOCKER_EARNINGS_OWED)
    from dj.apps.purchases.models import PurchaseIntent

    # Any grant (live or revoked, the holder's own included) or purchase
    # recorded against an owned app keeps it -- the developer console's rule.
    if (
        AppAuthorization.objects.filter(application__user_id=creator.pk).exists()
        or PurchaseIntent.objects.filter(application__user_id=creator.pk).exists()
    ):
        found.append(BLOCKER_APP_HAS_USERS)
    return found


def preview(creator) -> dict:
    """What the confirmation screen states, read for the signed-in holder."""
    from dj.apps.oidc.models import AppAuthorization

    from .models import zPage

    return {
        "username": creator.username,
        "balance_2z": creator.tuzis,
        "connected_apps": AppAuthorization.objects.live().filter(user_id=creator.pk).count(),
        "pages": zPage.objects.filter(creator_id=creator.pk).count(),
        "grace_days": GRACE_PERIOD.days,
        "username_reserved_days": USERNAME_RESERVATION.days,
        "deletion_cancelled_at": creator.deletion_cancelled_at,
        "blockers": blockers(creator),
    }


@dataclass
class DeletionReport:
    """Counts for the log line. Never returned to a client."""

    counts: dict = field(default_factory=dict)
    #POLICY name -> pks a DELETE relation deliberately keeps (protected,
    #held for moderation, still used by someone else). Read by
    #:func:`policy_violations`.
    kept: dict = field(default_factory=dict)

    def add(self, key: str, n: int) -> None:
        if n:
            self.counts[key] = self.counts.get(key, 0) + n

    def keep(self, policy_name: str, pks) -> None:
        self.kept.setdefault(policy_name, set()).update(pks)


def tombstone_username() -> str:
    """A fresh, unguessable username for the pseudonymized row."""
    return f"deleted_{secrets.token_hex(8)}"


#Raised inside the lock when what the caller proved no longer holds.
REAUTHENTICATE = "reauthenticate"
CONFIRMATION_MISMATCH = "confirmation_mismatch"


def delete_account(creator, *, confirm_username: str, auth_epoch: int) -> DeletionReport:
    """Delete ``creator``'s account. Raises:class:`DeletionBlocked`.

    One transaction: either the account is deleted and every credential is
    gone, or nothing changed.

    ``auth_epoch`` is the account epoch of the recent sign-in the caller
    proved, and ``confirm_username`` what the holder typed. Both are checked
    again **under the row lock**: a password reset or another ownership event
    that commits while this request waits for the lock moves the epoch and
    evicts the credential that asked, so the deletion must not then proceed on
    the recovered account (codex adversarial review). A rename racing the
    request is refused the same way.
    """
    from .models import Creator

    with transaction.atomic():
        creator = Creator.objects.select_for_update().get(pk=creator.pk)
        if not creator.is_active:
            raise DeletionBlocked("inactive")
        if creator.kt_account_epoch != auth_epoch:
            raise DeletionBlocked(REAUTHENTICATE)
        if creator.username != confirm_username:
            raise DeletionBlocked(CONFIRMATION_MISMATCH)
        found = blockers(creator)
        if found:
            raise DeletionBlocked(found[0])
        return _purge_locked(creator)


def _purge_locked(creator) -> DeletionReport:
    """The deletion itself, on a row the caller has locked and checked.

    Shared by:func:`delete_account` (the holder's proofs) and
    :func:`purge_due_deletions` (a schedule whose grace period ended). Must
    run inside the caller's transaction.
    """
    from dj.apps.ktauth.epoch import EVENT_ACCOUNT_DELETED, bump_account_epoch

    report = DeletionReport()
    _delete_unused_apps(creator, report)
    _revoke_connected_apps(creator, report)
    _delete_credentials(creator, report)
    held = _moderation_hold(creator)
    _delete_content(creator, report, held)
    _unlink_records(creator, report)
    _scrub_profile(creator, keep_public_profile=held.everything)
    _scrub_idempotency_response_bodies(creator, report)
    # After every credential is gone, in the same transaction (the
    # function's own contract): signs out every session and token.
    bump_account_epoch(creator.pk, event=EVENT_ACCOUNT_DELETED)
    # Fail closed: a relation whose policy was not carried out rolls the
    # whole deletion back rather than reporting success over it.
    violations = policy_violations(creator.pk, report.kept)
    if violations:
        logger.error(
            "account deletion aborted: policy not applied for user=%s: %s",
            creator.pk, violations,
        )
        raise PolicyNotApplied(violations)

    pk, public_id, counts = creator.pk, creator.public_id, dict(report.counts)
    transaction.on_commit(lambda: logger.info(
        "account deleted: user=%s public_id=%s counts=%s",
        pk, public_id, counts,
        extra={"event": "account_deleted", "user_id": pk,
               "deleted_counts": counts},
    ))
    return report


def _scrub_idempotency_response_bodies(creator, report) -> None:
    """Remove replayable content without deleting retained money records.

    Reconciliation scopes keep their operational references and charge state;
    fields explicitly classified as content are removed from translation
    receipts. Financial proof scopes are left intact, including the legacy ZEC
    note observation whose note identity is immutable at the database layer.
    """
    from django.db import connection

    from dj.apps.g12f.translation import charges
    from dj.apps.tuzis.models import IdempotencyKey

    replay_scope = Q(scope__in=CONTENT_REPLAY_SCOPES)
    for prefix in CONTENT_REPLAY_SCOPE_PREFIXES:
        replay_scope |= Q(scope__startswith=prefix)
    cleared = IdempotencyKey.objects.filter(
        user_id=creator.pk,
    ).filter(replay_scope).exclude(scope="ai_image").update(response_body=None)

    # Row locks serialize against all image writers, including a provider
    # callback/completion that retained a pre-deletion Python response body.
    from dj.apps.openai.image_receipts import scrub_image_receipt
    with transaction.atomic():
        for receipt in IdempotencyKey.objects.select_for_update().filter(
            user_id=creator.pk, scope="ai_image",
        ):
            receipt.response_body = scrub_image_receipt(receipt.response_body)
            receipt.request_hash = None
            receipt.save(update_fields=["response_body", "request_hash"])
            cleared += 1

    # This is one SQL expression, so PostgreSQL locks each matching row and
    # subtracts from its latest committed JSON value. A translation settlement
    # that already owns the row can finish first without its new charge state
    # being overwritten by a body read before the lock wait.
    translation_keys = sorted(
        RECONCILIATION_RESPONSE_BODY_SCRUB_KEYS[charges.SCOPE]
    )
    table = connection.ops.quote_name(IdempotencyKey._meta.db_table)
    marker = {charges.ACCOUNT_DELETION_SCRUB_MARKER: True}
    with connection.cursor() as cursor:
        cursor.execute(
            f"UPDATE {table} "
            "SET response_body = CASE "
            "WHEN jsonb_typeof(response_body) = 'object' "
            "THEN (response_body - %s::text[]) || %s::jsonb "
            "ELSE %s::jsonb END "
            "WHERE user_id = %s AND scope = %s",
            [translation_keys, json.dumps(marker), json.dumps(marker),
             creator.pk, charges.SCOPE],
        )
        scrubbed = cursor.rowcount
    report.add("idempotency_responses_cleared", cleared)
    report.add("idempotency_reconciliation_bodies_scrubbed", scrubbed)


# ---------------------------------------------------------------------------


def _delete_unused_apps(creator, report) -> None:
    from dj.apps.oidc.models import AppAuthorization, F2ZApplication

    # Lock order: the Creator row (taken by delete_account) -> these app rows.
    # Consent takes KEY SHARE on the consenting Creator before the app, so
    # even a self-owned app cannot form the inverse app -> Creator cycle at
    # deferred-FK commit. If consent holds the Creator first, its grant
    # commits before deletion checks; the re-check below then blocks deletion.
    # If deletion holds it first, consent waits and observes the inactive
    # account without writing a grant. The re-check is the developer console's
    # rule, applied under the app lock: ``blockers()`` ran before the lock, and
    # a grant committed in between would otherwise be cascaded away with the
    # app (codex adversarial review).
    for app in F2ZApplication.objects.select_for_update().filter(user_id=creator.pk):
        if AppAuthorization.objects.filter(application_id=app.pk).exists():
            raise DeletionBlocked(BLOCKER_APP_HAS_USERS)
        try:
            with transaction.atomic():
                app.delete()
        except models.ProtectedError:
            # Something besides a grant (a purchase intent) records it. Same
            # answer as a grant: it must stay attributable.
            logger.warning(
                "account deletion refused: app %s is still referenced", app.client_id,
            )
            raise DeletionBlocked(BLOCKER_APP_HAS_USERS) from None
        report.add("apps", 1)


def _revoke_connected_apps(creator, report) -> None:
    from dj.apps.oidc import consent
    from dj.apps.oidc.models import (
        AccessToken, AppAuthorization, AuthorizationCode, DeviceGrant, IDToken,
        RefreshToken,
    )

    for authorization in (
        AppAuthorization.objects.live().filter(user_id=creator.pk)
        .select_related("application")
    ):
        consent.revoke_authorization(creator, authorization.application)
        report.add("grants_revoked", 1)
    # Anything a grant row did not account for: tokens of an app whose grant
    # was already revoked, a device flow in progress. Nothing may survive.
    AuthorizationCode.objects.filter(user_id=creator.pk).delete()
    for family in set(
        RefreshToken.objects.filter(user_id=creator.pk, revoked__isnull=True)
        .values_list("token_family", flat=True)
    ):
        RefreshToken.revoke_family(family)
    AccessToken.objects.filter(user_id=creator.pk).delete()
    IDToken.objects.filter(user_id=creator.pk).delete()
    DeviceGrant.objects.filter(user_id=creator.pk).delete()


def _delete_credentials(creator, report) -> None:
    from dj.apps.emails.models import Email
    from dj.apps.identity.models import AuthContext, RecoveryCode, WebAuthnCredential
    from dj.apps.otp.models import OTPSecret
    from dj.apps.social.models import SocialIdentity
    from dj.apps.twitter.models import TwitterProfile
    from dj.apps.zauth.models import ZcashIdentity

    for model, column in (
        (Email, "user_id"),
        (OTPSecret, "user_id"),
        (WebAuthnCredential, "creator_id"),
        (RecoveryCode, "creator_id"),
        (SocialIdentity, "creator_id"),
        (TwitterProfile, "creator_id"),
        (ZcashIdentity, "creator_id"),
        (AuthContext, "creator_id"),
    ):
        # By the account's own key only. Several personas may one day share a
        # recovery address: never select by the address itself.
        deleted, _ = model.objects.filter(**{column: creator.pk}).delete()
        report.add(model._meta.label, deleted)
    creator.groups.clear()
    creator.user_permissions.clear()


def _delete_content(creator, report, held) -> None:
    from dj.apps.comments.models import Comment, ContentReport, UUIDTaggedItem
    from dj.apps.e2ee.models import ChatRequest
    from dj.apps.openai.models import Conversation, Personality, PromptResponse
    from dj.apps.storytime.models import Story
    from dj.apps.uploads.models import GenericFile

    from .models import (
        CreatorBlock, CreatorFollow, CreatorMute, PageMentionDelivery, Series,
        zPage,
    )

    from dj.apps.search.models import SearchIndex
    from django.contrib.contenttypes.models import ContentType

    pk = creator.pk
    if held.everything:
        # A report against the account itself: keep its content, hidden
        # behind is_active=False, until staff resolve the report.
        report.add("held_for_open_report", 1)
    # Vectors first: they hang off a generic key with no cascade, and the
    # deactivation receiver finds them through pages that still exist.
    SearchIndex.objects.filter(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id__in=zPage.objects.filter(creator_id=pk).values("pk"),
    ).delete()
    pages = zPage.objects.filter(creator_id=pk)
    if held.everything:
        report.keep("g12f.zPage.creator", pages.values_list("pk", flat=True))
        pages = pages.none()
    report.keep("g12f.zPage.creator", pages.filter(
        free2zaddr__in=held.pages).values_list("pk", flat=True))
    for page_id in list(pages.exclude(free2zaddr__in=held.pages).values_list("pk", flat=True)):
        try:
            # A savepoint per page, like the page DELETE route: a refusal must
            # leave the outer transaction usable.
            with transaction.atomic():
                zPage.objects.get(pk=page_id).delete()
            report.add("pages", 1)
        except models.ProtectedError:
            report.add("pages_retained_hidden", 1)
            report.keep("g12f.zPage.creator", [page_id])

    for series in Series.objects.filter(creator_id=pk):
        if held.any:
            report.keep("g12f.Series.creator", [series.pk])
            continue
        try:
            with transaction.atomic():
                series.delete()
            report.add("series", 1)
        except models.ProtectedError:
            report.add("series_retained_hidden", 1)
            report.keep("g12f.Series.creator", [series.pk])

    # A comment somebody else replied to keeps the thread together: deleting
    # it would cascade THEIR replies away. Delete leaves first, repeatedly, so
    # a chain of the holder's own replies goes entirely; clear what is left.
    # The base manager: ``Comment.objects`` hides banned comments, and a
    # banned comment is still the holder's text (codex adversarial review).
    authored = Comment._base_manager.filter(author_id=pk)
    # Held comments stay for staff but leave public view: a comment inherits
    # its page's visibility, not its author's, so deactivation alone would
    # leave it readable under someone else's public page.
    held_comments = authored if held.everything else authored.filter(pk__in=held.comments)
    report.add("comments_held_hidden", held_comments.update(is_banned=True))
    comments = authored.exclude(pk__in=held.comments)
    if held.everything:
        comments = comments.none()
    for _ in range(_MAX_REPLY_SWEEPS):
        deleted, _ = comments.filter(replies__isnull=True).delete()
        if not deleted:
            break
        report.add("comments", deleted)
    # What stays is a thread placeholder: no text and no tags (the API also
    # serves it with no author, comments.visibility.author_redacted).
    UUIDTaggedItem.objects.filter(
        content_type=ContentType.objects.get_for_model(Comment),
        object_id__in=comments.values("uuid"),
    ).delete()
    report.add("comments_cleared", comments.update(content="", headline=""))
    report.keep("comments.Comment.author", authored.values_list("pk", flat=True))
    ContentReport.objects.filter(reporter_id=pk).update(reporter=None)

    report.add("conversations", Conversation.objects.filter(user_id=pk).delete()[0])
    # The base manager: ``PromptResponse.objects`` hides a pending account's
    # turns, and this account is still pending until the purge commits.
    report.add("prompt_responses",
               PromptResponse._base_manager.filter(user_id=pk).delete()[0])
    # A personality other people's conversations use stays: deleting it would
    # cascade their conversations away.
    in_use = Q(conversation__isnull=False) | Q(promptresponse__isnull=False)
    report.add(
        "personalities",
        Personality.objects.filter(creator_id=pk).exclude(in_use).delete()[0],
    )
    # Kept for other people's conversations, but no longer listed publicly.
    Personality.objects.filter(creator_id=pk).update(is_public=False)
    report.keep("openai.Personality.creator",
                Personality.objects.filter(creator_id=pk).values_list("pk", flat=True))
    report.add("stories", Story.objects.filter(creator_id=pk).delete()[0])
    report.add(
        "chat_requests",
        ChatRequest.objects.filter(Q(sender_id=pk) | Q(recipient_id=pk)).delete()[0],
    )
    report.add(
        "follows",
        CreatorFollow.objects.filter(Q(creator_id=pk) | Q(follower_id=pk)).delete()[0],
    )
    report.add(
        "blocks",
        CreatorBlock.objects.filter(Q(blocker_id=pk) | Q(blocked_id=pk)).delete()[0],
    )
    report.add(
        "mutes",
        CreatorMute.objects.filter(Q(muter_id=pk) | Q(muted_id=pk)).delete()[0],
    )
    report.add(
        "mentions",
        PageMentionDelivery.objects.filter(
            Q(author_id=pk) | Q(recipient_id=pk)).delete()[0],
    )
    # Last: pages above may have pointed at these files. The uploads
    # pre_delete hook queues every stored blob for deletion. While anything
    # is held for a report, the files stay too: a held page's media is part
    # of what was reported.
    if held.any:
        report.keep("uploads.GenericFile.owner",
                    GenericFile.objects.filter(owner_id=pk).values_list("pk", flat=True))
    else:
        report.add("uploads", GenericFile.objects.filter(owner_id=pk).delete()[0])


@dataclass(frozen=True)
class _Hold:
    everything: bool
    pages: frozenset
    comments: frozenset

    @property
    def any(self) -> bool:
        return self.everything or bool(self.pages) or bool(self.comments)


def _moderation_hold(creator) -> _Hold:
    """Content under an open moderation report is not erased by its author.

    A self-service deletion must not destroy what a report (a CSAE report
    above all) is about before staff have looked at it. The held items stay,
    hidden behind ``is_active=False``; staff resolve the report and remove
    them. The holder is not told: that would tell them about the report.
    """
    from dj.apps.comments.models import Comment, ContentReport

    from .models import zPage

    open_reports = ContentReport.objects.filter(status__in=("open", "reviewing"))
    everything = open_reports.filter(
        target_kind="creator", target_id=str(creator.pk)).exists()
    page_addrs = set(zPage.objects.filter(creator_id=creator.pk)
                     .values_list("free2zaddr", flat=True))
    pages = frozenset(
        open_reports.filter(target_kind="zpage", target_id__in=page_addrs)
        .values_list("target_id", flat=True)
    ) if page_addrs else frozenset()
    comment_ids = {str(c) for c in Comment._base_manager.filter(author_id=creator.pk)
                   .values_list("pk", flat=True)}
    comments = frozenset(
        open_reports.filter(target_kind="comment", target_id__in=comment_ids)
        .values_list("target_id", flat=True)
    ) if comment_ids else frozenset()
    return _Hold(everything=everything, pages=pages, comments=comments)


def _unlink_records(creator, report) -> None:
    """Do to the ``SET_NULL`` relations what a real delete would."""
    from dj.apps.dyte.models import (
        ProviderRoomCleanup, RecordingDelivery, RecordingDeliveryTarget,
    )
    from dj.apps.exports.models import PublicationExportJob
    from dj.apps.tagging.models import TagSuggestion
    from dj.apps.twitter.models import Announcement

    pk = creator.pk
    # A recording retry with no creator terminalizes (dyte.tasks) instead of
    # downloading the recording into a new upload for a deleted account.
    report.add("recordings_unlinked", RecordingDelivery.objects.filter(
        creator_id=pk).update(creator=None))
    RecordingDeliveryTarget.objects.filter(creator_id=pk).update(creator=None)
    ProviderRoomCleanup.objects.filter(creator_id=pk).update(creator=None)
    PublicationExportJob.objects.filter(creator_id=pk).update(creator=None)
    TagSuggestion.objects.filter(decided_by_id=pk).update(decided_by=None)
    from dj.apps.oidc.models import AiOutputReport, AudienceChange

    # The audit row is evidence of what an app declared; only who is unlinked.
    AudienceChange.objects.filter(changed_by_id=pk).update(changed_by=None)

    # The report stays; the reporter goes, and so does their free text unless
    # staff have not finished with it (open or reviewing) -- the same rule
    # as a comment under an open report.
    from django.db.models import Case, F, Value, When

    AiOutputReport.objects.filter(reporter_id=pk).update(
        reporter=None,
        detail=Case(
            When(status__in=(AiOutputReport.Status.OPEN, AiOutputReport.Status.REVIEWING),
                 then=F("detail")),
            default=Value(""),
        ),
    )

    # Nothing of theirs is announced from now on. A row whose create may
    # already have reached X (posting / needs_reconciliation) keeps its copy:
    # reconciling it needs the text, and an operator owns that state.
    in_flight = (Announcement.POSTING, Announcement.NEEDS_RECONCILIATION)
    mine = Announcement.objects.filter(subject_user_id=pk)
    report.add("announcements_suppressed", mine.filter(
        status__in=(Announcement.PENDING, Announcement.GENERATING),
    ).update(status=Announcement.SUPPRESSED, reason="account_deleted", lease=None))
    mine.exclude(status__in=in_flight).update(
        text="", url="", image_data=None, media_id="", last_error="",
    )
    mine.update(subject_user=None)


def _scrub_profile(creator, *, keep_public_profile: bool = False) -> None:
    from dj.apps.handles.models import MessagingHandle
    from dj.apps.handles.reservation import STATUS_RETIRED

    # Retired, then unlinked: the same two steps a real delete takes
    # (``handles.signals.retire_on_delete`` + SET_NULL), so the handle a
    # key-transparency log already vouched for is never re-issued.
    MessagingHandle.objects.filter(user_id=creator.pk).update(
        status=STATUS_RETIRED, user=None,
    )

    creator.email = ""
    creator.first_name = ""
    creator.last_name = ""
    if not keep_public_profile:
        # Under an open report against the account itself, the public
        # profile is part of what was reported: it stays (hidden) for staff.
        creator.full_name = ""
        creator.description = ""
        creator.avatar_url = ""
        creator.banner_url = ""
        creator.avatar_image = None
        creator.banner_image = None
        creator.p2paddr = ""
    creator.mention_notifications_enabled = False
    creator.is_active = False
    creator.is_staff = False
    creator.is_superuser = False
    creator.is_verified = False
    creator.set_unusable_password()
    # The username is NOT changed here: on this row it stays reserved for
    # USERNAME_RESERVATION, so nobody can register it and inherit old profile
    # links, @mentions or a job queued under the name.
    # ``release_deleted_usernames`` frees it afterwards.
    creator.deleted_at = timezone.now()
    # A real save (not.update()) so the deactivation receiver drops the
    # account's search vectors.
    creator.save(update_fields=[
        "email", "first_name", "last_name", "full_name",
        "description", "avatar_url", "banner_url", "avatar_image",
        "banner_image", "p2paddr", "mention_notifications_enabled",
        "is_active", "is_staff", "is_superuser", "is_verified", "password",
        "password_set", "deleted_at", "updated_at",
    ])


def release_deleted_usernames(*, now=None, limit: int = 500) -> int:
    """Free the usernames of accounts deleted more than USERNAME_RESERVATION
    ago. Returns how many were released.

    The row is renamed to a random ``deleted_<hex>``, and so is the
    ``TuziGrant`` username snapshot. ``username_ci_legacy`` is cleared too: it
    is the old name itself (only now, with a new username -- clearing it on
    the old one would put a grandfathered duplicate back into the unique
    index). An account still under an open report against it keeps its name
    until staff resolve the report. Idempotent; safe to run on any schedule.
    """
    from dj.apps.comments.models import ContentReport
    from dj.apps.tuzis.models import TuziGrant

    from .models import Creator

    cutoff = (now or timezone.now()) - USERNAME_RESERVATION
    held = ContentReport.objects.filter(
        target_kind="creator", status__in=("open", "reviewing"),
    ).values_list("target_id", flat=True)
    due = (
        Creator.objects.filter(
            deleted_at__lte=cutoff, is_active=False,
            username_released_at__isnull=True,
        )
        .exclude(pk__in=[int(t) for t in held if str(t).isdigit()])
        .values_list("pk", flat=True)[:limit]
    )
    released = 0
    for pk in list(due):
        with transaction.atomic():
            row = Creator.objects.select_for_update().get(pk=pk)
            if row.is_active or row.username_released_at is not None:
                continue
            new = tombstone_username()
            Creator.objects.filter(pk=pk).update(
                username=new, username_ci_legacy=None,
                username_released_at=timezone.now())
            TuziGrant.objects.filter(creator_id=pk).update(username=new)
            released += 1
    if released:
        logger.info("released %d deleted account username(s)", released)
    return released


# ---------------------------------------------------------------------------
# The 30-day grace period: request -> (sign in to keep) -> purge.
# ---------------------------------------------------------------------------
#
# Owner decision (2026-10-14): deletion is requested, not immediate. The
# account goes inactive at once (hidden by every / gate, every
# session, token and app grant revoked) and is purged GRACE_PERIOD later.
# Signing in during the grace period is how the holder keeps the account --
# the "sign in within 30 days to keep your account" pattern -- but never
# silently: every sign-in path calls:func:`login_gate`, which mints no
# credential for a pending account and answers with a short-lived signed
# KEEP token instead; only an explicit "Keep my account" spends it
# (:func:`keep_account`), reactivates the account and then signs in.

GRACE_PERIOD = timedelta(days=30)
#At most this many published pages are re-queued for search when an
#account is kept (most recently updated first), so the keep answers fast.
KEEP_REINDEX_LIMIT = 500
#How long a keep token, minted by a successful sign-in, may be spent.
KEEP_TOKEN_MAX_AGE = 600
_KEEP_TOKEN_SALT = "dj.apps.g12f.account_deletion.keep"
#A purge blocked by a blocker logs (and alerts) at most once per account
#per this interval, however often the purge runs.
BLOCKED_PURGE_ALERT_INTERVAL = timedelta(hours=24)

DELETION_PENDING = "deletion_pending"

#The cookie that binds a browser's keep token to the browser that signed in
#(see:func:`mint_keep_token`). HttpOnly, SameSite=Strict, scoped to the
#keep endpoint.
KEEP_COOKIE = "f2z_keep"
KEEP_COOKIE_PATH = "/api/auth/account-deletion/keep/"

#The structured line a blocked purge writes; the ticket-tier alert policy
#``monitoring/alert-policies/account-deletion-purge-blocked.json`` matches it.
PURGE_BLOCKED_EVENT = "account_deletion_purge_blocked"


def purge_blocked_payload(creator_pk: int, found) -> dict:
    """The blocked-purge alert line. The internal account id (support opens
    the account in the Django admin) and the blocker codes; nothing else."""
    return {
        "event": PURGE_BLOCKED_EVENT,
        "user_id": int(creator_pk),
        "blockers": ",".join(found),
    }


class DeletionPending(Exception):
    """A sign-in reached an account whose deletion is pending."""

    def __init__(self, creator, keep_token: str, browser_nonce: str | None = None):
        self.purge_after = creator.purge_after
        self.keep_token = keep_token
        self.browser_nonce = browser_nonce
        super().__init__(DELETION_PENDING)

    def bind(self, response):
        """Set the browser-binding cookie on the response that carries this
        keep token (see:func:`mint_keep_token`). Every path that answers a
        browser sign-in with a keep token sends it through here."""
        if self.browser_nonce is not None:
            from django.conf import settings

            response.set_cookie(
                KEEP_COOKIE, self.browser_nonce, max_age=KEEP_TOKEN_MAX_AGE,
                path=KEEP_COOKIE_PATH, secure=not settings.DEBUG,
                httponly=True, samesite="Strict",
            )
        return response

    def payload(self) -> dict:
        return {
            "code": DELETION_PENDING,
            "detail": "This account is scheduled for deletion. Keep it to sign in.",
            "purge_after": self.purge_after.isoformat(),
            "keep_token": self.keep_token,
        }


INACTIVE_ACCOUNT_DETAIL = "This account is inactive and cannot sign in."


class InactiveAccount(Exception):
    """A credential proved an account that is inactive outside deletion grace."""

    detail = INACTIVE_ACCOUNT_DETAIL

    def __init__(self):
        super().__init__(self.detail)


def ensure_account_can_sign_in(creator) -> None:
    """Refuse inactive accounts except the one pending-deletion keep flow.

    This is checked as soon as a provider identity is resolved, before login
    routes create session state or issue a Knox credential. The pending
    deletion exception remains deferred to:func:`login_gate`, after any
    required second factor has been verified.
    """
    if not creator.is_active and not keep_allowed(creator):
        raise InactiveAccount()


def deletion_pending_q(prefix: str = "") -> Q:
    """Rows whose ``{prefix}`` account's deletion is pending: hidden even
    where they are served under someone else's object (a comment on another
    creator's page, a prompt/response in another member's public fork),
    which plain deactivation does not reach. Reversible by a keep; the purge
    deletes them."""
    return Q(**{
        f"{prefix}is_active": False,
        f"{prefix}deletion_requested_at__isnull": False,
        f"{prefix}deleted_at__isnull": True,
    })


def _record_event(creator, kind: str, *, at=None, **detail) -> None:
    from .models import AccountDeletionEvent

    AccountDeletionEvent.objects.create(
        creator_id=creator.pk, kind=kind, at=at or timezone.now(), detail=detail)


def _login_identity_querysets(creator_pk):
    from dj.apps.identity.models import WebAuthnCredential
    from dj.apps.social.models import SocialIdentity
    from dj.apps.twitter.models import TwitterProfile
    from dj.apps.zauth.models import ZcashIdentity

    return [
        model.objects.filter(creator_id=creator_pk)
        for model in (SocialIdentity, TwitterProfile, ZcashIdentity, WebAuthnCredential)
    ]


def _usable_login_identities(creator_pk):
    """Snapshot, before an epoch bump, every sign-in identity not rejected
    as a fallback: ``[(queryset, [(pk, linked_at_epoch),...]),...]``."""
    return [
        (qs, list(qs.filter(fallback_rejected_at_epoch__isnull=True)
                  .values_list("pk", "linked_at_epoch")))
        for qs in _login_identity_querysets(creator_pk)
    ]


def _carry_login_identities(snapshot, old_epoch: int, new_epoch: int) -> None:
    """Carry the account's sign-in identities across a grace-period epoch bump.

    Requesting deletion and keeping the account are ownership events because
    they must end every credential already HANDED OUT (sessions, Knox tokens,
    the keep token). They change nothing about WHO may sign in: the holder's
    X, wallet, social and passkey identities are exactly as trustworthy after
    the request as before it -- and signing in with one is how the holder
    keeps the account. Left alone, the bump would make every identity linked
    at the old epoch stale (``ktauth.credentials``), so an account with a
    password could keep only by password, and a passwordless one only through
    its oldest identity. So each identity that could sign in before the bump
    can sign in after it, and no other: current ones are restamped to the new
    epoch, and the bump's own fallback marking is undone for a stale one that
    was the account's surviving fallback. Rows the bump did not see as usable
    stay as they were.
    """
    for qs, rows in snapshot:
        current = [pk for pk, linked in rows if linked == old_epoch]
        fallback = [pk for pk, linked in rows if linked < old_epoch]
        if current:
            qs.filter(pk__in=current).update(
                linked_at_epoch=new_epoch, fallback_rejected_at_epoch=None)
        if fallback:
            qs.filter(pk__in=fallback, fallback_rejected_at_epoch=new_epoch).update(
                fallback_rejected_at_epoch=None)


def _bump_carrying_identities(creator, event: str) -> None:
    """``bump_account_epoch`` for the grace-period events, with the sign-in
    identities carried across (:func:`_carry_login_identities`). ``creator``
    is the row-locked instance; its epoch is refreshed."""
    from dj.apps.ktauth.epoch import bump_account_epoch

    old_epoch = creator.kt_account_epoch
    snapshot = _usable_login_identities(creator.pk)
    bump_account_epoch(creator.pk, event=event)
    creator.refresh_from_db(fields=["kt_account_epoch"])
    _carry_login_identities(snapshot, old_epoch, creator.kt_account_epoch)


def banned_while_pending(creator) -> bool:
    """A moderation ban landed after this deletion request. Such an account
    still purges on schedule, but a sign-in can no longer keep it: keeping
    sets ``is_active`` back to True, which would quietly lift the ban."""
    from .models import AccountDeletionEvent

    if creator.deletion_requested_at is None:
        return False
    return AccountDeletionEvent.objects.filter(
        creator_id=creator.pk, kind="banned",
        at__gte=creator.deletion_requested_at,
    ).exists()


def note_ban(creator) -> None:
    """Called by ``Creator.ban_and_soft_delete``. A ban only sets
    ``is_active=False`` -- which a pending account already is -- so without
    this record the ban would be invisible to:func:`keep_account`.

    Decides from the row, never from ``creator``: callers (the AI comment
    scorer) load the instance well before the ban, and a request committed
    in between would be invisible on it. Read after the ban's save, the row
    is exact: a request that starts later finds the account inactive and is
    refused."""
    from .models import Creator

    row = Creator.objects.filter(pk=creator.pk).values(
        "deletion_requested_at", "deleted_at").first()
    if row is None or row["deletion_requested_at"] is None or row["deleted_at"] is not None:
        return
    _record_event(creator, "banned")
    logger.warning(
        "account banned while its deletion is pending: user=%s (no keep)",
        creator.pk, extra={"event": "account_deletion_banned", "user_id": creator.pk},
    )


def schedule_deletion(creator, *, confirm_username: str, auth_epoch: int):
    """Request deletion: deactivate now, purge after GRACE_PERIOD.

    The holder's proofs are checked under the row lock exactly as
    :func:`delete_account` checks them. Every credential already handed out
    stops working (ownership event ``account_deletion_scheduled``) and every
    app grant is revoked; the password and sign-in identities stay, so the
    holder can come back and keep the account. Returns ``purge_after``.
    """
    from dj.apps.ktauth.epoch import EVENT_ACCOUNT_DELETION_SCHEDULED

    from .models import Creator

    with transaction.atomic():
        creator = Creator.objects.select_for_update().get(pk=creator.pk)
        if not creator.is_active:
            raise DeletionBlocked("inactive")
        if creator.kt_account_epoch != auth_epoch:
            raise DeletionBlocked(REAUTHENTICATE)
        if creator.username != confirm_username:
            raise DeletionBlocked(CONFIRMATION_MISMATCH)
        found = blockers(creator)
        if found:
            raise DeletionBlocked(found[0])

        now = timezone.now()
        report = DeletionReport()
        _revoke_connected_apps(creator, report)
        creator.deletion_requested_at = now
        creator.purge_after = now + GRACE_PERIOD
        creator.is_active = False
        # A real save so the deactivation receiver drops the search vectors.
        creator.save(update_fields=[
            "deletion_requested_at", "purge_after", "is_active", "updated_at",
        ])
        _bump_carrying_identities(creator, EVENT_ACCOUNT_DELETION_SCHEDULED)
        _record_event(creator, "scheduled", purge_after=creator.purge_after.isoformat())
    logger.info(
        "account deletion scheduled: user=%s purge_after=%s",
        creator.pk, creator.purge_after.isoformat(),
        extra={"event": "account_deletion_scheduled", "user_id": creator.pk},
    )
    return creator.purge_after


# -- signing in during the grace period -------------------------------------


def _nonce_hash(nonce: str) -> str:
    import hashlib

    return hashlib.sha256(nonce.encode()).hexdigest()


def mint_keep_token(creator, *, methods, second_factor=None, credential: str):
    """A short-lived proof that ``creator``'s holder just signed in:
    ``(keep_token, browser_nonce)``.

    ``credential`` is what to issue once the account is kept: ``"session"``
    (a browser) or ``"knox"`` (a native app). The epoch binds it: any
    ownership event (another cancel, a password reset) voids it.

    A ``"session"`` token is also bound to the browser that signed in: it
    carries the hash of a random nonce that the same response sets as the
    :data:`KEEP_COOKIE` (HttpOnly, SameSite=Strict). Without that, a token
    for an attacker's own pending account -- auto-submitted by a cross-site
    form, or sent as a keep-page link -- would sign the victim's browser in
    to the attacker's account (login CSRF). A ``"knox"`` token is answered
    in a response body only its caller can read, so it needs no binding.
    """
    from django.core import signing

    # "t": when the holder proved it. The keep signs in with THAT time, not
    # the redemption's: a token spent minutes later must not look like a
    # fresh sign-in to the recent-authentication checks.
    claims = {"u": creator.pk, "e": creator.kt_account_epoch, "m": list(methods),
              "f": second_factor, "c": credential, "t": int(timezone.now().timestamp())}
    nonce = None
    if credential == "session":
        nonce = secrets.token_urlsafe(32)
        claims["n"] = _nonce_hash(nonce)
    return signing.dumps(claims, salt=_KEEP_TOKEN_SALT, compress=True), nonce


def keep_allowed(creator) -> bool:
    """The one inactive state whose holder may sign in, to keep: deletion
    requested, not yet purged, and no ban since. Still true after
    ``purge_after`` until the purge actually runs -- a purge blocked by
    earnings owed must not lock the holder out of the account they need
    to settle (or keep)."""
    return (
        not creator.is_active
        and creator.deletion_pending()
        and not banned_while_pending(creator)
    )


def login_gate(creator, *, methods, second_factor=None, credential: str) -> None:
    """Every sign-in path calls this after proving the holder and BEFORE it
    creates a session or token. Raises:class:`DeletionPending` for an
    account in its grace period; does nothing for any other account (an
    inactive account is refused with a clear error."""
    ensure_account_can_sign_in(creator)
    if creator.is_active:
        return
    token, nonce = mint_keep_token(
        creator, methods=methods, second_factor=second_factor, credential=credential,
    )
    raise DeletionPending(creator, token, nonce)


class KeepTokenInvalid(Exception):
    pass


def read_keep_token(keep_token: str, *, browser_nonce: str | None = None) -> dict:
    """The claims of a valid, unexpired keep token, checked against the
    browser binding; raises:class:`KeepTokenInvalid`. Spends nothing."""
    from django.core import signing

    try:
        claims = signing.loads(keep_token, salt=_KEEP_TOKEN_SALT, max_age=KEEP_TOKEN_MAX_AGE)
    except signing.BadSignature:
        raise KeepTokenInvalid("bad or expired keep token") from None
    bound = claims.get("n")
    if claims.get("c") == "session" and not bound:
        raise KeepTokenInvalid("a browser keep token must be bound")
    if bound is not None and (
        not browser_nonce
        or not secrets.compare_digest(_nonce_hash(browser_nonce), bound)
    ):
        raise KeepTokenInvalid("keep token was issued to another browser")
    return claims


def keep_auth_time(claims):
    """When the sign-in a keep token records was proved."""
    from datetime import datetime, timezone as dt_timezone

    return datetime.fromtimestamp(claims["t"], tz=dt_timezone.utc)


def keep_account(keep_token: str, *, browser_nonce: str | None = None):
    """Spend a keep token: reactivate the account and return
    ``(creator, claims)`` for the caller to sign the holder in with.

    Single use by construction: keeping is an ownership event, so the epoch
    the token is bound to moves, and the account is no longer pending.
    App grants stay revoked; apps ask to connect again.
    """
    from dj.apps.ktauth.epoch import EVENT_ACCOUNT_DELETION_CANCELLED

    from .models import Creator

    claims = read_keep_token(keep_token, browser_nonce=browser_nonce)
    with transaction.atomic():
        creator = Creator.objects.select_for_update().filter(pk=claims["u"]).first()
        if (
            creator is None
            or creator.kt_account_epoch != claims["e"]
            or not keep_allowed(creator)
        ):
            raise KeepTokenInvalid("this account is not waiting to be kept")
        now = timezone.now()
        requested, purge_after = creator.deletion_requested_at, creator.purge_after
        # Again, under the lock: a consent that was mid-flight when the
        # deletion was requested can commit its grant after the request's
        # revocation. "Apps ask to connect again" holds only if the keep
        # revokes whatever is live now.
        _revoke_connected_apps(creator, DeletionReport())
        creator.is_active = True
        creator.deletion_requested_at = None
        creator.purge_after = None
        creator.deletion_cancelled_at = now
        creator.save(update_fields=[
            "is_active", "deletion_requested_at", "purge_after",
            "deletion_cancelled_at", "updated_at",
        ])
        _bump_carrying_identities(creator, EVENT_ACCOUNT_DELETION_CANCELLED)
        _record_event(creator, "cancelled", requested_at=requested.isoformat(),
                      purge_after=purge_after.isoformat())
        # After commit, NOT in the keep's transaction: the work grows with the
        # account's published pages, and a keep must never roll back (and
        # cost the holder their account at the purge date) because a large
        # inventory outlasted the request. Missing search vectors only cost
        # findability until a page is next saved.
        kept_for_index = creator.pk
        transaction.on_commit(lambda: _reindex_published_pages_robust(kept_for_index))
        transaction.on_commit(lambda: _notify_cancelled(creator.pk))
        # In the transaction, not on commit: the renewal jobs commit with the
        # reactivation or not at all (a keep token cannot be spent twice, so
        # a lost post-commit enqueue could never be retried).
        _rearm_incoming_renewals(creator.pk)
        #...and once more after commit: a pending job that a worker claimed
        # before this commit read the account still inactive and scheduled
        # nothing (the jobs.transactional re-check, for the same race).
        kept_pk = creator.pk
        transaction.on_commit(lambda: _rearm_incoming_renewals_robust(kept_pk))
    logger.info(
        "account deletion cancelled by sign-in: user=%s", creator.pk,
        extra={"event": "account_deletion_cancelled", "user_id": creator.pk},
    )
    return creator, claims


def _reindex_published_pages_robust(creator_pk: int) -> None:
    """Deactivation dropped the account's search vectors; put them back.

    Runs after the keep commits. Primary keys only, streamed: a large
    account's page content is never loaded, and each page costs one small
    read and one job insert. A failure is logged, loudly, and changes
    nothing about the keep."""
    from .models import zPage
    from .signals import reindex_published_zpage

    try:
        pages = (zPage.objects.filter(creator_id=creator_pk, is_published=True)
                 .order_by("-updated_at", "-pk").only("pk"))
        done = 0
        for page in pages.iterator(chunk_size=500):
            if done >= KEEP_REINDEX_LIMIT:
                # Bounded so the keep answers promptly whatever the
                # inventory (it runs before the response is sent). The rest
                # is indexed when next saved; a durable batched reindex task
                # replaces this once registered (register first, ).
                logger.warning(
                    "account kept: reindexed only the %d most recent pages: user=%s",
                    KEEP_REINDEX_LIMIT, creator_pk,
                    extra={"event": "account_kept_reindex_truncated",
                           "user_id": creator_pk})
                break
            reindex_published_zpage(page)
            done += 1
    except Exception:
        logger.exception("account kept: page reindex failed: user=%s", creator_pk)


def _rearm_incoming_renewals(creator_pk: int) -> None:
    """Re-arm the renewal chains of the kept account's memberships, both
    ways: its members' (it is the creator) and its own (it is the fan).

    A renewal job that ran while the creator was inactive returned without
    scheduling another (``renew_subscription``: inactive creator, no next
    job), and the daily backstop skips inactive creators too; an inactive
    fan's retries stop at the last look before expiry. Without this a
    membership that came due during the grace period would lapse at expiry
    though its creator is active again. Same enqueue as a Subscription save
    (``defer_renewal`` with ``pull_forward``): one pending job per cycle, and
    the job re-checks everything under its row lock, so a duplicate charges
    nothing. Runs inside the keep's transaction (the web process's Django
    connector joins it): a failure rolls the keep back, unspent, and the
    holder tries again.
    """
    from .models import Subscription
    from .tasks import RENEWAL_LEAD, defer_renewal

    now = timezone.now()
    rows = Subscription.objects.filter(
        Q(star_id=creator_pk) | Q(fan_id=creator_pk),
        max_price__gt=0, expires__gt=now,
    ).values_list("pk", "expires")
    for sub_id, expires in rows:
        defer_renewal(sub_id, expires, schedule_at=expires - RENEWAL_LEAD,
                      pull_forward=True)


def _rearm_incoming_renewals_robust(creator_pk: int) -> None:
    try:
        _rearm_incoming_renewals(creator_pk)
    except Exception:
        logger.exception(
            "account kept: post-commit renewal re-check failed: user=%s "
            "(the renew_subs backstop repairs it)", creator_pk)


def _notify_cancelled(creator_pk: int) -> None:
    """Tell a confirmed address that a sign-in kept the account. Never
    required (most accounts have no email); a failure is logged, loudly,
    and changes nothing."""
    from django.core.mail import EmailMultiAlternatives

    from dj.apps.emails.models import Email, OptOutEmail
    from dj.apps.emails.sender import get_email_sender

    address = (
        Email.objects.filter(user_id=creator_pk, confirmed_at__isnull=False)
        .values_list("email", flat=True).first()
    )
    if not address or OptOutEmail.objects.filter(email=address).exists():
        return
    try:
        EmailMultiAlternatives(
            "Your Free2Z account deletion was cancelled",
            "Someone signed in to your Free2Z account and chose to keep it, "
            "so its scheduled deletion was cancelled.\n\n"
            "If that wasn't you, change your password and request deletion "
            "again at https://free2z.cash/account/delete.\n",
            get_email_sender(),
            [address],
        ).send()
    except Exception:
        logger.exception("account deletion cancel notice failed: user=%s", creator_pk)


# -- the purge ----------------------------------------------------------------


def purge_due_deletions(*, now=None, limit: int = 50) -> dict:
    """Purge accounts whose grace period has ended. Idempotent, bounded.

    Each account is re-checked under its row lock -- a sign-in may have kept
    it a moment ago (cancel and purge race; whichever takes the lock first
    wins, and the loser sees the other's result). A blocker (earnings owed,
    an app people use) leaves the account pending and paused: logged at
    ERROR with the ``account_deletion_purge_blocked`` event, which the
    monitoring log metric turns into a ticket-tier alert, at most once per
    account per BLOCKED_PURGE_ALERT_INTERVAL, and retried every run.
    """
    from django.db.models import Exists, OuterRef

    from .models import AccountDeletionEvent, Creator

    now = now or timezone.now()
    # Accounts blocked within the alert interval go to the back of the
    # queue: otherwise `limit` long-blocked accounts (earnings nobody has
    # settled yet) would fill every batch and starve every purge behind them.
    recently_blocked = AccountDeletionEvent.objects.filter(
        creator_id=OuterRef("pk"), kind="purge_blocked",
        at__gte=now - BLOCKED_PURGE_ALERT_INTERVAL,
    )
    # An attempt the process did not survive (out of memory, a job timeout)
    # leaves no blocked record, only this one, committed before it
    # started: it too goes behind every account not attempted lately.
    recently_attempted = AccountDeletionEvent.objects.filter(
        creator_id=OuterRef("pk"), kind="purge_attempt",
        at__gte=now - BLOCKED_PURGE_ALERT_INTERVAL,
    )
    due = list(
        Creator.objects.filter(
            is_active=False, deleted_at__isnull=True,
            deletion_requested_at__isnull=False, purge_after__lte=now,
        ).annotate(recently_blocked=Exists(recently_blocked),
                   recently_attempted=Exists(recently_attempted))
        .order_by("recently_blocked", "recently_attempted", "purge_after", "pk")
        .values_list("pk", flat=True)[:limit]
    )
    result = {"purged": 0, "blocked": 0, "skipped": 0, "failed": 0}
    for pk in due:
        # Committed on its own, BEFORE the attempt: if the process dies
        # mid-purge, the next run still knows to try the others first.
        # At most one marker per account per interval.
        with transaction.atomic():
            if not AccountDeletionEvent.objects.filter(
                creator_id=pk, kind="purge_attempt",
                at__gte=now - BLOCKED_PURGE_ALERT_INTERVAL,
            ).exists():
                AccountDeletionEvent.objects.create(
                    creator_id=pk, kind="purge_attempt", at=now)
        try:
            outcome = _purge_one(pk, now)
        except Exception:
            # One account's failure (a policy gap, a constraint) must not
            # stall every purge behind it: it is logged with its traceback,
            # alerted like a blocker (code `purge_failed`, for engineering),
            # sent to the back of the queue by that record, and retried.
            logger.exception("account deletion purge failed: user=%s", pk)
            outcome = "failed"
            _note_purge_blocked(pk, [PURGE_FAILED], now)
        result[outcome] += 1
    return result


#The blocker code a purge that raised is recorded and alerted with.
PURGE_FAILED = "purge_failed"


def _note_purge_blocked(pk, found, now) -> None:
    """Record and alert a blocked purge, at most once per account per
    BLOCKED_PURGE_ALERT_INTERVAL. The record also moves the account to the
    back of the next batch (``purge_due_deletions``)."""
    from dj.apps.jobs.logs import emit_json_line

    from .models import AccountDeletionEvent

    with transaction.atomic():
        recent = AccountDeletionEvent.objects.filter(
            creator_id=pk, kind="purge_blocked",
            at__gte=now - BLOCKED_PURGE_ALERT_INTERVAL,
        ).exists()
        if recent:
            return
        AccountDeletionEvent.objects.create(
            creator_id=pk, kind="purge_blocked", at=now, detail={"blockers": found})
    # The full severity+message envelope: the worker's JSON formatter keeps
    # only such a line top-level, which is where the alert's
    # `jsonPayload.event` filter looks.
    emit_json_line(
        logger, purge_blocked_payload(pk, found), "ERROR",
        "account deletion purge blocked: " + ",".join(found))


def _purge_one(pk, now) -> str:
    """Purge one due account under its row lock: ``"purged"``, ``"blocked"``
    or ``"skipped"`` (kept, or already purged, meanwhile)."""
    from .models import Creator

    with transaction.atomic():
        creator = Creator.objects.select_for_update().get(pk=pk)
        if (
            creator.is_active or creator.deleted_at is not None
            or creator.deletion_requested_at is None
            or creator.purge_after is None or creator.purge_after > now
        ):
            return "skipped"
        found = blockers(creator, now=now)
        if found:
            _note_purge_blocked(pk, found, now)
            return "blocked"
        _purge_locked(creator)
        _record_event(creator, "purged", at=now)
        return "purged"


def end_grace_now(username):
    """STAGE proof only (``purge_scheduled_deletions --end-grace-now``, which
    refuses outside the stage namespace): end one pending account's grace
    period now, so the next purge run purges it through the ordinary path.
    Never purges, never touches an account that is not pending. Returns the
    new ``purge_after``; raises ``ValueError`` for anything else."""
    from .models import Creator

    with transaction.atomic():
        creator = Creator.objects.select_for_update().filter(username=username).first()
        if creator is None or not creator.deletion_pending():
            raise ValueError(f"{username!r} is not an account whose deletion is pending")
        creator.purge_after = timezone.now() - timedelta(seconds=1)
        creator.save(update_fields=["purge_after", "updated_at"])
    logger.warning(
        "account deletion grace ended early by an operator (stage): user=%s",
        creator.pk,
        extra={"event": "account_deletion_grace_ended_early", "user_id": creator.pk},
    )
    return creator.purge_after


def keepable_account_for_username(username):
    """The account a password sign-in for ``username`` would reach, if it is
    one a sign-in may keep -- else ``None``. Checks NO password: the caller
    checks it exactly once (``check_password``) and, for this account, does
    not go on to ``authenticate()`` -- a second hash for pending accounts
    only would time-leak which usernames are pending deletion.
    ``ModelBackend`` refuses every inactive account, so this is the one
    narrow way a password reaches the keep step. Same lookup as the login
    serializer's (``username__iexact``)."""
    from .models import Creator

    if not username:
        return None
    user = Creator.objects.filter(username__iexact=username).first()
    if user is None or not keep_allowed(user):
        return None
    return user


def inactive_account_for_username(username):
    """Return an inactive, non-pending account addressed by username.

    Password routes use this only after the pending-deletion exception and
    verify the supplied password before returning the inactive-account error.
    This preserves the normal invalid-credentials response for bad passwords.
    """
    from .models import Creator

    if not username:
        return None
    user = Creator.objects.filter(username__iexact=username).first()
    if user is None or user.is_active or keep_allowed(user):
        return None
    return user


def deletion_pending_response(pending: "DeletionPending"):
    """409 with the keep token: the one answer every sign-in path gives an
    account in its grace period, instead of a credential. RETURNED, never
    raised: a raised error rolls the request back (``AtomicMiddleware``),
    and with it the TOTP code the sign-in just burned."""
    from rest_framework.response import Response

    response = Response(pending.payload(), status=409)
    response["Cache-Control"] = "no-store"
    return pending.bind(response)


#The page that asks "Keep my account?" with a keep token.
KEEP_PAGE = "/account/keep"


def keep_redirect(creator, *, methods, second_factor=None, next_path=None):
    """For redirect-based sign-ins (legacy X): ``None`` to carry on signing
    in, or a redirect to the keep page for an account in its grace period.

    The keep token rides in the URL *fragment*, which browsers never send to
    a server, so it reaches no access log, proxy or Referer.
    """
    from urllib.parse import urlencode

    from django.shortcuts import redirect

    try:
        login_gate(creator, methods=methods, second_factor=second_factor,
                   credential="session")
    except DeletionPending as exc:
        fragment = {"t": exc.keep_token, "d": exc.purge_after.isoformat()}
        if next_path:
            # Where the sign-in was headed (an SDK app's authorize step):
            # the keep page continues there. Already validated by the
            # caller; the page re-validates it as a same-site path.
            fragment["n"] = next_path
        return exc.bind(redirect(f"{KEEP_PAGE}#" + urlencode(fragment)))
    return None
