"""A deleted client remains a frozen ledger tombstone for old JWTs/holds."""
from django.db import connection
from django.db.models.signals import pre_delete
from django.dispatch import receiver

from . import ledger_projection
from .models import F2ZApplication


@receiver(pre_delete, sender=F2ZApplication, dispatch_uid='oidc.freeze_deleted_ledger_app')
def freeze_deleted_app(sender, instance, using, **kwargs):
    # The deletion transaction also removes tokens/grants. Keep the ledger
    # projection for receipts and already-consumed usage, but close admission
    # immediately even while a gateway still has a cryptographically valid JWT.
    #
    # An upsert, not an UPDATE: an app that never had a ledger_app row (one
    # registered before L2) can gain one from a grant write that is holding
    # the grant row this deletion is about to wait on (sync_grant's
    # self-heal). An UPDATE of zero rows would let that insert land unfrozen
    # after us; inserting the frozen tombstone first makes the grant write
    # wait on it instead (or deadlock, and Postgres aborts one), so the
    # survivor is frozen either way.
    if using != 'default' or not ledger_projection._table_exists(ledger_projection.LEDGER_APP_TABLE):
        return
    with connection.cursor() as cursor:
        cursor.execute(
            ledger_projection._APP_INSERT
            + ' ON CONFLICT (id) DO UPDATE SET frozen=true, updated_at=now()',
            ledger_projection._app_params(instance, frozen=True),
        )
