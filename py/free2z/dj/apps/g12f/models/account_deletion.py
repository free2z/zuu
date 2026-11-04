"""The audit trail of self-service account deletion (``account_deletion``)."""
from django.conf import settings
from django.db import models
from django.utils import timezone


class AccountDeletionEvent(models.Model):
    """One step of an account's deletion: requested, kept by a sign-in,
    banned meanwhile (no keep), purge blocked (support must settle
    something), purged.

    Kept for the life of the (pseudonymized) account row: it is what lets an
    unwanted cancel, or a purge that never ran, be seen and explained.
    Holds no personal data -- timestamps and blocker codes only.
    """

    class Kind(models.TextChoices):
        SCHEDULED = "scheduled", "Deletion requested"
        CANCELLED = "cancelled", "Kept by a sign-in"
        PURGE_BLOCKED = "purge_blocked", "Purge blocked"
        PURGED = "purged", "Purged"
        BANNED = "banned", "Banned while pending (cannot be kept)"
        PURGE_ATTEMPT = "purge_attempt", "Purge attempted"

    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="account_deletion_events",
    )
    kind = models.CharField(max_length=16, choices=Kind.choices)
    at = models.DateTimeField(default=timezone.now, db_index=True)
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        indexes = [models.Index(fields=["creator", "kind", "at"],
                                name="g12f_acctdel_event_lookup")]
