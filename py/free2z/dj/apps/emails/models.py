import uuid

from django.db import models
from django.utils import timezone
from django.contrib.auth import get_user_model

User = get_user_model()


class Email(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='email_address')
    email = models.EmailField(max_length=254, unique=True)
    # Indexed since: the confirm landing has always looked this up by
    # token alone, and the unsubscribe landing now does too, so a sequential
    # scan of every account's address on a link click is no longer acceptable.
    token = models.CharField(max_length=100, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField()
    confirmed_at = models.DateTimeField(null=True, blank=True)

    #The account epoch `token` was generated at.
    #
    #`token` is a full recovery credential in waiting: confirming it makes
    #the address the account's recovery principal, and a password reset then
    #mails a takeover link to whoever holds that mailbox. An attacker with a
    #stolen session POSTs their own address to `/api/emails/add` -- `Email`
    #is a OneToOne, so that REPLACES the row -- the owner changes their
    #password, everything  revokes dies, and the emailed link still
    #confirmed. A password change is precisely the moment an
    #attacker-planted pending credential has to die.
    #
    #Checked at USE time, in `ConfirmEmailView`, rather than rotated inside
    #`bump_account_epoch`: rotating there would fire on
    #`recovery_address_change`, which `AddEmailView` raises while holding
    #the freshly generated token in memory, and would silently mail a dead
    #link on the most-used email route on the platform.
    #
    #NOT consulted by the unsubscribe landing. This same column is the RFC
    #8058 one-click unsubscribe token for a CONFIRMED row, and links already
    #sitting in inboxes must keep working -- that is a compliance problem,
    #not a UX one.
    token_epoch = models.PositiveIntegerField(null=True, blank=True)
    is_public = models.BooleanField(default=False)
    get_notifications = models.BooleanField(default=False)

    def save(self, *args, **kwargs):
        """Never leave `token` without a `token_epoch`.

        `ConfirmEmailView` refuses a row whose stamp is not the account's
        current epoch, and NULL never compares equal -- so a row written by any
        path that does not stamp deliberately would carry a confirmation link
        that is dead on arrival. Failing closed is the right direction for the
        check; silently minting dead links is not an acceptable price for it.

        The value filled in here is the epoch as of *this write*, which is the
        correct default for any writer that is not itself an ownership event.
        `AddEmailView` overrides it -- it IS the ownership event on the
        recovery-address route, and the link it mails has to survive its own
        bump. Same shape as the Knox stamp in `dj.apps.ktauth.credentials`:
        a safe default from the model, a deliberate value from the issuer.

        Only ever fills a NULL. It does not "repair" a stamp that has gone
        stale, because a stale stamp is a revoked link and repairing one would
        be the hole reopening from inside the model layer.
        """
        if self.token_epoch is None and self.user_id is not None:
            from dj.apps.g12f.models import Creator

            self.token_epoch = (
                Creator.objects.filter(pk=self.user_id)
                .values_list('kt_account_epoch', flat=True)
                .first()
            )
            update_fields = kwargs.get('update_fields')
            if update_fields is not None:
                kwargs['update_fields'] = list(update_fields) + ['token_epoch']
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.user.username} - {self.email}"

    def is_confirmed(self):
        return self.confirmed_at is not None

    def is_expired(self):
        return timezone.now() > self.expires_at


class OptOutEmail(models.Model):
    email = models.EmailField(unique=True)
    opted_out_at = models.DateTimeField(auto_now_add=True)
    #The unsubscribe link token that was spent to create this row.
    #
    #Unsubscribing DELETES the `Email` row, so without this the token-only
    #link stops resolving the instant it is used -- and the endpoint has to
    #keep answering after that. The post-unsubscribe redirect lands back on
    #the same URL, and RFC 8058 mail providers replay the one-click POST,
    #which must stay a success rather than becoming a 404.
    #
    #It is a *spent* credential, not a live one: the `Email` row it came from
    #is gone, and re-adding the address mints a fresh random token, so this
    #value can never again authorise anything. Null for rows created before
    #this field existed, and for anything an admin adds by hand -- those
    #addresses simply have no link to resolve, which the legacy shape and the
    #already-opted-out short circuit both handle.
    link_token = models.CharField(
        max_length=100, null=True, blank=True, unique=True,
    )

    def __str__(self):
        return self.email


class PasswordResetToken(models.Model):
    email = models.ForeignKey(Email, on_delete=models.CASCADE)
    token = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    used = models.BooleanField(default=False)

    @property
    def is_expired(self):
        expiration_duration = 1
        return self.created_at < timezone.now() - timezone.timedelta(days=expiration_duration)
