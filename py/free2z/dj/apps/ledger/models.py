"""ORM view of the ledger tables (docs/tuzis/ledger-v2.md §2.2, §3.1, §3.2, §3.8, §5.8).

Django OWNS ``ledger_account``, ``ledger_transfer_key``, ``ledger_config``,
``ledger_reconcile_run`` and ``ledger_purchase_refund`` (managed models; the
CHECKs are ``CheckConstraint``s so ``makemigrations --check`` stays clean).

``ledger_transfer`` is a monthly-partitioned table, which Django cannot
declare, so its model is ``managed = False`` and the real DDL is ``RunSQL``
in ``0001_initial`` (``SeparateDatabaseAndState``). Its primary key is
``(id, created_at)`` in the database; the ORM's ``id`` here is only a read
handle. Nothing may ``REFERENCES`` it and nothing may write to it through the
ORM: every row is inserted by ``ledger.post_transfer`` (or the step-3 heal),
inside the database.

Amounts are ``bigint`` milli-2Z (``1 2Z = 1000 m2Z``); see :mod:`.api`.
"""
from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.db.models import Q
from django.db.models.functions import Now

from .system_accounts import (
    ACCOUNT_KINDS, PURCHASE_RAILS, TRANSFER_CODES, USER_KINDS,
)


class Account(models.Model):
    """One row per account. ``user`` / ``user_debt`` are *maintained* (their
    ``balance`` is updated inside ``post_transfer``); every ``sys:*`` account
    is *journal-only* (never updated on the hot path; ``balance`` is
    informational, recomputed by reconciliation)."""

    key = models.TextField(unique=True)
    kind = models.TextField()
    # The design's `owner_id bigint NULL REFERENCES g12f_creator (id) ON DELETE
    # RESTRICT`. Django emits the FK without an ON DELETE clause (NO ACTION,
    # deferred), which refuses the delete at commit exactly as RESTRICT would;
    # PROTECT is the ORM-side equivalent. The string label keeps this app free
    # of imports from dj.apps.g12f (tests/test_app_shape.py).
    owner = models.ForeignKey(
        "g12f.Creator",
        on_delete=models.PROTECT,
        null=True,
        db_column="owner_id",
        db_index=False,   # the partial index below is the only one wanted
        related_name="+",
    )
    journal_only = models.BooleanField()
    balance = models.BigIntegerField(db_default=0)
    held = models.BigIntegerField(db_default=0)
    frozen = models.BooleanField(db_default=False)
    frozen_reason = models.TextField(db_default="")
    created_at = models.DateTimeField(db_default=Now())
    updated_at = models.DateTimeField(db_default=Now())

    class Meta:
        db_table = "ledger_account"
        constraints = [
            models.CheckConstraint(
                condition=Q(kind__in=ACCOUNT_KINDS),
                name="ledger_account_kind_chk",
            ),
            models.CheckConstraint(
                condition=Q(held__gte=0),
                name="ledger_account_held_nonneg_chk",
            ),
            # (kind IN ('user','user_debt')) = (owner_id IS NOT NULL)
            models.CheckConstraint(
                condition=(
                    Q(kind__in=USER_KINDS, owner__isnull=False)
                    | (~Q(kind__in=USER_KINDS) & Q(owner__isnull=True))
                ),
                name="ledger_account_owner_by_kind_chk",
            ),
            # journal_only = (kind NOT IN ('user','user_debt'))
            models.CheckConstraint(
                condition=(
                    (Q(journal_only=True) & ~Q(kind__in=USER_KINDS))
                    | Q(journal_only=False, kind__in=USER_KINDS)
                ),
                name="ledger_account_journal_by_kind_chk",
            ),
            models.CheckConstraint(
                condition=~Q(kind="user_debt") | Q(balance__lte=0),
                name="ledger_account_debt_nonpos_chk",
            ),
            # NOT in L1: ledger_account_user_available_chk (balance - held >= 0
            # for user accounts) is added in L4, after the rollout self-heal is
            # retired (design §2.2, §10 step 7).
            models.UniqueConstraint(
                fields=["kind", "owner"],
                condition=Q(owner__isnull=False),
                name="ledger_account_kind_owner_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["owner"],
                condition=Q(owner__isnull=False),
                name="ledger_account_owner_idx",
            ),
        ]

    def __str__(self):
        return self.key


class Transfer(models.Model):
    """Read model for the journal. Partitioned monthly by ``created_at``;
    the database primary key is ``(id, created_at)``. Read-only for the ORM."""

    id = models.BigAutoField(primary_key=True)
    created_at = models.DateTimeField()
    debit_account_id = models.BigIntegerField()
    credit_account_id = models.BigIntegerField()
    amount = models.BigIntegerField()
    code = models.TextField()
    ref_kind = models.TextField(db_default="")
    ref_id = models.TextField(db_default="")
    meta = models.JSONField(null=True)

    class Meta:
        managed = False
        db_table = "ledger_transfer"

    def __str__(self):
        return f"{self.code} {self.amount} m2Z #{self.id}"


