from django.contrib import admin

from .models import (
    TuziGrant, ZecCreditReceipt, ZecMemoDisposition, ZecPendingNotice,
)


@admin.register(ZecCreditReceipt)
class ZecCreditReceiptAdmin(admin.ModelAdmin):
    """Read-only view of the ZEC purchase receipts.

    Deliberately not editable. This table is the idempotency marker for
    issuing 2Z platform credits: deleting a row re-credits that purchase on
    the next cycle, and editing `txid`/`output_index` does the same. The
    supported way to inspect it is here; the supported way to reconcile it is
    `manage.py audit_zec_credits`.
    """

    list_display = [
        'txid', 'output_index', 'creator', 'amount_zec', 'tuzis_credited',
        'backfilled', 'instant', 'confirmations_at_credit', 'vanished_at',
        'vanish_resolved_at', 'created_at',
    ]
    # `instant` and `vanished_at` are here because a KYC reviewer deciding
    # whether to pay a revenue share is looking at a 2Z balance with no
    # provenance attached to it. A balance that includes credits taken on
    # trust -- and especially one that includes an UNBACKED credit -- is a
    # different thing to be looking at, and this is the only place the two
    # are visible side by side today.
    list_filter = ['backfilled', 'instant']
    search_fields = ['txid']
    date_hierarchy = 'created_at'

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(ZecPendingNotice)
class ZecPendingNoticeAdmin(admin.ModelAdmin):
    """Read-only view of "we told the buyer we can see their payment".

    Not editable for the same reason the receipts are not: this table is the
    idempotency marker for the notification, so deleting a row makes the
    buyer be told a second time about a payment they have long since been
    credited for.
    """

    list_display = [
        'txid', 'output_index', 'pool', 'creator', 'amount_zec',
        'confirmations', 'created_at',
    ]
    search_fields = ['txid']
    date_hierarchy = 'created_at'

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(ZecMemoDisposition)
class ZecMemoDispositionAdmin(admin.ModelAdmin):
    """Read-only audit view of retired unreadable purchase memos.

    The supported write path is ``manage.py dispose_zec_memo``. Editing or
    deleting a row would make a historical decision disappear and would make
    the credit loop report the same note again, so the admin is intentionally
    an inspection surface only.
    """

    list_display = [
        'txid', 'pool', 'output_index', 'amount_zec', 'classification',
        'decision', 'operator', 'created_at', 'disposed_at',
    ]
    list_filter = ['classification', 'decision']
    search_fields = ['txid', 'pool', 'memo_target', 'operator', 'reason']
    readonly_fields = [
        'created_at', 'txid', 'pool', 'output_index', 'amount_zec',
        'classification', 'memo_action', 'memo_target', 'decision',
        'operator', 'reason', 'disposed_at',
    ]
    date_hierarchy = 'created_at'

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(TuziGrant)
class TuziGrantAdmin(admin.ModelAdmin):
    """Read-only audit view of operator-issued 2Z grants.

    The only supported write path is ``manage.py grant_tuzis``, which writes
    this row in the same transaction as the ledger credit. Editing or deleting
    a row here would make a balance change lose its provenance.
    """

    list_display = [
        'created_at', 'username', 'amount', 'balance_after', 'operator',
        'environment', 'reason',
    ]
    search_fields = ['username', 'operator', 'reason', 'idempotency_key']
    readonly_fields = [
        'created_at', 'creator', 'username', 'amount', 'balance_after',
        'reason', 'operator', 'environment', 'idempotency_key',
    ]
    date_hierarchy = 'created_at'

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
