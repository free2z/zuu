"""The one table: handle -> account, unique case-insensitively in the database."""

from django.conf import settings
from django.db import models
from django.db.models.functions import Lower

from .policy import HANDLE_DB_REGEX


class MessagingHandle(models.Model):
    """An E2EE messaging handle and the free2z account that owns it.

    Read ``dj/apps/handles/__init__.py`` for the policy. The short version: one
    handle per account, one account per handle, permanent once bound.
    """

    class Status(models.TextChoices):
        #: Owned by ``user``; ``ktauth`` will vouch for it.
        BOUND = "bound", "Bound"
        #: The account is gone. The handle stays reserved forever so it is
        #: never re-issued to somebody else (the log already published a key
        #: for it). ``user`` is NULL.
        RETIRED = "retired", "Retired"

    class Source(models.TextChoices):
        #: Reserved from the account's own lowercased username.
        USERNAME = "username", "Reserved from username"
        #: Chosen by the account through the claim flow.
        CLAIMED = "claimed", "Claimed"

    handle = models.CharField(
        max_length=30,
        editable=False,
        help_text="^[a-z0-9_]{1,30}$, ASCII. Permanent once bound.",
    )
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        # SET_NULL, not CASCADE: deleting an account must not free its handle
        # for somebody else. `signals.retire_handle` flips the status first.
        on_delete=models.SET_NULL,
        null=True,
        related_name="messaging_handle",
        editable=False,
    )
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.BOUND,
    )
    source = models.CharField(
        max_length=16,
        choices=Source.choices,
        editable=False,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "messaging handle"
        constraints = [
            # Handles are stored lowercase (the check below), so this is
            # equivalent to a plain unique today. It is written with Lower()
            # anyway so the invariant the directory depends on does not rest
            # on a second constraint staying in place.
            models.UniqueConstraint(
                Lower("handle"),
                name="messaging_handle_ci_unique",
                violation_error_message="This messaging handle is taken.",
            ),
            models.CheckConstraint(
                condition=models.Q(handle__regex=HANDLE_DB_REGEX),
                name="messaging_handle_charset",
                violation_error_message=(
                    "A messaging handle is 1-30 characters of a-z, 0-9 and _."
                ),
            ),
            # A bound handle has an owner. (A retired one may still have one
            # for the instant between the status flip and SET_NULL.)
            models.CheckConstraint(
                condition=(
                    ~models.Q(status="bound") | models.Q(user__isnull=False)
                ),
                name="messaging_handle_bound_has_user",
            ),
        ]

    def __str__(self):
        return f"@{self.handle} ({self.status})"