class TransferKey(models.Model):
    """Explicit idempotency for keyed transfers and compound operations
    (§3.2, §4.3). Rows are never deleted except when a refusal returns the
    claim; ``transfer_id`` is NULL while the claiming transaction is in
    flight; ``detail`` records a compound operation's split for its replay."""

    idem = models.TextField(primary_key=True)
    transfer_id = models.BigIntegerField(null=True)
    detail = models.JSONField(null=True)
    created_at = models.DateTimeField(db_default=Now())

    class Meta:
        db_table = "ledger_transfer_key"

    def __str__(self):
        return self.idem


class Config(models.Model):
    """The one-row ledger configuration (§4.4, §10). ``dual_write`` projects
    every maintained ``user`` balance change onto ``Creator.tuzis`` inside
    ``post_transfer``; ``heal_enabled`` gates the step-3 rollout self-heal;
    ``dual_write_since`` is stamped by the dual-write release's first write
    and baselines the per-rail reconciliation (R11)."""

    # A boolean primary key that must be TRUE: there can only be one row.
    id = models.BooleanField(primary_key=True, default=True)
    dual_write = models.BooleanField(db_default=True)
    heal_enabled = models.BooleanField(db_default=True)
    writer_boundary = models.BooleanField(db_default=False)
    dual_write_since = models.DateTimeField(null=True)

    class Meta:
        db_table = "ledger_config"
        constraints = [
            models.CheckConstraint(
                condition=Q(id=True), name="ledger_config_singleton_chk",
            ),
        ]

    def __str__(self):
        return f"dual_write={self.dual_write} heal_enabled={self.heal_enabled}"


class ReconcileRun(models.Model):
    """One row per invariant per reconciliation run (§3.8, §11); what the
    drift alert reads. Created in L1 because ``reconcile_ledger`` ships with
    the dual-write release, before L2 exists."""

    started_at = models.DateTimeField(db_default=Now())
    finished_at = models.DateTimeField(null=True)
    scope = models.TextField()
    invariant = models.TextField()
    accounts_checked = models.BigIntegerField(db_default=0)
    drift_count = models.BigIntegerField(db_default=0)
    drift_m2z = models.BigIntegerField(db_default=0)
    detail = models.JSONField(null=True)

    class Meta:
        db_table = "ledger_reconcile_run"

    def __str__(self):
        return f"{self.scope}/{self.invariant} drift={self.drift_count}"


class PurchaseRefund(models.Model):
    """The per-purchase refund cursor (§5.8): one row per purchase receipt,
    written by ``credit_purchase``; ``refunded_m2z`` only moves forward on a
    refund or dispute (``refund_purchase``) and only ``restore_purchase``
    lowers it. Step 4's backfill creates one per historical receipt."""

    ref_kind = models.TextField()
    ref_id = models.TextField()
    rail = models.TextField()
    account = models.ForeignKey(
        Account, on_delete=models.PROTECT, db_column="account_id",
        related_name="+",
    )
    credited_m2z = models.BigIntegerField()
    refunded_m2z = models.BigIntegerField(db_default=0)
    created_at = models.DateTimeField(db_default=Now())
    updated_at = models.DateTimeField(db_default=Now())

    class Meta:
        db_table = "ledger_purchase_refund"
        constraints = [
            models.UniqueConstraint(
                fields=["ref_kind", "ref_id"],
                name="ledger_purchase_refund_ref_uniq",
            ),
            models.CheckConstraint(
                condition=Q(rail__in=PURCHASE_RAILS),
                name="ledger_purchase_refund_rail_chk",
            ),
            models.CheckConstraint(
                condition=Q(credited_m2z__gt=0),
                name="ledger_purchase_refund_credited_chk",
            ),
            models.CheckConstraint(
                condition=Q(refunded_m2z__gte=0) & Q(refunded_m2z__lte=models.F("credited_m2z")),
                name="ledger_purchase_refund_cursor_chk",
            ),
        ]

    def __str__(self):
        return f"{self.ref_kind}:{self.ref_id} {self.refunded_m2z}/{self.credited_m2z}"


# Re-exported so a reader of this module sees the vocabulary next to the
# tables it constrains.
__all__ = [
    "Account", "Transfer", "TransferKey", "Config", "ReconcileRun",
    "PurchaseRefund", "ACCOUNT_KINDS", "TRANSFER_CODES", "PURCHASE_RAILS",
]


# L2 SQL owns constraints, defaults and writes. Managed ORM state lets Django
# include every referencing table in flushes; callers use ledger functions.

