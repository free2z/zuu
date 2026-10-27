from django.db import models
from django.conf import settings


class ZcashIdentity(models.Model):
    """
    Links a Creator (the auth user) to a verified Zcash transparent
    P2PKH t-address that they proved ownership of by signing a
    server-issued challenge ("ZUULI Zcash Login v2").

    One Creator has at most one primary Zcash identity, and each
    t-address is owned by exactly one Creator.
    """
    creator = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='zcash_identity',
    )
    # Transparent mainnet P2PKH address (base58check, version 0x1CB8 -> "t1...").
    zcash_address = models.CharField(
        max_length=128,
        unique=True,
        db_index=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)

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
    #Durable record that this identity already lost passwordless fallback
    #selection.  It is cleared only by an explicit authenticated re-link.
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
        verbose_name = "Zcash Identity"
        verbose_name_plural = "Zcash Identities"

    def __str__(self) -> str:
        return f"{self.creator} <- {self.zcash_address}"

    @property
    def did(self) -> str:
        return f"did:zcash:{self.zcash_address}"


class ZcashChallengeClaim(models.Model):
    """Durable uniqueness-backed replay claim for a verified challenge."""

    challenge_digest = models.CharField(max_length=64, unique=True)
    expires = models.DateTimeField(db_index=True)
    claimed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Zcash Challenge Claim"
        verbose_name_plural = "Zcash Challenge Claims"

    def __str__(self) -> str:
        return f"claimed Zcash challenge {self.challenge_digest[:16]}"
