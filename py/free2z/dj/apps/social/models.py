from django.db import models
from django.conf import settings


PROVIDER_CHOICES = (
    ("x", "X (Twitter)"),
    ("google", "Google"),
    ("github", "GitHub"),
)


class SocialIdentity(models.Model):
    """
    Links a Creator (the auth user) to a social account they proved
    ownership of via an OAuth2 authorization-code + PKCE flow.

    ``provider_uid`` is the provider's STABLE identifier for the account
    (X numeric id / Google ``sub`` / GitHub numeric id) -- never the
    handle, which can change. A Creator may link one identity per
    provider (and several across providers); each ``(provider,
    provider_uid)`` belongs to exactly one Creator.
    """
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="social_identities",
    )
    provider = models.CharField(max_length=16, choices=PROVIDER_CHOICES)
    # Stable provider id (X numeric id / Google sub / GitHub id).
    provider_uid = models.CharField(max_length=191, db_index=True)
    # Human-facing handle (may change over time; display only).
    handle = models.CharField(max_length=255, blank=True)
    avatar_url = models.URLField(blank=True, max_length=1024)
    verified_at = models.DateTimeField(auto_now_add=True)

    #The account epoch this identity was linked at.
    #
    #A planted identity is the one credential family an ownership event used
    #to leave alive: an attacker with a stolen session links their own
    #provider account, the owner changes their password, every token and
    #session dies -- and the attacker signs straight back in through the
    #identity they linked.  excluded identities as "the owner's own
    #login methods", which is right for one the owner linked and wrong for
    #one an attacker planted, and the row cannot tell them apart.
    #
    #So the row records WHEN, in ownership-event terms, and the login route
    #compares it against the account's current counter -- see
    #`dj.apps.ktauth.credentials.identity_can_authenticate` for the rule,
    #the passwordless-account exemption, and why this is a use-time check
    #rather than a deletion at revoke time.
    #
    #Backfilled to each account's current epoch, so no existing identity is
    #invalidated by the migration itself.
    linked_at_epoch = models.PositiveIntegerField(
        default=1,
        # `db_default` as well as `default`, and it is a DEPLOY-SAFETY
        # requirement rather than a duplicate (codex adversarial review).
        # `manage.py migrate` is a Cloud Build step that runs BEFORE the new
        # pods roll, and Django's AddField adds the column with a temporary
        # default and then DROPS it -- so for the length of the rollout the
        # still-running old pods, whose model has no such field, would INSERT
        # without it and take a NOT NULL violation on every new link. A row
        # written that way lands at the initial epoch, which is correct for
        # the overwhelming majority of accounts and fails CLOSED (a refused
        # login, "reconnect it") rather than open for the rest.
        db_default=1,
        editable=False,
        help_text=(
            "Creator.kt_account_epoch when this identity was linked. A login "
            "through it is refused once the account has moved past it."
        ),
    )
    #The account epoch at which this identity was refused as the stale
    #passwordless fallback.  This is durable provenance: removing the row
    #that won fallback selection must not rehabilitate a row that already
    #failed that ownership check.
    fallback_rejected_at_epoch = models.PositiveIntegerField(
        null=True,
        blank=True,
        editable=False,
        help_text=(
            "Account epoch at which this identity was rejected as a "
            "passwordless fallback. Explicit re-linking clears it."
        ),
    )

    class Meta:
        verbose_name = "Social Identity"
        verbose_name_plural = "Social Identities"
        unique_together = ("provider", "provider_uid")

    def __str__(self) -> str:
        return f"{self.creator} <- {self.provider}:{self.provider_uid}"


class SocialState(models.Model):
    """
    Fallback single-use / TTL store for PKCE material plus the bound
    ``redirect_uri`` and provider, keyed by OAuth ``state``.

    The primary store is the Django cache; this DB row is used only when
    the configured cache is the per-process local-memory/dummy backend
    (not shared across gunicorn workers), so a ``state`` minted by one
    worker is still redeemable by the next. Mirrors ``zauth`` exactly.
    """
    state = models.CharField(max_length=128, unique=True, db_index=True)
    # JSON payload is either a direct verifier binding, a mobile provider-state
    # relay binding, or a code-bound mobile completion state. Ten-minute TTL.
    payload = models.TextField()
    expires = models.DateTimeField()

    class Meta:
        verbose_name = "Social OAuth State"
        verbose_name_plural = "Social OAuth States"

    def __str__(self) -> str:
        return f"state {self.state}"