class LedgerHold(models.Model):
    cap_window_revision = models.BigIntegerField(db_default=0)
    id = models.UUIDField(primary_key=True)
    account = models.ForeignKey('Account', models.PROTECT)
    app_id = models.UUIDField()
    idem = models.TextField()
    amount = models.BigIntegerField()
    logical_key = models.TextField()
    attempt = models.IntegerField()
    dev_markup_bps = models.IntegerField()
    rate_card_id = models.BigIntegerField(blank=True, null=True)
    model_id = models.TextField(blank=True, null=True)
    min_charge_2z = models.IntegerField(blank=True, null=True)
    catalog_version = models.TextField(blank=True, null=True)
    window_start = models.DateTimeField(blank=True, null=True)
    created_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    meta = models.JSONField()

    class Meta:
        db_table = 'ledger_hold'
        unique_together = (('app_id', 'account', 'idem'),)


class LedgerApp(models.Model):
    id = models.UUIDField(primary_key=True)
    developer_creator = models.ForeignKey('g12f.Creator', models.PROTECT, blank=True, null=True)
    frozen = models.BooleanField()
    markup_bps = models.IntegerField()
    approved_markup_bps = models.IntegerField(blank=True, null=True)
    rails = ArrayField(models.TextField())
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'ledger_app'


class LedgerSpendCap(models.Model):
    cap_window_revision = models.BigIntegerField(db_default=0)
    pk = models.CompositePrimaryKey('app_id', 'account_id')
    app_id = models.UUIDField()
    account = models.ForeignKey('Account', models.PROTECT)
    cap_m2z = models.BigIntegerField(blank=True, null=True)
    period = models.TextField()
    markup_bps = models.IntegerField()
    grant_generation = models.IntegerField()
    revoked_at = models.DateTimeField(blank=True, null=True)
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'ledger_spend_cap'


class LedgerSpendWindow(models.Model):
    pk = models.CompositePrimaryKey('app_id', 'account_id', 'window_start')
    app_id = models.UUIDField()
    account_id = models.BigIntegerField()
    window_start = models.DateTimeField()
    spent_m2z = models.BigIntegerField()
    held_m2z = models.BigIntegerField()

    class Meta:
        db_table = 'ledger_spend_window'


class LedgerRollupState(models.Model):
    name = models.TextField(primary_key=True)
    last_run_at = models.DateTimeField(blank=True, null=True)
    rows_consumed = models.BigIntegerField()

    class Meta:
        db_table = 'ledger_rollup_state'


class LedgerDevMarkupPending(models.Model):
    developer_creator = models.OneToOneField('g12f.Creator', models.PROTECT, primary_key=True)
    amount_m2z = models.BigIntegerField()
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'ledger_dev_markup_pending'


class LedgerAiSplitQueue(models.Model):
    usage_id = models.BigIntegerField(primary_key=True)
    developer_creator_id = models.BigIntegerField(blank=True, null=True)
    provider_m2z = models.BigIntegerField()
    developer_m2z = models.BigIntegerField()
    platform_m2z = models.BigIntegerField()
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'ledger_ai_split_queue'


class LedgerGatewayCall(models.Model):
    """Private, non-content call metadata; money lives in L2 usage/journal."""
    id = models.UUIDField(primary_key=True)
    account = models.ForeignKey(Account, models.PROTECT)
    app_id = models.UUIDField()
    account_epoch = models.IntegerField()
    grant_generation = models.IntegerField()
    fingerprint = models.CharField(max_length=64)
    phase = models.CharField(max_length=16)
    request_meta = models.JSONField()
    completion_meta = models.JSONField(null=True)
    completion_no_hold = models.BooleanField(null=True)
    created_at = models.DateTimeField(db_default=Now())
    expires_at = models.DateTimeField()
    completed_at = models.DateTimeField(null=True)

    class Meta:
        db_table = 'ledger_gateway_call'
        indexes = [models.Index(fields=['created_at'], name='ledger_gateway_call_retention'),
                   models.Index(fields=['expires_at'], name='ledger_gateway_call_expiry',
                                condition=Q(phase__in=['streaming', 'settling']))]
        constraints = [models.CheckConstraint(condition=Q(phase__in=['streaming', 'settling', 'released']), name='ledger_gateway_call_phase')]


class LedgerGatewayIdempotency(models.Model):
    pk = models.CompositePrimaryKey('account_id', 'app_id', 'key')
    account = models.ForeignKey(Account, models.PROTECT)
    app_id = models.UUIDField()
    key = models.CharField(max_length=128)
    call = models.ForeignKey('LedgerGatewayCall', models.CASCADE)
    expires_at = models.DateTimeField()

    class Meta:
        db_table = 'ledger_gateway_idempotency'


class LedgerGatewayAttempt(models.Model):
    hold_id = models.UUIDField(primary_key=True)
    call = models.ForeignKey('LedgerGatewayCall', models.CASCADE)
    snapshot = models.JSONField()

    class Meta:
        db_table = 'ledger_gateway_attempt'
